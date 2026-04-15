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

export async function updateWorkspaceJira(workspaceId, { accessToken, refreshToken, cloudId, expiresAt }) {
  await pool.query(
    `UPDATE workspaces
     SET jira_access_token  = $2,
         jira_refresh_token = $3,
         jira_cloud_id      = $4,
         jira_expires_at    = $5,
         updated_at         = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, accessToken, refreshToken, cloudId, expiresAt]
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
  // Keep only last 20 messages to limit token usage
  const trimmed = history.slice(-20);
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

export default pool;
