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
import { executeJiraTool } from './jira.js';
import { isJiraValid } from './claude.js';
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

export function computeTrailingWeekdayBaseline(dailyValues, targetDate, window = 4, minN = 100, options = {}) {
  const method    = options?.method ?? 'trailing_weekday';
  const minPoints = options?.min_points ?? 3;

  let candidates;

  if (method === 'rolling_mean') {
    // Use ALL data points before targetDate — ignores weekday, good for sparse/demo data
    candidates = dailyValues
      .filter(p => p.date < targetDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, window * 7); // use up to window×7 days of history
  } else {
    // trailing_weekday: only same weekday as targetDate
    const targetWeekday = dateWeekday(targetDate);
    candidates = dailyValues
      .filter(p => p.date < targetDate && dateWeekday(p.date) === targetWeekday)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, window);
  }

  const valid = candidates.filter(p => p.value >= minN);
  if (valid.length < minPoints) return null;

  const vals     = valid.map(p => p.value);
  const mean     = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
  const std      = Math.sqrt(variance);

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

  // Quiet hours — timezone-aware (Phase 2)
  if (monitor.quiet_hours) {
    const { from, to, tz = 'UTC' } = monitor.quiet_hours;
    try {
      const localHour = parseInt(
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false })
          .format(new Date())
      );
      const fromH = parseInt(from);
      const toH   = parseInt(to);
      const inQuiet = fromH > toH
        ? (localHour >= fromH || localHour < toH)   // overnight window e.g. 20:00–08:00
        : (localHour >= fromH && localHour < toH);  // daytime window
      if (inQuiet) {
        return { fire: false, reason: `quiet hours (${from}–${to} ${tz})` };
      }
    } catch {
      // Unknown timezone — skip quiet hours check rather than block alert
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

async function postToSlack(workspace, messageText, channelId, anomaly) {
  const slack = new WebClient(decrypt(workspace.bot_token));

  // Strip the plain-text footer from the LLM output (we replace it with real buttons)
  const body = messageText
    .replace(/\n*_?Mute this alert.*Why am I seeing this\?_?/i, '')
    .trim();

  await slack.chat.postMessage({
    channel: channelId,
    text:    body,
    blocks:  [
      { type: 'section', text: { type: 'mrkdwn', text: body } },
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type:      'button',
            text:      { type: 'plain_text', text: '🔕 Mute 24h' },
            action_id: 'monitor_mute',
            value:     JSON.stringify({ workspace_id: anomaly.workspace_id, monitor_id: anomaly.monitor_id, hours: 24 }),
          },
          {
            type:      'button',
            text:      { type: 'plain_text', text: '⚙️ Adjust threshold' },
            action_id: 'monitor_adjust',
            value:     JSON.stringify({ workspace_id: anomaly.workspace_id, monitor_id: anomaly.monitor_id }),
          },
          {
            type:      'button',
            text:      { type: 'plain_text', text: '❓ Why am I seeing this?' },
            action_id: 'monitor_why',
            value:     JSON.stringify({ monitor_id: anomaly.monitor_id, delta_pct: anomaly.delta_pct, severity: anomaly.severity }),
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Step 5.5 — enrichAnomaly (Phase 3)
// Pulls Jira issues from the same time window as the anomaly.
// CORRELATION ONLY — no shared user ID → never claim causation.
// Only runs if Jira is connected for this workspace.
// ---------------------------------------------------------------------------

async function enrichAnomaly(anomaly, workspace) {
  const enrichment = { jira: null };

  if (!isJiraValid(workspace)) return enrichment;

  try {
    const jiraCreds = {
      accessToken:  decrypt(workspace.jira_access_token),
      refreshToken: decrypt(workspace.jira_refresh_token),
      cloudId:      workspace.jira_cloud_id,
      expiresAt:    workspace.jira_expires_at,
      workspaceId:  workspace.workspace_id,
    };

    const projectFilter = workspace.jira_default_project
      ? `project = "${workspace.jira_default_project}" AND `
      : '';

    const { from } = anomaly.window;
    const jql = `${projectFilter}(created >= "${from}" OR updated >= "${from}") ORDER BY priority ASC`;

    const result = await executeJiraTool('jira_search_issues', { jql, max_results: 10 }, jiraCreds);
    const issues = result?.issues || [];

    // Filter to high-priority issues only to reduce noise
    const highPri = ['highest', 'high', 'urgent', 'critical', 'p1', 'p2'];
    const filtered = issues
      .filter(i => highPri.includes((i.fields?.priority?.name || '').toLowerCase()))
      .slice(0, 3)
      .map(i => ({
        key:      i.key,
        priority: i.fields?.priority?.name || 'unknown',
        created:  (i.fields?.created || '').split('T')[0],
        summary:  (i.fields?.summary || '').slice(0, 80),
        status:   i.fields?.status?.name || 'unknown',
      }));

    if (filtered.length > 0) enrichment.jira = filtered;
  } catch (err) {
    console.warn(`[Monitor] enrichAnomaly Jira failed: ${err.message}`);
  }

  return enrichment;
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
  const baselineWindow    = monitor.baseline?.window     ?? 4;
  const baselineMinN      = monitor.baseline?.min_n      ?? 100;
  const baselineMinPoints = monitor.baseline?.min_points ?? 3;
  const baselineMethod    = monitor.baseline?.method     ?? 'trailing_weekday';
  const baseline = computeTrailingWeekdayBaseline(
    dailyValues, yesterday, baselineWindow, baselineMinN,
    { min_points: baselineMinPoints, method: baselineMethod }
  );
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
    // Return suppressed anomaly so runScheduledChecks can include it in the daily digest
    if (reason.startsWith('daily cap')) return { suppressed: anomaly };
    return null;
  }

  // 5.5. Enrich with Jira context (correlation only — same time window)
  anomaly.enrichment = await enrichAnomaly(anomaly, workspace);
  if (anomaly.enrichment?.jira?.length > 0) {
    console.log(`${label} enriched: ${anomaly.enrichment.jira.length} Jira issue(s) in window`);
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
    await postToSlack(workspace, alertText, monitor.channel, anomaly);
    console.log(`${label} posted to channel=${monitor.channel}`);
  } catch (err) {
    console.error(`${label} postToSlack failed:`, err.message);
    return;
  }

  // 8. Record fire (dedup_key + severity ONLY — no metric values)
  await recordFire(monitor.workspace_id, monitor.monitor_id, anomaly.dedup_key, anomaly.severity);
  return { fired: anomaly };
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

    const suppressedAnomalies = [];

    for (const monitor of wsMonitors) {
      // Isolated try/catch: one monitor failure never blocks the next
      try {
        const result = await runMonitor(monitor, workspace);
        if (result?.suppressed) suppressedAnomalies.push({ monitor, anomaly: result.suppressed });
      } catch (err) {
        console.error(`[Monitoring] Unhandled error in monitor ${monitor.monitor_id}:`, err.message);
      }
    }

    // Daily digest — post once if any anomalies were suppressed by daily cap
    if (suppressedAnomalies.length > 0) {
      const channel = suppressedAnomalies[0].monitor.channel;
      const lines = [
        `📋 *Daily cap reached.* ${suppressedAnomalies.length} additional anomaly${suppressedAnomalies.length > 1 ? 'ies' : 'y'} detected but not sent:`,
        ...suppressedAnomalies.map(({ anomaly }) =>
          `• *${anomaly.metric_label}* — ${(anomaly.delta_pct * 100).toFixed(1)}% ${anomaly.delta_pct < 0 ? 'drop' : 'spike'} (${anomaly.severity})`
        ),
        '_Adjust your daily cap or mute individual monitors to reduce noise._',
      ];
      try {
        await postToSlack(workspace, lines.join('\n'), channel, suppressedAnomalies[0].anomaly);
        console.log(`[Monitoring] Sent digest: ${suppressedAnomalies.length} suppressed anomalies → ws=${workspaceId}`);
      } catch (err) {
        console.warn('[Monitoring] Digest post failed:', err.message);
      }
    }
  }

  console.log('[Monitoring] runScheduledChecks complete');
}
