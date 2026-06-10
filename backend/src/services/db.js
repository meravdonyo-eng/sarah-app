import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id        TEXT PRIMARY KEY,
      team_name           TEXT,
      bot_token           TEXT NOT NULL,
      system_prompt       TEXT,
      mixpanel_project_id TEXT,
      mixpanel_username   TEXT,
      mixpanel_secret     TEXT,
      jira_access_token   TEXT,
      jira_refresh_token  TEXT,
      jira_cloud_id       TEXT,
      jira_expires_at     BIGINT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id            SERIAL PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(workspace_id),
      slack_user_id TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      history       JSONB NOT NULL DEFAULT '[]',
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conversations_unique
      ON conversations(workspace_id, slack_user_id, channel_id);

    CREATE TABLE IF NOT EXISTS user_welcome_dates (
      workspace_id  TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      last_date     DATE NOT NULL,
      PRIMARY KEY (workspace_id, slack_user_id)
    );

    CREATE TABLE IF NOT EXISTS user_flags (
      workspace_id  TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      flag_name     TEXT NOT NULL,
      PRIMARY KEY (workspace_id, slack_user_id, flag_name)
    );

    CREATE TABLE IF NOT EXISTS read_more_store (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS jira_default_project TEXT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS jira_cloud_url TEXT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS morning_channel TEXT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS event_dictionary JSONB;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS amplitude_api_key TEXT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS amplitude_secret_key TEXT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS clickup_api_token TEXT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS clickup_team_id TEXT;

    CREATE TABLE IF NOT EXISTS api_usage (
      workspace_id  TEXT NOT NULL,
      month         TEXT NOT NULL,            -- 'YYYY-MM'
      input_tokens  BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, month)
    );

    -- Proactive monitoring: per-workspace metric monitor configurations
    CREATE TABLE IF NOT EXISTS monitor_configs (
      workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
      monitor_id     TEXT NOT NULL,
      metric_label   TEXT,
      metric         JSONB NOT NULL,
      baseline       JSONB NOT NULL DEFAULT '{"method":"trailing_weekday","window":4}',
      threshold      JSONB NOT NULL DEFAULT '{"type":"pct_change","direction":"both","value":0.10}',
      schedule       TEXT NOT NULL DEFAULT 'daily_09:00',
      channel        TEXT NOT NULL,
      quiet_hours    JSONB,
      daily_cap      INTEGER NOT NULL DEFAULT 3,
      cooldown_hours INTEGER NOT NULL DEFAULT 24,
      status         TEXT NOT NULL DEFAULT 'active',
      muted_until    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (workspace_id, monitor_id)
    );

    -- Proactive monitoring: fire log — dedup_key + severity ONLY, NO metric values
    CREATE TABLE IF NOT EXISTS monitor_fire_log (
      id            SERIAL PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      monitor_id    TEXT NOT NULL,
      dedup_key     TEXT NOT NULL,
      severity      TEXT NOT NULL,
      fired_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS monitor_fire_log_dedup
      ON monitor_fire_log(workspace_id, dedup_key, fired_at DESC);

    -- Zero-input KPI: one row per PM query turn
    -- outcome: answered | named_gap | asked_for_input
    -- gap_type: connector | instrumentation | empty_window | none
    CREATE TABLE IF NOT EXISTS zero_input_log (
      id            SERIAL PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      slack_user_id TEXT,
      query_type    TEXT,
      outcome       TEXT NOT NULL,
      gap_type      TEXT,
      missing_ref   TEXT,
      logged_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS zero_input_log_workspace
      ON zero_input_log(workspace_id, logged_at DESC);

    -- Interaction store: per-user query metadata for continuity context.
    -- MUST NOT contain metric values or user-level product data — qualitative only.
    -- Retained 90 days (same policy as conversations). Covered by GDPR erasure.
    CREATE TABLE IF NOT EXISTS user_interactions (
      interaction_id TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
      workspace_id   TEXT        NOT NULL REFERENCES workspaces(workspace_id),
      user_id        TEXT        NOT NULL,
      ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      query_text     TEXT        NOT NULL,
      metric_ref     TEXT,        -- e.g. "mixpanel.funnel.checkout"
      topic_tags     TEXT[],      -- e.g. ARRAY['conversion','checkout']
      sarah_notes    TEXT,        -- qualitative framing only, NO metric values
      PRIMARY KEY (workspace_id, user_id, interaction_id)
    );

    CREATE INDEX IF NOT EXISTS user_interactions_lookup
      ON user_interactions(workspace_id, user_id, ts DESC);

    CREATE INDEX IF NOT EXISTS user_interactions_metric
      ON user_interactions(workspace_id, metric_ref)
      WHERE metric_ref IS NOT NULL;
  `);

  console.log('DB initialized');
}

// Workspaces
export async function upsertWorkspace({ workspaceId, teamName, botToken }) {
  const { rows } = await pool.query(
    `INSERT INTO workspaces (workspace_id, team_name, bot_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id) DO UPDATE
       SET team_name = EXCLUDED.team_name,
           bot_token = EXCLUDED.bot_token,
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, teamName, botToken]
  );
  return rows[0];
}

