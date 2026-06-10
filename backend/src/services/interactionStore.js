/**
 * interactionStore.js — Per-user interaction metadata store.
 *
 * Stores what was ASKED and ABOUT WHAT — never metric values.
 * Enables Sarah to reference prior interactions ("last time you asked about checkout…")
 * and drive then-vs-now comparisons by re-fetching values live.
 *
 * Storage contract (non-negotiable):
 *   ✅ Stored:  query_text, metric_ref, topic_tags, sarah_notes (qualitative)
 *   ❌ Never:   metric values, baselines, user-level product data
 *
 * Retention: 90 days (matches conversations table).
 * GDPR: covered by deleteUserAllData().
 */

import pool from './db.js';

// ---------------------------------------------------------------------------
// Topic tag extraction
// ---------------------------------------------------------------------------

const TAG_RULES = [
  { tags: ['conversion', 'funnel'],    keywords: ['funnel', 'conversion', 'convert', 'המרה', 'sign up', 'signup', 'checkout'] },
  { tags: ['retention'],               keywords: ['retention', 'churn', 'retained', 'ריטנשן', 'חזרו'] },
  { tags: ['errors'],                  keywords: ['error', 'bug', 'crash', 'שגיאה', 'תקלה', 'error shown'] },
  { tags: ['activation'],              keywords: ['activat', 'onboard', 'first', 'הפעלה', 'אקטיבציה'] },
  { tags: ['revenue'],                 keywords: ['revenue', 'payment', 'paid', 'purchase', 'הכנסה'] },
  { tags: ['engagement'],              keywords: ['dau', 'mau', 'active users', 'engagement', 'session'] },
  { tags: ['jira'],                    keywords: ['ticket', 'jira', 'bug report', 'p1', 'p2', 'incident'] },
  { tags: ['comparison', 'trend'],     keywords: ['last week', 'last month', 'vs', 'compared', 'שבוע שעבר', 'לעומת', 'change'] },
];

export function extractTopicTags(queryText) {
  const lower = queryText.toLowerCase();
  const tags = new Set();
  for (const rule of TAG_RULES) {
    if (rule.keywords.some(kw => lower.includes(kw))) {
      rule.tags.forEach(t => tags.add(t));
    }
  }
  return [...tags];
}

// ---------------------------------------------------------------------------
// Metric ref extraction
// ---------------------------------------------------------------------------

