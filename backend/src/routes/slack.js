/**
 * Slack App Installation (Add to Slack)
 * Handles the OAuth 2.0 flow so each customer workspace installs Sarah.
 */
import express from 'express';
import axios from 'axios';
import { upsertWorkspace } from '../services/db.js';
import { encrypt } from '../services/encryption.js';
import { trackSignUpCompleted, setWorkspaceRevenue } from '../services/sarahAnalytics.js';

const router = express.Router();

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

const SCOPES = [
  'app_mentions:read',
  'chat:write',
  'im:history',
  'im:write',
  'channels:history',
].join(',');

// GET /api/slack/install — redirect to Slack OAuth consent screen
// Accepts UTM params from the landing page and encodes them in `state`
// so they survive the OAuth redirect and can be attached to Sign Up Completed.
router.get('/install', (req, res) => {
  // Capture UTM params passed from the landing page (e.g. ?utm_source=google)
  const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer', 'landing_page'];
  const utmData = {};
  utmKeys.forEach(key => { if (req.query[key]) utmData[key] = req.query[key]; });

  const state = Object.keys(utmData).length > 0
    ? Buffer.from(JSON.stringify(utmData)).toString('base64')
    : '';

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: `${process.env.BACKEND_URL}/api/slack/callback`,
    ...(state ? { state } : {}),
  });
  res.redirect(`${SLACK_AUTHORIZE_URL}?${params}`);
});

// GET /api/slack/callback — Slack redirects here after workspace approves
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.send(html('Installation Cancelled', '<p>Sarah לא הותקנה. ניתן לנסות שוב.</p>'));
  }

  if (!code) return res.status(400).send('Missing code');

  try {
    const redirectUri = `${process.env.BACKEND_URL}/api/slack/callback`;
    console.log('Slack callback — code received, exchanging token...');
    console.log('redirect_uri used:', redirectUri);

    const response = await axios.post(
      SLACK_TOKEN_URL,
      new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data = response.data;
    console.log('Slack token response ok:', data.ok, '| error:', data.error);

    if (!data.ok) throw new Error(data.error || 'Slack OAuth failed');

    const workspaceId = data.team.id;
    const teamName = data.team.name;
    const botToken = data.access_token;

    console.log('Installing workspace:', workspaceId, teamName);
    console.log('Bot token received:', !!botToken);

    await upsertWorkspace({
      workspaceId,
      teamName,
      botToken: encrypt(botToken),
    });

    console.log('✅ Workspace installed:', workspaceId);

    // Decode UTM params that were passed through OAuth state
    let utmProps = {};
    if (state) {
      try { utmProps = JSON.parse(Buffer.from(state, 'base64').toString('utf8')); } catch {}
    }

    // Gap 1 — Sign Up Completed + Gap 5 — set initial revenue profile
    trackSignUpCompleted(workspaceId, teamName, utmProps).catch(() => {});
    setWorkspaceRevenue(workspaceId, 'free').catch(() => {});

    res.send(html(
      'Sarah מותקנת!',
      `<p>✅ Sarah נוספה לworkspace <strong>${teamName}</strong> בהצלחה!</p>
       <p>פתחי Slack ושלחי הודעה ל-Sarah כדי להתחיל.</p>`
    ));
  } catch (err) {
    console.error('❌ Slack install error:', err.message);
    if (err.response?.data) console.error('API response:', JSON.stringify(err.response.data));
    res.status(500).send(html('Installation Error', `<p>${err.message}</p>`));
  }
});

function html(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <meta charset="utf-8">
  <style>
    body { font-family: system-ui; padding: 60px; text-align: center; background: #f5f5f5; }
    h1 { color: #1a1a1a; } p { color: #555; font-size: 18px; }
    strong { color: #1a1a1a; }
  </style>
</head>
<body><h1>${title}</h1>${body}</body>
</html>`;
}

export default router;
