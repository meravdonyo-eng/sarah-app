/**
 * zeroInputLog.js — Zero-input KPI logging for Sarah.
 *
 * Logs every query turn with outcome classification:
 *   answered        — Sarah answered from connected data (good)
 *   named_gap       — Sarah identified a specific gap (acceptable)
 *   asked_for_input — Sarah asked the PM to provide data (bug to triage)
 *
 * KPI = % of queries answered with no input request.
 * Every asked_for_input entry is a bug:
 *   connector gap        → build coverage
 *   instrumentation gap  → not our fix (tell PM)
 *   prompt slip          → fix prompt
 *
 * Outcome is derived by pattern-matching Sarah's response text.
 * This is heuristic — good enough for triage, not a court of law.
 */

import pool from './db.js';

// ---------------------------------------------------------------------------
// Outcome classifier
// ---------------------------------------------------------------------------

/**
 * Classify the outcome of a query turn from Sarah's response text.
 * Returns { outcome, gap_type, missing_ref }.
 */
export function classifyOutcome(responseText, workspace) {
  if (!responseText) return { outcome: 'answered', gap_type: 'none', missing_ref: null };

  const lower = responseText.toLowerCase();

  // ── asked_for_input: Sarah is requesting the PM to provide data ──
  // These represent prompt failures — Sarah should never ask for these.
  const inputRequestPatterns = [
    'please share', 'can you share', 'could you share',
    'please provide', 'can you provide', 'could you provide',
    'please upload', 'please attach', 'please export',
    'paste the', 'send me the', 'copy and paste',
    'i need you to', 'could you send',
  ];
  if (inputRequestPatterns.some(p => lower.includes(p))) {
    return { outcome: 'asked_for_input', gap_type: _detectGapFromAsk(lower), missing_ref: null };
  }

  // ── named_gap: connector missing ──
  const connectorGapPatterns = [
    'not connected', "isn't connected", 'is not connected',
    'connect mixpanel', 'connect jira', 'connect amplitude', 'connect clickup',
    "i don't have access to", "i don't have access",
    'type \'connect', 'type "connect',
    'no analytics tool', 'no project management tool',
  ];
  if (connectorGapPatterns.some(p => lower.includes(p))) {
    const tool = _extractToolRef(lower);
    return {
      outcome:     'named_gap',
      gap_type:    'connector',
      missing_ref: tool ? `connector.${tool}` : 'connector.unknown',
    };
  }

  // ── named_gap: instrumentation missing (event/metric not tracked) ──
  const instrumentationPatterns = [
    'not tracked', 'not being tracked', "isn't tracked",
    'no event', 'event not found', 'no such event',
    'not instrumented', "doesn't exist in mixpanel", 'not in mixpanel',
    'cannot find this event', "can't find this event",
  ];
  if (instrumentationPatterns.some(p => lower.includes(p))) {
    return {
      outcome:     'named_gap',
      gap_type:    'instrumentation',
      missing_ref: _extractEventRef(lower),
    };
  }

  // ── named_gap: empty window (event exists, 0 in the requested period) ──
  const emptyWindowPatterns = [
    'no events in this', 'no events recorded', 'no data for this period',
    'no data available for', 'returned zero', '0 unique users',
    'zero users', 'no users in',
    'unavailable',   // used in Sarah's fallback phrases
  ];
  if (emptyWindowPatterns.some(p => lower.includes(p))) {
    return { outcome: 'named_gap', gap_type: 'empty_window', missing_ref: null };
  }

  // ── Default: answered ──
  return { outcome: 'answered', gap_type: 'none', missing_ref: null };
}

function _detectGapFromAsk(lower) {
  if (lower.includes('csv') || lower.includes('export') || lower.includes('upload')) return 'instrumentation';
  if (lower.includes('mixpanel') || lower.includes('amplitude') || lower.includes('analytics')) return 'connector';
  if (lower.includes('jira') || lower.includes('clickup') || lower.includes('ticket')) return 'connector';
  return 'unknown';
}

function _extractToolRef(lower) {
  if (lower.includes('mixpanel')) return 'mixpanel';
  if (lower.includes('amplitude')) return 'amplitude';
  if (lower.includes('jira')) return 'jira';
  if (lower.includes('clickup')) return 'clickup';
  return null;
}

function _extractEventRef(lower) {
  // Try to extract a quoted event name from the response
  const quoted = lower.match(/["']([^"']{3,40})["']/);
  if (quoted) return `event.${quoted[1].replace(/\s+/g, '_')}`;
  return 'event.unknown';
}

// ---------------------------------------------------------------------------
// Query-type classifier
// ---------------------------------------------------------------------------

/**
 * Derive query type from the user's message.
 * Mirrors Sarah's T1–T4 taxonomy + tool-specific types.
 */
export function classifyQueryType(userMessage) {
  const lower = userMessage.toLowerCase();

  // Tool-specific mandates (highest priority)
  if (/\b[A-Z]{2,10}-\d+\b/.test(userMessage) || lower.includes('ticket') || lower.includes('jira')) return 'jira';
  if (lower.includes('clickup') || lower.includes('click up')) return 'clickup';

  // Analytics query types
  if (lower.includes('funnel') || lower.includes('conversion') || lower.includes('drop') ||
      lower.includes('sign up') || lower.includes('activated')) return 'T4_funnel';
  if (lower.includes('retention') || lower.includes('churn') || lower.includes('returned')) return 'T4_retention';
  if (lower.includes('a/b') || lower.includes('experiment') || lower.includes('variant') ||
      lower.includes('split test')) return 'T4_experiment';
  if (lower.includes('error') || lower.includes('bug') || lower.includes('crash') ||
      lower.includes('broken')) return 'T2_error';
  if (lower.includes('how many') || lower.includes('כמה') || lower.includes('count') ||
      lower.includes('users')) return 'T2_metric';
  if (lower.includes('why') || lower.includes('למה') || lower.includes('reason')) return 'T1_journey';

  return 'general';
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Log a query turn outcome. Fire-and-forget — never throws or blocks response.
 */
export async function logQueryOutcome({ workspaceId, slackUserId, userMessage, responseText, workspace }) {
  try {
    const queryType = classifyQueryType(userMessage || '');
    const { outcome, gap_type, missing_ref } = classifyOutcome(responseText, workspace);

    await pool.query(
      `INSERT INTO zero_input_log (workspace_id, slack_user_id, query_type, outcome, gap_type, missing_ref)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, slackUserId || null, queryType, outcome, gap_type, missing_ref || null]
    );

    // Log to server console for real-time visibility
    if (outcome !== 'answered') {
      console.log(`[ZeroInput] ws=${workspaceId} type=${queryType} outcome=${outcome} gap=${gap_type} ref=${missing_ref ?? '-'}`);
    }
  } catch (err) {
    // Never block the user response
    console.warn('[ZeroInput] Log failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// KPI summary (for admin endpoint)
// ---------------------------------------------------------------------------

export async function getZeroInputKpi(workspaceId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT
       outcome,
       gap_type,
       COUNT(*) AS count
     FROM zero_input_log
     WHERE workspace_id = $1 AND logged_at > $2
     GROUP BY outcome, gap_type
     ORDER BY count DESC`,
    [workspaceId, since]
  );

  const total    = rows.reduce((s, r) => s + parseInt(r.count), 0);
  const answered = rows.filter(r => r.outcome === 'answered').reduce((s, r) => s + parseInt(r.count), 0);
  const kpi      = total > 0 ? parseFloat(((answered / total) * 100).toFixed(1)) : null;

  return { kpi_pct: kpi, total, breakdown: rows, period_days: days };
}