export function extractMetricRef(queryText, workspace) {
  const lower = queryText.toLowerCase();

  // Funnel references
  if (lower.includes('funnel') || lower.includes('conversion') || lower.includes('sign up') || lower.includes('checkout')) {
    return 'mixpanel.funnel.main';
  }
  if (lower.includes('activation') || lower.includes('onboard')) {
    return 'mixpanel.funnel.activation';
  }

  // Retention
  if (lower.includes('retention') || lower.includes('churn')) {
    return 'mixpanel.retention';
  }

  // Errors
  if (lower.includes('error') || lower.includes('שגיאה')) {
    return 'mixpanel.event.error_shown';
  }

  // Jira
  if (lower.includes('ticket') || lower.includes('jira') || /\b[A-Z]{2,10}-\d+\b/.test(queryText)) {
    return 'jira.issues';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Save interaction
// ---------------------------------------------------------------------------

/**
 * Save an interaction after Sarah answers. Fire-and-forget — never throws.
 * sarah_notes: qualitative summary only (no metric values).
 */
export async function saveInteraction({ workspaceId, userId, queryText, sarahResponse, workspace }) {
  try {
    const topicTags = extractTopicTags(queryText);
    const metricRef = extractMetricRef(queryText, workspace);

    // Extract qualitative notes from Sarah's Bottom Line (strip numbers)
    const sarahNotes = extractQualitativeNotes(sarahResponse);

    await pool.query(
      `INSERT INTO user_interactions
         (workspace_id, user_id, query_text, metric_ref, topic_tags, sarah_notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, userId, queryText.slice(0, 500), metricRef, topicTags, sarahNotes]
    );
  } catch (err) {
    // Never block the user response
    console.warn('[InteractionStore] Save failed:', err.message);
  }
}

/**
 * Extract a qualitative summary from Sarah's Bottom Line.
 * Strips numbers to ensure NO metric values are stored.
 */
function extractQualitativeNotes(responseText) {
  if (!responseText) return null;

  // Find Bottom Line section
  const blMatch = responseText.match(/🎯\s*\*?Bottom Line[:\*]*\*?\s*([^\n]{10,300})/i);
  const raw = blMatch ? blMatch[1] : responseText.slice(0, 200);

  // Strip numeric values — keep qualitative framing only
  const qualitative = raw
    .replace(/\d[\d,.]*/g, 'N')      // replace numbers with N
    .replace(/N%/g, 'significant')    // e.g. "18%" → "significant"
    .replace(/\s+/g, ' ')
    .trim();

  return qualitative.length > 20 ? qualitative.slice(0, 400) : null;
}

// ---------------------------------------------------------------------------
// Retrieve relevant history
// ---------------------------------------------------------------------------

/**
 * Fetch recent interactions relevant to the current query.
 * Matches by metric_ref first, then topic_tags overlap, then recency.
 * Returns at most 5 entries — enough for continuity, not enough to bloat context.
 */
export async function getRelevantHistory(workspaceId, userId, queryText, workspace) {
  try {
    const metricRef = extractMetricRef(queryText, workspace);
    const topicTags = extractTopicTags(queryText);

    if (!metricRef && topicTags.length === 0) return [];

    // Score by: exact metric_ref match (2pts) + topic_tags overlap (1pt each) + recency
    const { rows } = await pool.query(
      `SELECT
         query_text,
         metric_ref,
         topic_tags,
         sarah_notes,
         ts,
         (
           CASE WHEN metric_ref = $3 THEN 2 ELSE 0 END +
           COALESCE(array_length(topic_tags & $4::text[], 1), 0)
         ) AS relevance_score
       FROM user_interactions
       WHERE workspace_id = $1
         AND user_id      = $2
         AND ts > NOW() - INTERVAL '90 days'
         AND (
           metric_ref = $3
           OR topic_tags && $4::text[]
         )
       ORDER BY relevance_score DESC, ts DESC
       LIMIT 5`,
      [workspaceId, userId, metricRef, topicTags]
    );

    return rows;
  } catch (err) {
    console.warn('[InteractionStore] Retrieve failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Format history for context injection
// ---------------------------------------------------------------------------

/**
 * Format retrieved interactions as a compact context block for Sarah's system prompt.
 * Injects into Block 3 (fresh, per-request) — never cached.
 */
export function formatHistoryContext(interactions) {
  if (!interactions || interactions.length === 0) return '';

  const lines = [
    '--- PRIOR INTERACTIONS (continuity context, this user) ---',
    'Use these to reference prior work. DO NOT fabricate details not shown here.',
    'For then-vs-now comparisons: re-fetch BOTH windows live — never use stored values.',
    '',
  ];

  for (const ix of interactions) {
    const when = new Date(ix.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    lines.push(`[${when}] Asked: "${ix.query_text.slice(0, 120)}"`);
    if (ix.metric_ref) lines.push(`  Metric: ${ix.metric_ref}`);
    if (ix.sarah_notes) lines.push(`  Sarah noted: ${ix.sarah_notes}`);
    if (ix.topic_tags?.length) lines.push(`  Topics: ${ix.topic_tags.join(', ')}`);
    lines.push('');
  }

  lines.push('--- END PRIOR INTERACTIONS ---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Then-vs-now: detect comparison intent + build live re-fetch context
// ---------------------------------------------------------------------------

const THEN_VS_NOW_PATTERNS = [
  'compared to last time', 'vs last time', 'since last time',
  'how has it changed', 'has it changed', 'still the same', 'still dropping',
  'still improving', 'better now', 'worse now', 'improved since',
  'לעומת פעם', 'בהשוואה לפעם', 'השתנה מאז', 'עדיין',
  'last time we checked', 'since we spoke', 'update on',
];

export function detectThenVsNow(queryText) {
  const lower = queryText.toLowerCase();
  return THEN_VS_NOW_PATTERNS.some(p => lower.includes(p));
}

/**
 * Build then-vs-now context block for injection into Block 3.
 * Supplies the prior interaction date so Sarah knows which window to re-fetch.
 * Values are NEVER stored here — Sarah re-fetches both windows live.
 */
export function formatThenVsNowContext(priorInteraction) {
  if (!priorInteraction) return '';
  const priorDate = new Date(priorInteraction.ts).toISOString().split('T')[0];
  const when = new Date(priorInteraction.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return [
    '--- THEN-VS-NOW COMPARISON REQUESTED ---',
    `Prior interaction date: ${priorDate} (${when})`,
    `Metric: ${priorInteraction.metric_ref || 'see prior interaction above'}`,
    '',
    'MANDATORY: Re-fetch BOTH windows live before answering:',
    `  1. THEN window: date range anchored to ${priorDate} (same metric, same period length)`,
    '  2. NOW window: current period (same metric, same period length)',
    'Present both values with source citations. Label clearly: "Then (${when}):" and "Now:".',
    'DO NOT use any value from the prior interaction block — qualitative notes only, no metric values stored.',
    '--- END THEN-VS-NOW ---',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// GDPR: delete all interactions for a user
// (called from deleteUserAllData in db.js)
// ---------------------------------------------------------------------------

export async function deleteUserInteractions(workspaceId, userId) {
  await pool.query(
    'DELETE FROM user_interactions WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]
  );
}
