import { sendMessageWithTools } from './claude.js';

function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function buildSnapshotPrompt(lang) {
  const today = daysAgo(0);
  const d7 = daysAgo(7);
  const d14 = daysAgo(14);

  const isHe = lang === 'he';

  return `You are generating a brief daily data snapshot for a product team. Today is ${today}.

Run these analyses using the available Mixpanel tools, then produce the snapshot message.

IMPORTANT RULES:
- Use type=unique everywhere (unique users, not event counts)
- Always pass explicit from_date and to_date
- Run queries as efficiently as possible

ANALYSES TO RUN:

1. CONVERSION (current vs previous week):
   - First call mixpanel_list_funnels to get available funnels
   - Pick the first/most important funnel
   - Query mixpanel_funnel for ${d7}–${today} (use the funnel's conversion_window from the list)
   - Query mixpanel_funnel for ${d14}–${d7} with same funnel
   - Calculate % change in overall conversion rate
   - Report if change > 15%, otherwise note "stable"

2. DROP-OFF (from the same funnel data above):
   - Find the step with the lowest step-to-step conversion percentage
   - Always report this step and its conversion %

3. CRITICAL ERRORS:
   - Call mixpanel_list_events to get event names
   - Find events containing "error", "Error", "failed", "timeout", "exception" (case-insensitive)
   - For each found error event, call mixpanel_segmentation with from_date=${d7}, to_date=${today}, type=unique
   - Sum unique users per error event
   - Report any error affecting > 50 unique users

4. RETENTION:
   - Call mixpanel_retention with from_date=${d14}, to_date=${today}
   - Compare day-7 retention of the earlier cohort vs the later cohort
   - Report if change > 15%, otherwise note "stable"

5. TOP SEGMENT:
   - Using the same funnel, query mixpanel_funnel for ${d7}–${today} segmented by a meaningful property if supported, OR query mixpanel_segmentation for the first step event segmented by "properties[\\"$os\\"]" or similar
   - Find segment with largest change vs ${d14}–${d7}
   - Report if change > 15%

After all queries complete, format your response EXACTLY like this (${isHe ? 'in Hebrew' : 'in English'}):

${isHe ? `[time-based greeting] הנה מה שקורה היום 👇

📊 [conversion finding]
🔻 [drop-off finding]
⚠️ [error finding, or skip line if no critical errors]
✅/📉 [retention finding]
📈/📊 [segment finding, or skip if no significant shift]

מה רוצה לחקור?` : `[time-based greeting] Here's what's happening today 👇

📊 [conversion finding]
🔻 [drop-off finding]
⚠️ [error finding, or skip line if no critical errors]
✅/📉 [retention finding]
📈/📊 [segment finding, or skip if no significant shift]

What would you like to explore?`}

Rules:
- Maximum 5 bullet lines
- Use ✅ prefix when a metric is stable (no significant change)
- Use ⚠️ only for errors affecting >50 unique users; skip the line entirely if none found
- If all metrics are stable: output only "${isHe ? 'הכל נראה יציב השבוע — רוצה לצלול לנתון ספציפי?' : 'Everything looks stable this week — want to dig into anything specific?'}"
- If a query fails or returns no data: skip that bullet silently
- Output ONLY the snapshot message — no explanation, no preamble`;
}

export async function generateSnapshot(workspace, lang = 'he') {
  const prompt = buildSnapshotPrompt(lang);
  const result = await sendMessageWithTools(workspace, prompt, []);
  return result.response;
}
