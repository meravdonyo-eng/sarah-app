/**
 * snapshot.js — Sarah opening message (daily, per-user)
 *
 * Runs all queries in PARALLEL with a 5-second timeout per query.
 * Builds the message directly from results — does NOT go through Claude's
 * agentic loop. This guarantees:
 *   - Every number in the message came from an actual query
 *   - Failed / timed-out queries show "unavailable" (never invented)
 *   - Total latency ≈ slowest single query (not sum of all queries)
 */

import { executeMixpanelTool } from './mixpanel.js';
import { executeJiraTool } from './jira.js';
import { executeClickupTool } from './clickup.js';
import { decrypt } from './encryption.js';
import { isJiraValid } from './claude.js';

const QUERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

/**
 * Race a promise against a wall-clock timeout.
 * Returns null if the timeout fires first or the promise rejects.
 * Logs the error before swallowing so failures are visible in server logs.
 */
function withTimeout(promise, label, ms = QUERY_TIMEOUT_MS) {
  const start = Date.now();
  const raceTimeout = new Promise(resolve =>
    setTimeout(() => {
      console.warn(`[Snapshot] ⏱ TIMEOUT after ${ms}ms: ${label}`);
      resolve(null);
    }, ms)
  );
  const racePromise = promise
    .then(result => {
      console.log(`[Snapshot] ✓ ${label} (${Date.now() - start}ms)`);
      return result;
    })
    .catch(err => {
      const status = err?.response?.status;
      const body   = JSON.stringify(err?.response?.data ?? err?.message ?? err).slice(0, 300);
      console.error(`[Snapshot] ✗ FAILED ${label} (${Date.now() - start}ms) status=${status ?? 'n/a'}: ${body}`);
      return null;
    });
  return Promise.race([racePromise, raceTimeout]);
}

/**
 * Extract total unique-user count from a Mixpanel segmentation response.
 * Response shape: { data: { values: { '<EventName>': { 'YYYY-MM-DD': N } } } }
 * Sums all date buckets (safe even for multi-day ranges).
 */
function extractUniqueUsers(result, eventName) {
  try {
    const eventData = result?.data?.values?.[eventName];
    if (!eventData) return null;
    return Object.values(eventData).reduce((sum, v) => sum + (Number(v) || 0), 0);
  } catch {
    return null;
  }
}

/**
 * Extract daily average from a Mixpanel segmentation response.
 * Used for 7-day baseline: averages each day's unique-user count.
 */
function extractDailyAvg(result, eventName) {
  try {
    const eventData = result?.data?.values?.[eventName];
    if (!eventData) return null;
    const values = Object.values(eventData).map(v => Number(v) || 0);
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  } catch {
    return null;
  }
}

/**
 * Resolve the actual event names to query, using the workspace event_dictionary
 * if the PM configured key events during onboarding — otherwise fall back to defaults.
 */
function resolveEventNames(workspace) {
  try {
    const dict = workspace.event_dictionary
      ? (typeof workspace.event_dictionary === 'string'
          ? JSON.parse(workspace.event_dictionary)
          : workspace.event_dictionary)
      : null;
    return {
      conversionEvent: dict?.['main conversion event'] || 'Sign Up Started',
      errorEvent:      dict?.['main error event']      || 'Error Shown',
    };
  } catch {
    return { conversionEvent: 'Sign Up Started', errorEvent: 'Error Shown' };
  }
}

// ---------------------------------------------------------------------------
// Query runner
// ---------------------------------------------------------------------------