export async function getWorkspace(workspaceId) {
  const { rows } = await pool.query(
    'SELECT * FROM workspaces WHERE workspace_id = $1',
    [workspaceId]
  );
  return rows[0] || null;
}

export async function updateWorkspaceMixpanel(workspaceId, { projectId, username, secret }) {
  await pool.query(
    `UPDATE workspaces
     SET mixpanel_project_id = $2,
         mixpanel_username   = $3,
         mixpanel_secret     = $4,
         updated_at          = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, projectId, username, secret]
  );
}

export async function updateWorkspaceAmplitude(workspaceId, { apiKey, secretKey }) {
  await pool.query(
    `UPDATE workspaces
     SET amplitude_api_key    = $2,
         amplitude_secret_key = $3,
         updated_at           = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, apiKey, secretKey]
  );
}

export async function updateWorkspaceClickup(workspaceId, { apiToken, teamId }) {
  await pool.query(
    `UPDATE workspaces
     SET clickup_api_token = $2,
         clickup_team_id   = $3,
         updated_at        = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, apiToken, teamId]
  );
}

export async function clearClickupCredentials(workspaceId) {
  await pool.query(
    `UPDATE workspaces
     SET clickup_api_token = NULL,
         clickup_team_id   = NULL,
         updated_at        = NOW()
     WHERE workspace_id = $1`,
    [workspaceId]
  );
}

export async function clearAmplitudeCredentials(workspaceId) {
  await pool.query(
    `UPDATE workspaces
     SET amplitude_api_key    = NULL,
         amplitude_secret_key = NULL,
         updated_at           = NOW()
     WHERE workspace_id = $1`,
    [workspaceId]
  );
}

export async function clearMixpanelCredentials(workspaceId) {
  await pool.query(
    `UPDATE workspaces
     SET mixpanel_project_id = NULL,
         mixpanel_username   = NULL,
         mixpanel_secret     = NULL,
         updated_at          = NOW()
     WHERE workspace_id = $1`,
    [workspaceId]
  );
}

export async function updateWorkspaceJira(workspaceId, { accessToken, refreshToken, cloudId, expiresAt, cloudUrl }) {
  await pool.query(
    `UPDATE workspaces
     SET jira_access_token  = $2,
         jira_refresh_token = $3,
         jira_cloud_id      = COALESCE($4, jira_cloud_id),
         jira_expires_at    = $5,
         jira_cloud_url     = COALESCE($6, jira_cloud_url),
         updated_at         = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, accessToken, refreshToken, cloudId || null, expiresAt, cloudUrl || null]
  );
}

export async function updateWorkspaceJiraProject(workspaceId, projectKey) {
  await pool.query(
    `UPDATE workspaces SET jira_default_project = $2, updated_at = NOW() WHERE workspace_id = $1`,
    [workspaceId, projectKey || null]
  );
}

export async function updateWorkspaceSystemPrompt(workspaceId, systemPrompt) {
  await pool.query(
    `UPDATE workspaces SET system_prompt = $2, updated_at = NOW() WHERE workspace_id = $1`,
    [workspaceId, systemPrompt]
  );
}

// Conversation history per user per channel
export async function getConversationHistory(workspaceId, slackUserId, channelId) {
  const { rows } = await pool.query(
    `SELECT history FROM conversations
     WHERE workspace_id = $1 AND slack_user_id = $2 AND channel_id = $3`,
    [workspaceId, slackUserId, channelId]
  );
  return rows[0]?.history || [];
}

export async function saveConversationHistory(workspaceId, slackUserId, channelId, history) {
  // Keep only last 10 messages to limit token usage.
  // Tool result messages from Mixpanel/Jira can be 3000-8000 tokens each;
  // 20 messages was regularly causing 429 rate-limit errors.
  const trimmed = history.slice(-10);
  await pool.query(
    `INSERT INTO conversations (workspace_id, slack_user_id, channel_id, history)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, slack_user_id, channel_id) DO UPDATE
       SET history = EXCLUDED.history,
           updated_at = NOW()`,
    [workspaceId, slackUserId, channelId, JSON.stringify(trimmed)]
  );
}

export async function clearConversationHistory(workspaceId, slackUserId, channelId) {
  await pool.query(
    `DELETE FROM conversations
     WHERE workspace_id = $1 AND slack_user_id = $2 AND channel_id = $3`,
    [workspaceId, slackUserId, channelId]
  );
}

// Welcome message — once per day per user (atomic upsert)
export async function checkAndMarkWelcome(workspaceId, slackUserId) {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `INSERT INTO user_welcome_dates (workspace_id, slack_user_id, last_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, slack_user_id) DO UPDATE
       SET last_date = EXCLUDED.last_date
       WHERE user_welcome_dates.last_date < EXCLUDED.last_date::date
     RETURNING last_date`,
    [workspaceId, slackUserId, today]
  );
  return rows.length > 0; // true = welcome was inserted/updated = should send
}

