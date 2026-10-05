# CLAUDE.md

Working instructions for Claude Code in this repository.

## What this is

Sarah is a Slack bot that acts as a data analyst for product managers. A PM asks a question in Slack; Sarah calls Claude with tools that query Mixpanel, Amplitude, Jira and ClickUp directly, and answers in the thread.

There is no web frontend. Slack is the only user interface; `/admin` is a small internal page served by the backend.

## Architecture

```
Slack (Bolt)  ──►  backend/src/slack/handlers.js
                        │
                        ▼
              services/claude.js  ── agentic tool loop, prompt caching
                        │
        ┌───────────────┼────────────────┬──────────────┐
   mixpanel.js     amplitude.js       jira.js        clickup.js
  (Basic Auth)     (Basic Auth)      (OAuth 2.0)    (bearer token)

Postgres (services/db.js): workspaces, encrypted Slack tokens, monitoring config, interaction log
```

Integrations are **direct REST APIs, not MCP**. MCP was the original plan and was dropped because Mixpanel's MCP access was partnership-only. Do not reintroduce MCP code.

## Key files

| Path | Role |
|---|---|
| `backend/src/index.js` | Express server, route mounting, scheduled jobs |
| `backend/src/slack/` | Bolt app, message handlers, Slack formatting |
| `backend/src/services/claude.js` | System prompt assembly, tool loop, prompt caching |
| `backend/prompts/system_prompt.txt` | Global system prompt |
| `backend/src/services/snapshot.js` | Morning Briefing (daily, 07:00 UTC) |
| `backend/src/services/monitoring.js` | Anomaly monitoring (daily, 09:00 UTC) |
| `backend/src/services/intentMapper.js` + `config/intent_definitions.json` | Question-intent routing |
| `backend/src/routes/admin*.js` | Internal admin API and page |

## Rules

- **System prompt priority:** `workspace.system_prompt` in the DB (hot reload, no deploy) → `prompts/system_prompt.txt` → hardcoded fallback. Edit the file for global changes.
- **Prompt caching:** at most 4 `cache_control` blocks per request. Strip `cache_control` from historical tool results before adding new ones (see `claude.js`).
- **Anomaly detection stays in code.** The Morning Briefing is fully deterministic; Claude never writes it. Monitoring uses code to detect and Claude only to phrase the alert.
- **Never invent data.** Any change to answers must keep the prompt's ask-don't-invent and confidence-tier rules intact.
- **Secrets** live only in Railway environment variables. Slack bot tokens are stored encrypted (`services/encryption.js`). Never commit `.env`.

## Run locally

```bash
npm install
cp backend/.env.example backend/.env   # fill in values
npm run dev
```

Required: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `ENCRYPTION_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`. Integration credentials (`MIXPANEL_*`, `JIRA_*`) are needed only for the tools you want to use.

## Deploy

Railway. `backend/railway.toml` runs `node backend/src/index.js` with a `/health` check.
