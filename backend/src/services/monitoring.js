/**
 * monitoring.js — Proactive metric monitoring engine for Sarah.
 * Phase 1: trailing_weekday baseline, pct_change threshold, daily cron.
 *
 * Principles (non-negotiable):
 *   - Detection is CODE, not LLM. Baselines and thresholds are deterministic.
 *   - No persistent product data. Metric windows fetched fresh, held in-memory, discarded.
 *   - Per-workspace isolation. Every function scoped to one workspace's credentials.
 *   - LLM (composeAlert) only formats values already in the anomaly object — never computes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { WebClient } from '@slack/web-api';
import { executeMixpanelTool } from './mixpanel.js';
import { decrypt } from './encryption.js';
import { getAllActiveMonitors, recordFire, wasFiredWithin, getDailyFireCount } from './monitoringDb.js';
import { getWorkspace } from './db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function dateWeekday(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getDay(); // 0=Sun
}

// ---------------------------------------------------------------------------
// Step 1 — fetchMetricWindow
// Returns [{date, value}] for the last 28 calendar days (in-memory only).
// One Mixpanel API call. Nothing persisted.
// ---------------------------------------------------------------------------

async function fetchMetricWindow(monitor, workspace) {
  const { metric } = monitor;
  const creds = {
    projectId: decrypt(workspace.mixpanel_project_id),
    username:  decrypt(workspace.mixpanel_username),
    secret:    decrypt(workspace.mixpanel_secret),
  };

  const fromDate = daysAgo(28);
  const toDate   = daysAgo(1); // yesterday = last complete day

  let raw;

  if (metric.measure === 'count' && metric.event) {
    // Daily unique-user count for a single event
    raw = await executeMixpanelTool('mixpanel_segmentation', {
      event:     metric.event,
      from_date: fromDate,
      to_date:   toDate,
      unit:      'day',
      type:      'unique',
    }, creds);

    const values = raw?.data?.values?.[metric.event];
    if (!values) return [];
    return Object.entries(values)
      .map(([date, v]) => ({ date, value: Number(v) || 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  if (metric.measure === 'funnel_step1_count' && metric.funnel_steps?.length >= 1) {
    // Daily unique users who started the funnel (step 1)
    const step1 = metric.funnel_steps[0];
    raw = await executeMixpanelTool('mixpanel_segmentation', {
      event:     step1,
      from_date: fromDate,
      to_date:   toDate,
      unit:      'day',
      type:      'unique',
    }, creds);

    const values = raw?.data?.values?.[step1];
    if (!values) return [];
    return Object.entries(values)
      .map(([date, v]) => ({ date, value: Number(v) || 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  throw new Error(`Unsupported metric.measure: "${metric.measure}". Supported: count, funnel_step1_count`);
}

// ---------------------------------------------------------------------------
// Step 2 — computeTrailingWeekdayBaseline
// Pure function. Returns {mean, std, n, points} or null.
// Requires ≥3 same-weekday data points with value ≥ minN each.
// In-memory only — result discarded after detection.
// ---------------------------------------------------------------------------

export function computeTrailingWeekdayBaseline(dailyValues, targetDate, window = 4, minN = 100) {
  const targetWeekday = dateWeekday(targetDate);

  const sameWeekday = dailyValues
    .filter(p => p.date < targetDate && dateWeekday(p.date) === targetWeekday)
    .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    .slice(0, window);

  // Require at least 3 points AND each must meet the minimum volume threshold
  const valid = sameWeekday.filter(p => p.value >= minN);
  if (valid.length < 3) return null;

  const vals = valid.map(p => p.value);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
  const std = Math.sqrt(variance);

  return { mean, std, n: valid.length, points: valid };
}

// ---------------------------------------------------------------------------
// Step 3 — detectAnomaly
// Pure function. Returns anomaly object or null.
// ---------------------------------------------------------------------------

export function detectAnomaly(monitor, observed, baseline, observedDate) {
  if (!baseline || baseline.mean === 0) return null;

  const { threshold, metric_label, workspace_id, monitor_id, metric } = monitor;
  const { mean, std } = baseline;

  const deltaPct = (observed - mean) / mean;
  const deltaAbs = observed - mean;
  const zScore   = std > 0 ? (observed - mean) / std : null;

  // Threshold check
  const { type = 'pct_change', direction = 'both', value: tv } = threshold;

  if (type === 'pct_change') {
    const exceeded =
      (direction === 'drop'  && deltaPct < -tv) ||
      (direction === 'spike' && deltaPct >  tv) ||
      (direction === 'both'  && Math.abs(deltaPct) > tv);
    if (!exceeded) return null;
  }

  // Severity: based on how far observed is from baseline
  const abs = Math.abs(deltaPct);
  const severity = abs >= 0.30 ? 'high' : abs >= 0.15 ? 'medium' : 'low';

  const dirLabel = deltaPct < 0 ? 'drop' : 'spike';

  return {
    monitor_id,
    workspace_id,
    fired_at:     new Date().toISOString(),
    metric_label: metric_label || metric.event || metric.measure,
    observed:     Math.round(observed),
    baseline:     Math.round(mean),
    baseline_std: std > 0 ? Math.round(std) : null,
    delta_abs:    Math.round(deltaAbs),
    delta_pct:    parseFloat(deltaPct.toFixed(4)),
    z_score:      zScore !== null ? parseFloat(zScore.toFixed(2)) : null,
    severity,
    window:       { from: observedDate, to: observedDate },
    source:       `Mixpanel: ${metric_label || metric.event || 'metric'}, ${observedDate}`,
    dedup_key:    `${monitor_id}:${observedDate}:${dirLabel}`,
    enrichment:   null, // Phase 3
  };
}

// ---------------------------------------------------------------------------
// Step 4 — shouldFire (Phase 1: dedup + mute + daily cap)
// Returns {fire: bool, reason: string}
// ---------------------------------------------------------------------------

async function shouldFire(anomaly, monitor) {
  const { workspace_id, dedup_key, severity } = anomaly;

  // Severity floor per workspace (Phase 1: always fire medium+ severity)
  const severityFloor = monitor.threshold?.severity_floor || 'low';
  const sevOrder = { low: 0, medium: 1, high: 2 };
  if ((sevOrder[severity] ?? 0) < (sevOrder[severityFloor] ?? 0)) {
    return { fire: false, reason: `severity=${severity} below floor=${severityFloor}` };
  }

  // Dedup: not fired within cooldown window
  const cooldownHours = monitor.cooldown_hours ?? 24;
  const alreadyFired = await wasFiredWithin(workspace_id, dedup_key, cooldownHours);
  if (alreadyFired) {
    return { fire: false, reason: `dedup: already fired within ${cooldownHours}h` };
  }

  // Daily cap: not exceeded
  const dailyCap = monitor.daily_cap ?? 3;
  const todayCount = await getDailyFireCount(workspace_id);
  if (todayCount >= dailyCap) {
    return { fire: false, reason: `daily cap reached (${todayCount}/${dailyCap})` };
  }

  // Quiet hours (Phase 1: simple UTC check — full tz awareness in Phase 2)
  if (monitor.quiet_hours) {
    const nowUTCHour = new Date().getUTCHours();
    const { from, to } = monitor.quiet_hours; // "HH:MM"
    const fromH = parseInt(from);
    const toH   = parseInt(to);
    const inQuiet = fromH > toH
      ? (nowUTCHour >= fromH || nowUTCHour < toH)   // overnight: 20:00–08:00
      : (nowUTCHour >= fromH && nowUTCHour < toH);  // daytime
    if (inQuiet) {
      return { fire: false, reason: `quiet hours (${from}–${to} UTC)` };
    }
  }

  return { fire: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Step 5 — composeAlert
// Single Claude call. LLM formats values from anomaly object ONLY.
// ---------------------------------------------------------------------------

async function composeAlert(anomaly) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const dirWord = anomaly.delta_pct < 0 ? 'dropped' : 'spiked';
  const pctStr  = `${Math.abs(anomaly.delta_pct * 100).toFixed(1)}%`;

  const systemPrompt =
    'You are Sarah — a product intelligence partner sending a proactive metric alert. ' +
    'Format the alert below in Sarah\'s voice using the EXACT structure:\n\n' +
    '⚡ *Observed:* [metric], [observed] vs baseline [baseline] — ' +
    '[delta_pct]% [drop/spike] · [window.from] · [source]\n' +
    '🎯 *Bottom Line:* [severity] deviation. State observation only — ' +
    'never assert a cause as confirmed. Include confidence label.\n' +
    '🔗 *Context:* [enrichment if present, flagged as correlation only; ' +
    'if null write "No cross-tool context available for this window."]\n' +
    '➡️ *Next step:* One specific check to validate the signal.\n\n' +
    '_Mute this alert · Adjust threshold · Why am I seeing this?_\n\n' +
    'RULES: Numbers come ONLY from the anomaly object. ' +
    'Never invent or round differently. Under 180 words total.';

  const userMsg =
    `Anomaly object:\n${JSON.stringify(anomaly, null, 2)}\n\n` +
    `The metric ${dirWord} ${pctStr} vs the trailing same-weekday baseline.`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 512,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMsg }],
    output_config: { effort: 'high' },
  });

  return response.content.find(b => b.type === 'text')?.text || '';
}

// ---------------------------------------------------------------------------
// Step 6 — postToSlack
// ---------------------------------------------------------------------------

async function postToSlack(workspace, messageText, channelId) {
  const slack = new WebClient(decrypt(workspace.bot_token));
  await slack.chat.postMessage({
    channel: channelId,
    text:    messageText,
    blocks:  [
      { type: 'section', text: { type: 'mrkdwn', text: messageText } },
    ],
  });
}

// ---------------------------------------------------------------------------
// runMonitor — per-monitor orchestrator
// ---------------------------------------------------------------------------

async function runMonitor(monitor, workspace) {
  const label = `[Monitor] ws=${monitor.workspace_id} id=${monitor.monitor_id}`;

  // 1. Fetch 28-day window (in-memory, not persisted)
  let dailyValues;
  try {
    dailyValues = await fetchMetricWindow(monitor, workspace);
  } catch (err) {
    console.error(`${label} fetchMetricWindow failed:`, err.message);
    return;
  }

  if (dailyValues.length === 0) {
    console.log(`${label} no data returned — skipping`);
    return;
  }

  // 2. Yesterday = the observation date
  const yesterday = daysAgo(1);
  const todayPoint = dailyValues.find(p => p.date === yesterday);
  if (!todayPoint) {
    console.log(`${label} no data for ${yesterday} — skipping`);
    return;
  }
  const observed = todayPoint.value;

  // 3. Compute baseline (same weekday, trailing window)
  const baselineWindow = monitor.baseline?.window ?? 4;
  const baselineMinN   = monitor.baseline?.min_n  ?? 100;
  const baseline = computeTrailingWeekdayBaseline(dailyValues, yesterday, baselineWindow, baselineMinN);
  if (!baseline) {
    console.log(`${label} insufficient baseline history — skipping`);
    return;
  }
  console.log(`${label} observed=${observed} baseline=${baseline.mean.toFixed(1)}±${baseline.std.toFixed(1)} (n=${baseline.n})`);

  // 4. Detect anomaly
  const anomaly = detectAnomaly(monitor, observed, baseline, yesterday);
  if (!anomaly) {
    console.log(`${label} no anomaly detected (within threshold)`);
    return;
  }
  console.log(`${label} ANOMALY: severity=${anomaly.severity} delta=${(anomaly.delta_pct * 100).toFixed(1)}% dedup=${anomaly.dedup_key}`);

  // 5. shouldFire check
  const { fire, reason } = await shouldFire(anomaly, monitor);
  if (!fire) {
    console.log(`${label} suppressed: ${reason}`);
    return;
  }

  // 6. Compose alert (LLM — formats anomaly object only)
  let alertText;
  try {
    alertText = await composeAlert(anomaly);
  } catch (err) {
    console.error(`${label} composeAlert failed:`, err.message);
    // Fallback: plain text
    alertText =
      `⚡ *${anomaly.metric_label}* ${anomaly.delta_pct < 0 ? 'dropped' : 'spiked'} ` +
      `${Math.abs(anomaly.delta_pct * 100).toFixed(1)}% vs baseline ` +
      `(${anomaly.observed} vs ${anomaly.baseline}) · ${yesterday}\n` +
      `Severity: *${anomaly.severity}*`;
  }

  // 7. Post to Slack
  try {
    await postToSlack(workspace, alertText, monitor.channel);
    console.log(`${label} posted to channel=${monitor.channel}`);
  } catch (err) {
    console.error(`${label} postToSlack failed:`, err.message);
    return;
  }

  // 8. Record fire (dedup_key + severity ONLY — no metric values)
  await recordFire(monitor.workspace_id, monitor.monitor_id, anomaly.dedup_key, anomaly.severity);
}

// ---------------------------------------------------------------------------
// runScheduledChecks — cron entry point
// Loads all active monitors, processes each under its workspace credentials.
// Per-tenant isolation: each monitor resolved against its own workspace only.
// One monitor failure never blocks others or leaks across tenants.
// ---------------------------------------------------------------------------

export async function runScheduledChecks() {
  console.log('[Monitoring] runScheduledChecks starting');
  let monitors;
  try {
    monitors = await getAllActiveMonitors();
  } catch (err) {
    console.error('[Monitoring] Failed to load monitors:', err.message);
    return;
  }

  if (monitors.length === 0) {
    console.log('[Monitoring] No active monitors configured');
    return;
  }

  // Group by workspace to load each workspace's credentials once
  const byWorkspace = new Map();
  for (const m of monitors) {
    if (!byWorkspace.has(m.workspace_id)) byWorkspace.set(m.workspace_id, []);
    byWorkspace.get(m.workspace_id).push(m);
  }

  for (const [workspaceId, wsMonitors] of byWorkspace) {
    // Security: load this workspace's credentials — never another's
    let workspace;
    try {
      workspace = await getWorkspace(workspaceId);
    } catch (err) {
      console.error(`[Monitoring] getWorkspace failed for ${workspaceId}:`, err.message);
      continue;
    }

    if (!workspace?.mixpanel_project_id) {
      console.log(`[Monitoring] workspace ${workspaceId} has no Mixpanel — skipping`);
      continue;
    }

    for (const monitor of wsMonitors) {
      // Isolated try/catch: one monitor failure never blocks the next
      try {
        await runMonitor(monitor, workspace);
      } catch (err) {
        console.error(`[Monitoring] Unhandled error in monitor ${monitor.monitor_id}:`, err.message);
      }
    }
  }

  console.log('[Monitoring] runScheduledChecks complete');
}