// Clear Jira token when it expires or is revoked
export async function clearJiraToken(workspaceId) {
  await pool.query(
    `UPDATE workspaces
     SET jira_access_token  = NULL,
         jira_refresh_token = NULL,
         jira_cloud_id      = NULL,
         jira_expires_at    = NULL,
         updated_at         = NOW()
     WHERE workspace_id = $1`,
    [workspaceId]
  );
}

// User flags — one-time events (e.g. first_connection_message_shown)
export async function getUserFlag(workspaceId, slackUserId, flagName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_flags
     WHERE workspace_id = $1 AND slack_user_id = $2 AND flag_name = $3`,
    [workspaceId, slackUserId, flagName]
  );
  return rows.length > 0;
}

export async function setUserFlag(workspaceId, slackUserId, flagName) {
  await pool.query(
    `INSERT INTO user_flags (workspace_id, slack_user_id, flag_name)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, slackUserId, flagName]
  );
}

// Read more store — persists across server restarts
export async function dbStoreReadMore(id, content) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  console.log(`[ReadMore] Storing id=${id} contentLen=${content.length} expiresAt=${expiresAt.toISOString()}`);
  await pool.query(
    `INSERT INTO read_more_store (id, content, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, expires_at = EXCLUDED.expires_at`,
    [id, content, expiresAt]
  );
  console.log(`[ReadMore] Stored OK id=${id}`);
}

export async function dbPopReadMore(id) {
  console.log(`[ReadMore] Popping id=${id}`);
  const { rows } = await pool.query(
    `DELETE FROM read_more_store WHERE id = $1 AND expires_at > NOW() RETURNING content`,
    [id]
  );
  const found = rows[0]?.content ?? null;
  console.log(`[ReadMore] Pop result for id=${id}: ${found ? `found (len=${found.length})` : 'NOT FOUND'}`);
  return found;
}

// Non-destructive read — used for Read more / Read less toggle (content stays until TTL)
export async function dbGetReadMore(id) {
  const { rows } = await pool.query(
    `SELECT content FROM read_more_store WHERE id = $1 AND expires_at > NOW()`,
    [id]
  );
  return rows[0]?.content ?? null;
}

// All workspaces — for token refresh daemon
export async function getAllWorkspaces() {
  const { rows } = await pool.query('SELECT * FROM workspaces');
  return rows;
}

// Event Dictionary — per-workspace mapping of event names to human-readable descriptions
export async function updateWorkspaceEventDictionary(workspaceId, dictionary) {
  await pool.query(
    `UPDATE workspaces SET event_dictionary = $2, updated_at = NOW() WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify(dictionary)]
  );
}

export async function addEventToDictionary(workspaceId, eventName, description) {
  await pool.query(
    `UPDATE workspaces
     SET event_dictionary = COALESCE(event_dictionary, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, eventName, description]
  );
}

// Per-tenant API cost tracking
export async function incrementApiUsage(workspaceId, inputTokens, outputTokens) {
  const month   = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  // Claude Sonnet 4 pricing: $3/M input, $15/M output
  const cost    = (inputTokens * 0.000003) + (outputTokens * 0.000015);
  await pool.query(
    `INSERT INTO api_usage (workspace_id, month, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, month) DO UPDATE
       SET input_tokens  = api_usage.input_tokens  + EXCLUDED.input_tokens,
           output_tokens = api_usage.output_tokens + EXCLUDED.output_tokens,
           cost_usd      = api_usage.cost_usd      + EXCLUDED.cost_usd`,
    [workspaceId, month, inputTokens, outputTokens, cost]
  );
  return cost;
}

export async function getMonthlyUsage(workspaceId) {
  const month = new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_usage
     WHERE workspace_id = $1 AND month = $2`,
    [workspaceId, month]
  );
  return parseFloat(rows[0]?.total || '0');
}

export async function getTotalMonthlyUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_usage WHERE month = $1`,
    [month]
  );
  return parseFloat(rows[0]?.total || '0');
}

// GDPR — Right to Erasure: delete all personal data for a specific user
export async function deleteUserAllData(workspaceId, slackUserId) {
  await pool.query(
    'DELETE FROM conversations WHERE workspace_id = $1 AND slack_user_id = $2',
    [workspaceId, slackUserId]
  );
  await pool.query(
    'DELETE FROM user_welcome_dates WHERE workspace_id = $1 AND slack_user_id = $2',
    [workspaceId, slackUserId]
  );
  await pool.query(
    'DELETE FROM user_flags WHERE workspace_id = $1 AND slack_user_id = $2',
    [workspaceId, slackUserId]
  );
  await pool.query(
    'DELETE FROM user_interactions WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, slackUserId]
  );
  await pool.query(
    'DELETE FROM zero_input_log WHERE workspace_id = $1 AND slack_user_id = $2',
    [workspaceId, slackUserId]
  );
}

// GDPR — Retention policy: delete conversations older than N days
export async function deleteOldConversations(daysOld = 90) {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const { rowCount } = await pool.query(
    'DELETE FROM conversations WHERE updated_at < $1',
    [cutoff]
  );
  return rowCount;
}

export default pool;
