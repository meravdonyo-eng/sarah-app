/**
 * ownerAlerts.js — Sarah product-owner alert system
 *
 * Sends alerts ONLY to the product owner (not to workspace admins).
 * Two channels: email (via Slack's email feature or nodemailer) + Slack DM.
 *
 * Required env vars:
 *   OWNER_SLACK_USER_ID   — e.g. U012ABCDEF
 *   OWNER_EMAIL           — e.g. sarah-alerts@yourdomain.com
 *   MONTHLY_API_BUDGET    — e.g. 50  (dollars)
 *   API_ALERT_WARN        — default 0.80
 *   API_ALERT_URGENT      — default 0.95
 *   SENDGRID_API_KEY      — optional, for email alerts (leave blank to skip email)
 */

import axios from 'axios';

// ---------------------------------------------------------------------------
// Internal: Slack DM to owner
// ---------------------------------------------------------------------------

async function slackDmOwner(text) {
  const userId = process.env.OWNER_SLACK_USER_ID;
  const token  = process.env.SLACK_BOT_TOKEN;
  if (!userId || !token) return;

  try {
    // Open DM channel with owner
    const dmRes = await axios.post(
      'https://slack.com/api/conversations.open',
      { users: userId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const channelId = dmRes.data?.channel?.id;
    if (!channelId) return;

    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: channelId, text },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.warn('[OwnerAlert] Slack DM failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal: email via SendGrid (optional)
// ---------------------------------------------------------------------------

async function sendEmail(subject, body) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const toEmail = process.env.OWNER_EMAIL;
  if (!apiKey || !toEmail) return; // email not configured — skip silently

  try {
    await axios.post(
      'https://api.sendgrid.com/v3/mail/send',
      {
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: toEmail, name: 'Sarah Alerts' },
        subject,
        content: [{ type: 'text/plain', value: body }],
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.warn('[OwnerAlert] Email failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public: sendOwnerAlert
// ---------------------------------------------------------------------------

/**
 * Send an alert to the product owner via Slack DM and/or email.
 * Never throws — alert failures must not affect users.
 *
 * @param {object} opts
 * @param {string} opts.subject — short subject line (used for email + Slack header)
 * @param {string} opts.body    — full message body
 * @param {'WARNING'|'URGENT'} [opts.level] — affects emoji prefix in Slack
 * @param {string[]} [opts.channels] — ['slack_dm', 'email'] (default: both)
 */
export async function sendOwnerAlert({ subject, body, level = 'WARNING', channels = ['slack_dm', 'email'] }) {
  const emoji  = level === 'URGENT' ? '🚨' : '⚠️';
  const slackMsg = `${emoji} *${subject}*\n${body}`;

  const tasks = [];
  if (channels.includes('slack_dm')) tasks.push(slackDmOwner(slackMsg));
  if (channels.includes('email'))    tasks.push(sendEmail(`${emoji} ${subject}`, body));

  await Promise.allSettled(tasks); // never throws
  console.log(`[OwnerAlert][${level}] ${subject}`);
}

// ---------------------------------------------------------------------------
// Alert A — API budget check (call before each Claude API request)
// ---------------------------------------------------------------------------

/**
 * Check monthly API spend and alert owner if thresholds are crossed.
 * Call this before each Claude API request.
 *
 * @param {number} currentSpendUsd — total spend so far this month in USD
 * @returns {boolean} true if budget is exceeded (caller should block the request)
 */
const alertedThresholds = new Set(); // avoid spamming the same alert

export async function checkApibudget(currentSpendUsd) {
  const budget     = parseFloat(process.env.MONTHLY_API_BUDGET || '50');
  const warnLevel  = parseFloat(process.env.API_ALERT_WARN    || '0.80');
  const urgentLevel= parseFloat(process.env.API_ALERT_URGENT  || '0.95');
  const ratio = currentSpendUsd / budget;

  if (ratio >= urgentLevel && !alertedThresholds.has('urgent')) {
    alertedThresholds.add('urgent');
    sendOwnerAlert({
      level: 'URGENT',
      subject: 'Sarah API — 95% budget — ACTION NEEDED',
      body: `Used: $${currentSpendUsd.toFixed(2)} of $${budget}. Top up now or Sarah will stop responding.`,
      channels: ['slack_dm', 'email'],
    }).catch(() => {});
    return true; // budget effectively exhausted — block
  }

  if (ratio >= warnLevel && !alertedThresholds.has('warn')) {
    alertedThresholds.add('warn');
    sendOwnerAlert({
      level: 'WARNING',
      subject: 'Sarah API — 80% budget used',
      body: `Used: $${currentSpendUsd.toFixed(2)} of $${budget}. Consider topping up.`,
      channels: ['slack_dm', 'email'],
    }).catch(() => {});
  }

  return false; // budget ok
}

// Reset alert state monthly (called from a daily/monthly cron or on process start)
export function resetMonthlyAlerts() {
  alertedThresholds.clear();
}

// ---------------------------------------------------------------------------
// Alert C — OAuth token refresh daemon (call on startup, runs every 4h)
// ---------------------------------------------------------------------------

import { getAllWorkspaces } from './db.js';
import { decrypt } from './encryption.js';

// Fix 1 — dedup: only alert once per workspace per 7 days
// (cleared on successful refresh so a new failure will alert again)
const failureAlerted = new Map(); // workspaceId → timestamp of last alert sent
const ALERT_DEDUP_MS = 7 * 24 * 60 * 60 * 1000;

let refreshDaemonStarted = false;

export function startTokenRefreshDaemon() {
  if (refreshDaemonStarted) return;
  refreshDaemonStarted = true;

  async function runRefresh() {
    try {
      const workspaces = await getAllWorkspaces();
      const FIVE_MIN_MS = 5 * 60 * 1000;
      const now = Date.now();

      for (const ws of workspaces) {
        if (!ws.jira_access_token || !ws.jira_refresh_token) continue;
        const expiresAt = parseInt(ws.jira_expires_at || '0');
        if (expiresAt - now > FIVE_MIN_MS) continue; // still valid

        try {
          // Dynamic import to avoid circular dependency
          const { refreshJiraToken } = await import('./jira.js');
          await refreshJiraToken({
            refreshToken: decrypt(ws.jira_refresh_token),
            workspaceId: ws.workspace_id,
          });
          // Fix 3 — removed `_ = refreshed` (token is saved inside refreshJiraToken)
          console.log(`[TokenDaemon] Refreshed Jira token for workspace ${ws.workspace_id}`);
          // Clear dedup flag so a future failure will alert again
          failureAlerted.delete(ws.workspace_id);
        } catch (err) {
          console.error(`[TokenDaemon] Refresh failed for ${ws.workspace_id}:`, err.message);

          // Fix 1 — only alert once per workspace; skip if already alerted recently
          const lastAlerted = failureAlerted.get(ws.workspace_id);
          if (lastAlerted && now - lastAlerted < ALERT_DEDUP_MS) continue;
          failureAlerted.set(ws.workspace_id, now);

          sendOwnerAlert({
            subject: `OAuth refresh failed: workspace ${ws.workspace_id}`,
            body: `Tool: Jira. Error: ${err.message}\nUser will be prompted to reconnect next time they message Sarah.`,
            channels: ['slack_dm'],
          }).catch(() => {});

          // Fix 2 — NO user DM from daemon.
          // Users are notified via handlers.js (jiraAuthFailed path) the next
          // time they send a message — not proactively by the daemon.
        }
      }
    } catch (err) {
      console.error('[TokenDaemon] Run failed:', err.message);
    }
  }

  // Run immediately on startup, then every 4 hours
  runRefresh();
  setInterval(runRefresh, 4 * 60 * 60 * 1000);
  console.log('[TokenDaemon] Started — runs every 4h');
}