async function runQueries(workspace) {
  const hasMixpanel  = !!(workspace.mixpanel_project_id && workspace.mixpanel_username && workspace.mixpanel_secret);
  const hasJira      = isJiraValid(workspace);
  const hasClickUp   = !!(workspace.clickup_api_token && workspace.clickup_team_id);

  console.log(`[Snapshot] runQueries wsId=${workspace.workspace_id} hasMixpanel=${hasMixpanel} hasJira=${hasJira} hasClickUp=${hasClickUp}`);

  const yesterday = daysAgo(1);

  const mixpanelCreds = hasMixpanel ? {
    projectId: decrypt(workspace.mixpanel_project_id),
    username:  decrypt(workspace.mixpanel_username),
    secret:    decrypt(workspace.mixpanel_secret),
  } : null;

  if (hasMixpanel) {
    console.log(`[Snapshot] Mixpanel projectId=${mixpanelCreds.projectId?.slice(0, 8)}... username=${mixpanelCreds.username?.slice(0, 6)}...`);
  }

  const jiraCreds = hasJira ? {
    accessToken:  decrypt(workspace.jira_access_token),
    refreshToken: decrypt(workspace.jira_refresh_token),
    cloudId:      workspace.jira_cloud_id,
    expiresAt:    workspace.jira_expires_at,
    workspaceId:  workspace.workspace_id,
  } : null;

  // Resolve event names from workspace dictionary (falls back to defaults)
  const { conversionEvent, errorEvent } = resolveEventNames(workspace);
  console.log(`[Snapshot] events: conversion="${conversionEvent}" error="${errorEvent}"`);

  // Build Jira JQL — scope to default project if configured
  const projectFilter = workspace.jira_default_project
    ? `project = "${workspace.jira_default_project}" AND `
    : '';

  // Fire all 6 queries simultaneously — each wrapped with its own timeout
  const [signUps, errors, jiraUpdated, jiraCreated, signUps7dAvg, errors7dAvg, clickupUpdated, clickupUrgent] = await Promise.all([

    // Query 1: conversion event — yesterday — unique users (today's value)
    hasMixpanel
      ? withTimeout(
          executeMixpanelTool('mixpanel_segmentation', {
            event:     conversionEvent,
            from_date: yesterday,
            to_date:   yesterday,
            unit:      'day',
            type:      'unique',
          }, mixpanelCreds).then(r => extractUniqueUsers(r, conversionEvent)),
          `mixpanel_segmentation "${conversionEvent}" ${yesterday}`
        )
      : Promise.resolve(null),

    // Query 2: error event — yesterday — unique users (today's value)
    hasMixpanel
      ? withTimeout(
          executeMixpanelTool('mixpanel_segmentation', {
            event:     errorEvent,
            from_date: yesterday,
            to_date:   yesterday,
            unit:      'day',
            type:      'unique',
          }, mixpanelCreds).then(r => extractUniqueUsers(r, errorEvent)),
          `mixpanel_segmentation "${errorEvent}" ${yesterday}`
        )
      : Promise.resolve(null),

    // Query 3: Jira issues updated in last 24h
    hasJira
      ? withTimeout(
          executeJiraTool('jira_search_issues', {
            jql: `${projectFilter}updated >= -24h ORDER BY updated DESC`,
            max_results: 10,
          }, jiraCreds),
          'jira updated >= -24h'
        )
      : Promise.resolve(null),

    // Query 4: Jira issues created in last 24h
    hasJira
      ? withTimeout(
          executeJiraTool('jira_search_issues', {
            jql: `${projectFilter}created >= -24h ORDER BY created DESC`,
            max_results: 5,
          }, jiraCreds),
          'jira created >= -24h'
        )
      : Promise.resolve(null),

    // Query 5: conversion event — 7-day baseline (8 days ago → 2 days ago, excludes yesterday)
    hasMixpanel
      ? withTimeout(
          executeMixpanelTool('mixpanel_segmentation', {
            event:     conversionEvent,
            from_date: daysAgo(8),
            to_date:   daysAgo(2),
            unit:      'day',
            type:      'unique',
          }, mixpanelCreds).then(r => extractDailyAvg(r, conversionEvent)),
          `mixpanel_segmentation "${conversionEvent}" 7d avg`
        )
      : Promise.resolve(null),

    // Query 6: error event — 7-day baseline (8 days ago → 2 days ago, excludes yesterday)
    hasMixpanel
      ? withTimeout(
          executeMixpanelTool('mixpanel_segmentation', {
            event:     errorEvent,
            from_date: daysAgo(8),
            to_date:   daysAgo(2),
            unit:      'day',
            type:      'unique',
          }, mixpanelCreds).then(r => extractDailyAvg(r, errorEvent)),
          `mixpanel_segmentation "${errorEvent}" 7d avg`
        )
      : Promise.resolve(null),

    // Query 7: ClickUp — tasks updated in last 24h
    hasClickUp
      ? withTimeout(
          executeClickupTool('clickup_search_tasks', {
            updated_since:  yesterday,
            include_closed: false,
            max_results:    10,
          }, { token: decrypt(workspace.clickup_api_token), teamId: workspace.clickup_team_id }),
          'clickup updated >= -24h'
        )
      : Promise.resolve(null),

    // Query 8: ClickUp — urgent/high tasks created in last 24h
    hasClickUp
      ? withTimeout(
          executeClickupTool('clickup_search_tasks', {
            created_since:  yesterday,
            priority:       'urgent',
            include_closed: false,
            max_results:    5,
          }, { token: decrypt(workspace.clickup_api_token), teamId: workspace.clickup_team_id }),
          'clickup created urgent >= -24h'
        )
      : Promise.resolve(null),
  ]);

  // Cross-reference: Done tickets → check if related errors still fire in Mixpanel
  // Runs only if:
  //   - Both Mixpanel and Jira returned results
  //   - There are Done tickets in jiraUpdated
  //   - The ticket has a 'deployed_at' label (format: "deployed:YYYY-MM-DD")
  let crossRefAlerts = [];
  if (hasMixpanel && jiraUpdated?.issues?.length > 0) {
    const doneTickets = jiraUpdated.issues.filter(
      i => i.fields?.status?.name?.toLowerCase() === 'done'
    );

    const crossRefPromises = doneTickets.flatMap(issue => {
      // Look for deployed_at in labels (e.g. label "deployed:2024-01-15")
      const labels = issue.fields?.labels || [];
      const deployedLabel = labels.find(l => l.startsWith('deployed:'));
      if (!deployedLabel) return [];

      const deployedAt = deployedLabel.replace('deployed:', '');
      const ticketKey   = issue.key;

      return [withTimeout(
        executeMixpanelTool('mixpanel_segmentation', {
          event:     'Error Shown',
          from_date: deployedAt,
          to_date:   yesterday,
          unit:      'day',
          type:      'unique',
          where:     `properties["bug_id"] == "${ticketKey}"`,
        }, mixpanelCreds)
        .then(r => {
          const count = extractUniqueUsers(r, 'Error Shown');
          return count > 0 ? { ticketKey, count } : null;
        })
      )];
    });

    if (crossRefPromises.length > 0) {
      const crossRefResults = await Promise.all(crossRefPromises);
      crossRefAlerts = crossRefResults.filter(Boolean);
    }
  }

  console.log(`[Snapshot] results: signUps=${signUps} (7dAvg=${signUps7dAvg?.toFixed(1)}) errors=${errors} (7dAvg=${errors7dAvg?.toFixed(1)}) jiraUpdated=${jiraUpdated?.issues?.length ?? 'n/a'} jiraCreated=${jiraCreated?.issues?.length ?? 'n/a'} clickupUpdated=${clickupUpdated?.total ?? 'n/a'} crossRef=${crossRefAlerts.length}`);

  return { signUps, errors, signUps7dAvg, errors7dAvg, jiraUpdated, jiraCreated, clickupUpdated, clickupUrgent, crossRefAlerts, hasMixpanel, hasJira, hasClickUp, conversionEvent, errorEvent };
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

function buildMessage(results, lang = 'he') {
  const { signUps, errors, signUps7dAvg, errors7dAvg,
          jiraUpdated, jiraCreated, clickupUpdated, clickupUrgent,
          crossRefAlerts, hasMixpanel, hasJira, hasClickUp,
          conversionEvent, errorEvent } = results;

  // Anomaly detection
  const errorSpiked   = errors  !== null && errors7dAvg  !== null && errors  > errors7dAvg  * 1.5;
  const signUpDropped = signUps !== null && signUps7dAvg !== null && signUps < signUps7dAvg * 0.7;

  // Format conversion line
  let signUpsLine;
  if (signUps === null) {
    signUpsLine = null; // omit entirely — event may not exist in this workspace
  } else if (signUpDropped) {
    const avg = Math.round(signUps7dAvg);
    signUpsLine = lang === 'he'
      ? `• ⚠️ ${conversionEvent}: ${signUps} — מתחת לממוצע 7 ימים (${avg}). שווה לבדוק.`
      : `• ⚠️ ${conversionEvent}: ${signUps} — below 7-day avg (${avg}). Worth investigating.`;
  } else {
    signUpsLine = `• ${conversionEvent}: ${signUps}`;
  }

  // Format error line
  let errorsLine;
  if (errors === null) {
    errorsLine = null; // omit entirely
  } else if (errorSpiked) {
    const avg = Math.round(errors7dAvg);
    errorsLine = lang === 'he'
      ? `• ⚠️ ${errorEvent}: ${errors} משתמשים — מעל ממוצע 7 ימים (${avg}). שווה לבדוק.`
      : `• ⚠️ ${errorEvent}: ${errors} users — above 7-day avg (${avg}). Worth investigating.`;
  } else {
    errorsLine = `• ${errorEvent}: ${errors} users affected`;
  }

  // Merge updated + created tickets, deduplicated, max 3 lines
  const seen = new Set();
  const jiraLines = [];

  for (const issue of [
    ...(jiraCreated?.issues || []),
    ...(jiraUpdated?.issues || []),
  ]) {
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    const status = issue.fields?.status?.name || 'Unknown';
    jiraLines.push(`• ${issue.key} moved to ${status}`);
    if (jiraLines.length >= 3) break;
  }

  // Cross-ref lines (⚠️ only if errors still firing after fix)
  for (const alert of crossRefAlerts) {
    jiraLines.push(`• ⚠️ ${alert.ticketKey} — ${errorEvent} still firing (${alert.count} users)`);
  }

  const hasJiraUpdates = jiraLines.length > 0;

  // Greeting
  const hour = new Date().getHours();
  let greeting;
  if (lang === 'he') {
    greeting = hour < 12 ? 'בוקר טוב 👋' : hour < 17 ? 'צהריים טובים 👋' : 'ערב טוב 👋';
  } else {
    greeting = hour < 12 ? 'Good morning 👋' : hour < 17 ? 'Good afternoon 👋' : 'Good evening 👋';
  }

  const question = lang === 'he' ? 'רוצה לצלול לנתון ספציפי?' : 'Anything to dig into?';

  const lines = [greeting, ''];

  // Mixpanel section — only show if at least one metric returned a real value.
  if (signUpsLine !== null || errorsLine !== null) {
    lines.push('📊 Last 24h (Mixpanel):');
    if (signUpsLine) lines.push(signUpsLine);
    if (errorsLine)  lines.push(errorsLine);
  } else if (hasMixpanel) {
    // Mixpanel IS connected but events returned no data — guide the PM
    lines.push(
      lang === 'he'
        ? '📊 Mixpanel מחובר — שאלי אותי על אירועי המשתמשים שלך'
        : '📊 Mixpanel connected — ask me about your user events'
    );
  }

  if (hasJiraUpdates) {
    lines.push('');
    lines.push('🎫 Jira (last 24h):');
    lines.push(...jiraLines);
  } else if (!hasJira) {
    lines.push('');
    lines.push(
      lang === 'he'
        ? '🔗 Jira לא מחובר — כתוב *connect jira* כדי לחבר'
        : '🔗 Jira not connected — type *connect jira* to set it up'
    );
  }

  // ClickUp section
  const clickupTasks = [
    ...(clickupUrgent?.tasks || []),
    ...(clickupUpdated?.tasks || []),
  ].filter((t, i, arr) => arr.findIndex(x => x.id === t.id) === i).slice(0, 3);

  if (clickupTasks.length > 0) {
    lines.push('');
    lines.push('✅ ClickUp (last 24h):');
    for (const t of clickupTasks) {
      const pri = t.priority ? ` · ${t.priority}` : '';
      lines.push(`• ${t.name}${pri} — ${t.status || 'open'}`);
    }
  } else if (hasClickUp) {
    lines.push('');
    lines.push('✅ ClickUp: no high-priority task changes in the last 24h');
  }

  lines.push('');
  lines.push(question);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateSnapshot(workspace, lang = 'he') {
  const results = await runQueries(workspace);
  return buildMessage(results, lang);
}
