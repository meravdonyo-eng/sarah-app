/**
 * intentMapper.js — Intent-based Event Discovery for Sarah
 *
 * Finds the best Mixpanel event for a PM-defined business intent
 * without requiring the PM to know the exact event name upfront.
 *
 * Problem: every company names events differently.
 *   "active users" could be: $session_start / App Open / usr_session_init / page_view
 * Solution: PM defines INTENT characteristics once → engine finds the best event per project.
 *
 * Two-tier scoring:
 *   Tier 1 (free):  name-pattern scoring — runs against full event list, zero API calls
 *   Tier 2 (API):   unique-count volume  — only for top candidates with low tier-1 confidence
 *
 * Intent definitions are stored in workspace.event_dictionary under the 'intents' key.
 * Compatible with existing rich Dictionary format (business_metrics / event_aliases / intents).
 *
 * Example intent definition (in event_dictionary JSON):
 * {
 *   "intents": {
 *     "active_user": {
 *       "description": "Any user who opened the app or site",
 *       "characteristics": {
 *         "expected_volume": "highest_unique_users",
 *         "timing": "session_start",
 *         "avoid_if_name_contains": ["signup", "register", "purchase", "payment"],
 *         "look_for_name_containing": ["session", "open", "launch"]
 *       }
 *     }
 *   }
 * }
 */

// Score at which confidence reaches 0.99 (practical ceiling)
const MAX_SCORE = 85;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract event name strings from whatever mixpanel_list_events returns.
 * Handles: string[], {name}[], {event}[], or {data: [...]} wrapping.
 */
