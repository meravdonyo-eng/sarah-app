import express from 'express';
import { buildJiraAuthUrl, exchangeJiraCode } from '../services/jira.js';
import { trackJiraConnected } from '../services/sarahAnalytics.js';

const router = express.Router();

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

// Start Jira OAuth — user is redirected here from Slack button
router.get('/jira/start', (req, res) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return res.status(400).send('Missing workspace_id');

  const url = buildJiraAuthUrl(workspace_id);
  res.redirect(url);
});

// Jira OAuth callback — Atlassian redirects here after user approves
router.get('/jira/callback', async (req, res) => {
  const { code, state: workspaceId, error } = req.query;

  if (error) {
    return res.send(html('Connection Failed', `<p>Error: ${error}</p><p>You can close this window.</p>`));
  }

  if (!code || !workspaceId) {
    return res.status(400).send('Missing code or state');
  }

  try {
    await exchangeJiraCode(code, workspaceId);
    // Gap 3 — Jira Connected event (workspace_id used as distinct_id; no per-user id here)
    trackJiraConnected(workspaceId, workspaceId).catch(() => {});
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
