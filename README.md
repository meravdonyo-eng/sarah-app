# Sarah — an AI data analyst for product managers, inside Slack

Sarah answers product questions in Slack by pulling live data from Mixpanel, Amplitude, Jira and ClickUp, and explaining what changed, why, and how confident she is.

Built solo by [Merav Donyo](https://meravdonyo.life): product, UX, system prompt and code (agent-driven, with Claude Code).

**Status:** reached closed beta, running on synthetic data inside real Mixpanel and Jira workspaces. Development paused when Anthropic launched Claude Tag (native Claude in Slack), which overlaps directly with Sarah's core value.

---

## How it works

```
Slack  ──►  Node.js backend (Railway)  ──►  Claude (tool use)
                     │
                     ├── Mixpanel / Amplitude   (HTTP Basic Auth)
                     ├── Jira                   (OAuth 2.0)
                     └── ClickUp                (bearer token)
```

- **Direct API integrations, not MCP.** MCP was the original plan, but Mixpanel's MCP access was partnership-only, so the integrations were rebuilt as direct API tools.
- **Prompt caching** across tool-result batches to keep long analysis loops cheap.

## Proactive features

| | Morning Briefing | Monitoring Engine |
|---|---|---|
| Runs | Daily, 07:00 UTC | Daily, 09:00 UTC |
| Detection | Deterministic code (8 parallel queries, timeouts + fallbacks) | Deterministic anomaly detection |
| Claude's role | None, fully templated | Writes the final alert, enriched with Jira context |
| Extras | Per-workspace channel | Cooldown and quiet hours |

Anomaly detection is deliberately kept out of the model: code decides *whether* something is wrong, Claude only explains it.

## The prompt

The system prompt went through seven phases, from a screenshot-only proof of concept to live data, iterated with real PM testers. Key mechanisms:

- **Ask, don't invent.** No numbers that weren't fetched.
- **Clarification protocol.** Up to 4 rounds before answering an ambiguous question.
- **Proxy ladder.** When the direct metric is missing, falls back through segment → device → timing → Jira.
- **Confidence tiers.** Every finding is tagged Confirmed / Likely / Hypothesis.
- **Continuity with re-fetch.** Follow-up questions re-pull data instead of trusting earlier turns.

**Validation:** Sarah was tested head-to-head against raw Claude, both connected to the same data, on hard PM questions, and iterated until Sarah clearly outperformed it.

## Repo

- `backend/` — Slack bot, integrations, scheduled jobs
- `CLAUDE.md` — the working instructions Claude Code builds from

## Links

- Product: [sarahwhy.com](https://sarahwhy.com)
- Portfolio and case study: [meravdonyo.life](https://meravdonyo.life)