export function extractEventNames(events) {
  if (!events) return [];
  const arr = Array.isArray(events)
    ? events
    : Array.isArray(events?.data) ? events.data : [];
  return arr
    .map(e => (typeof e === 'string' ? e : (e?.name ?? e?.event ?? null)))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tier-1: name-pattern scoring (pure function, no API calls)
// ---------------------------------------------------------------------------

/**
 * Score a single event name against intent characteristics.
 * Returns { score: number, reasoning: string[] }.
 * score < 0  → hard reject (avoid pattern matched)
 * score = 0  → no signal
 * score > 0  → candidate, higher = better match
 */
function scoreEventByName(eventName, intent) {
  const name = eventName.toLowerCase();
  const chars = intent.characteristics || {};
  let score = 0;
  const reasoning = [];

  // Hard reject — avoid patterns
  if (chars.avoid_if_name_contains) {
    for (const avoid of chars.avoid_if_name_contains) {
      if (name.includes(avoid.toLowerCase())) {
        return { score: -1, reasoning: [`avoided: contains '${avoid}'`] };
      }
    }
  }

  // Boost — PM-specified name patterns
  if (chars.look_for_name_containing) {
    for (const pattern of chars.look_for_name_containing) {
      if (name.includes(pattern.toLowerCase())) {
        score += 30;
        reasoning.push(`name contains '${pattern}'`);
      }
    }
  }

  // Boost — Mixpanel standard events ($session_start, $pageview, etc.)
  if (eventName.startsWith('$')) {
    score += 15;
    reasoning.push('Mixpanel standard event');
  }

  // Boost — volume-indicator words (for highest_unique_users intents)
  if (chars.expected_volume === 'highest_unique_users') {
    const volumeWords = ['session', 'open', 'launch', 'start', 'view', 'load', 'init', 'visit', 'active'];
    for (const word of volumeWords) {
      if (name.includes(word)) {
        score += 20;
        reasoning.push(`volume word: '${word}'`);
        break; // count once
      }
    }
  }

  // Boost — completion words (for after_onboarding timing)
  if (chars.timing === 'after_onboarding') {
    const completionWords = ['complet', 'done', 'finish', 'success', 'activat', 'onboard', 'convert', 'graduate'];
    for (const word of completionWords) {
      if (name.includes(word)) {
        score += 20;
        reasoning.push(`completion word: '${word}'`);
        break;
      }
    }
  }

  // Boost — return/re-entry words (for retained_user intent)
  if (chars.timing === 'return_visit') {
    const returnWords = ['return', 'revisit', 'back', 'session_2', 'repeat', 're_', 'second'];
    for (const word of returnWords) {
      if (name.includes(word)) {
        score += 20;
        reasoning.push(`return word: '${word}'`);
        break;
      }
    }
  }

  // Penalize — noise/test patterns
  const noiseWords = ['test', 'debug', 'internal', 'dev_', '_temp', 'staging', 'mock'];
  for (const noise of noiseWords) {
    if (name.includes(noise)) {
      score -= 25;
      reasoning.push(`noise: '${noise}'`);
    }
  }

  return { score: Math.max(score, 0), reasoning };
}

// ---------------------------------------------------------------------------
// Tier-2: volume scoring (async, API calls — only for low-confidence candidates)
// ---------------------------------------------------------------------------

/**
 * Re-rank top candidates by actual unique user count.
 * Updates scored array in-place, returns the best candidate.
 * @param {object[]} top5      — [{name, score, reasoning}, ...]
 * @param {Function} queryFn   — async (eventName) → number
 * @param {object}   intent
 */
async function applyVolumeScoring(top5, queryFn, intent) {
  const withCounts = await Promise.all(
    top5.map(async (e) => {
      try {
        const count = await queryFn(e.name);
        return { ...e, uniqueCount: count };
      } catch {
        return { ...e, uniqueCount: 0 };
      }
    })
  );

  const byVolume = [...withCounts].sort((a, b) => b.uniqueCount - a.uniqueCount);
  const volumeWinner = byVolume[0];

  if (volumeWinner.uniqueCount < 100) return top5[0]; // not enough signal

  if (volumeWinner.name !== top5[0].name &&
      intent.characteristics?.expected_volume === 'highest_unique_users') {
    // Volume overrides name-score for "most-used" intents
    volumeWinner.score += 25;
    volumeWinner.reasoning = [
      ...volumeWinner.reasoning,
      `highest volume: ${volumeWinner.uniqueCount.toLocaleString()} unique users`,
    ];
    return volumeWinner;
  }

  // Same winner — boost its confidence score
  top5[0].score += 20;
  top5[0].reasoning.push(`volume confirmed: ${volumeWinner.uniqueCount.toLocaleString()} unique users`);
  return top5[0];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve all intents to their best matching Mixpanel events.
 *
 * @param {object}   opts
 * @param {string[]} opts.availableEvents    — all event names from mixpanel_list_events
 * @param {object}   opts.intentDefs         — { intentName: { description, characteristics } }
 * @param {Function} [opts.queryUniqueCount] — async (eventName) → unique user count (tier-2)
 * @returns {Promise<object>} — { intentName: { found, event, confidence, reasoning, alternatives } }
 */
export async function resolveAllIntents({ availableEvents, intentDefs, queryUniqueCount }) {
  if (!intentDefs || Object.keys(intentDefs).length === 0 || availableEvents.length === 0) {
    return {};
  }

  const results = {};

  for (const [intentName, intent] of Object.entries(intentDefs)) {
    // Tier 1: name-pattern scoring
    const scored = availableEvents
      .map(eventName => {
        const { score, reasoning } = scoreEventByName(eventName, intent);
        return { name: eventName, score, reasoning };
      })
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      results[intentName] = {
        found: false,
        message: `No event matched intent '${intentName}'`,
      };
      console.log(`[IntentMapper] '${intentName}' → NOT FOUND (0 candidates after scoring)`);
      continue;
    }

    let best = scored[0];
    const tier1Confidence = Math.min(best.score / MAX_SCORE, 0.99);

    // Tier 2: volume check — only when uncertain AND intent cares about volume
    if (tier1Confidence < 0.65 && queryUniqueCount &&
        intent.characteristics?.expected_volume === 'highest_unique_users') {
      try {
        best = await applyVolumeScoring(scored.slice(0, 5), queryUniqueCount, intent);
      } catch (err) {
        console.warn(`[IntentMapper] Tier-2 failed for '${intentName}': ${err.message}`);
      }
    }

    const finalConfidence = parseFloat(Math.min(best.score / MAX_SCORE, 0.99).toFixed(2));
    results[intentName] = {
      found: true,
      event: best.name,
      confidence: finalConfidence,
      reasoning: best.reasoning,
      alternatives: scored
        .filter(e => e.name !== best.name)
        .slice(0, 2)
        .map(e => e.name),
    };

    console.log(
      `[IntentMapper] '${intentName}' → '${best.name}' ` +
      `(${Math.round(finalConfidence * 100)}%): ${best.reasoning.join(', ')}`
    );
  }

  return results;
}

/**
 * Format resolved intents as a string for injection into discoveryContext.
 * Returns '' if no intents were resolved.
 */
export function formatResolvedIntents(resolved) {
  if (!resolved || Object.keys(resolved).length === 0) return '';

  const lines = ['=== INTENT-RESOLVED EVENTS (auto-discovered for this project) ==='];

  for (const [intentName, result] of Object.entries(resolved)) {
    if (result.found) {
      const pct = Math.round(result.confidence * 100);
      lines.push(`  '${intentName}' → '${result.event}' (${pct}% match)`);
      if (result.reasoning?.length) {
        lines.push(`    Why: ${result.reasoning.join(', ')}`);
      }
      if (result.alternatives?.length) {
        lines.push(`    Alternatives if wrong: ${result.alternatives.join(', ')}`);
      }
    } else {
      lines.push(`  '${intentName}' → NOT FOUND — ${result.message}`);
    }
  }

  lines.push(
    '=== END INTENT-RESOLVED EVENTS ===',
    'PRIORITY: Dictionary explicit mappings > Intent-resolved events > guessing.',
    "confidence ≥ 0.70 → use event silently.",
    "confidence 0.50–0.69 → state: 'Using [event] as proxy for [term] ([pct]% match) — confirm if needed.'",
    "NOT FOUND → ask PM: 'No [term] event found in your project. Which event tracks [term]?'"
  );

  return lines.join('\n');
}
