import express from 'express';
import { WebClient } from '@slack/web-api';
import { buildJiraAuthUrl, exchangeJiraCode } from '../services/jira.js';
import { trackJiraConnected } from '../services/sarahAnalytics.js';
import { getWorkspace } from '../services/db.js';
import { decrypt } from '../services/encryption.js';

const router = express.Router();

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

// Start Jira OAuth — user is redirected here from Slack button
router.get('/jira/start', (req, res) => {
  const { workspace_id, channel_id } = req.query;
  if (!workspace_id) return res.status(400).send('Missing workspace_id');

  const url = buildJiraAuthUrl(workspace_id, channel_id || '');
  res.redirect(url);
});

// Jira OAuth callback — Atlassian redirects here after user approves
router.get('/jira/callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;

  if (error) {
    return res.send(html('Connection Failed', `<p>Error: ${error}</p><p>You can close this window.</p>`));
  }

  if (!code || !rawState) {
    return res.status(400).send('Missing code or state');
  }

  // State may be "workspaceId" or "workspaceId|channelId"
  const [workspaceId, channelId] = rawState.split('|');

  try {
    await exchangeJiraCode(code, workspaceId);
    // Gap 3 — Jira Connected event (workspace_id used as distinct_id; no per-user id here)
    trackJiraConnected(workspaceId, workspaceId).catch(() => {});

    // Send Slack confirmation to the channel that initiated the connection
    if (channelId) {
      sendJiraConnectedSlackMessage(workspaceId, channelId).catch(err =>
        console.warn('[OAuthCallback] Slack confirmation failed:', err.message)
      );
    }

    res.send(html('Jira Connected!', `
      <p>✅ Jira חובר בהצלחה!</p>
      <p>אפשר לחזור לSlack ולהתחיל לשאול שאלות.</p>
      <script>setTimeout(() => window.close(), 3000);</script>
    `));
  } catch (err) {
    console.error('Jira OAuth error:', err);
    res.status(500).send(html('Error', `<p>Something went wrong: ${err.message}</p>`));
  }
});

/**
 * Post a Slack confirmation message after Jira is successfully connected.
 * Runs fire-and-forget — never blocks the OAuth redirect response.
 */
async function sendJiraConnectedSlackMessage(workspaceId, channelId) {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace?.bot_token) return;

  const slack = new WebClient(decrypt(workspace.bot_token));
  await slack.chat.postMessage({
    channel: channelId,
    text: '✅ *Jira connected!* I now have access to your Jira projects.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ *Jira connected!* I now have access to your Jira projects.\n\nYou can ask me things like:\n• "Show open P1 bugs"\n• "What tickets were updated today?"\n• "How many users are affected by PROJ-123?"',
        },
      },
    ],
  });
  console.log(`[OAuthCallback] Jira connected Slack confirmation sent → workspace=${workspaceId} channel=${channelId}`);
}

function html(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    body { font-family: system-ui; padding: 60px; text-align: center; background: #f5f5f5; }
    h1 { color: #1a1a1a; }
    p { color: #555; font-size: 18px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}

export default router;
