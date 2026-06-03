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

// GET /api/slack/consent — data processing disclosure before installation
// Workspace admins see this page before clicking "Add to Slack"
router.get('/consent', (req, res) => {
  // Pass all query params (UTM etc.) through to /install
  const passthrough = new URLSearchParams(req.query).toString();
  const installUrl = `/api/slack/install${passthrough ? `?${passthrough}` : ''}`;

  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sarah — Data Processing Disclosure</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f7f8fa; color: #1a1a2e; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 620px; width: 100%; padding: 48px 40px; }
    .logo { font-size: 32px; margin-bottom: 8px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: #666; font-size: 15px; margin-bottom: 32px; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 12px; }
    .item { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; font-size: 15px; color: #333; line-height: 1.5; }
    .item .icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
    .highlight { background: #fff8e1; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 14px; color: #555; margin-bottom: 28px; line-height: 1.6; }
    .btn { display: block; width: 100%; padding: 16px; background: #4F46E5; color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; text-decoration: none; text-align: center; margin-bottom: 12px; transition: background 0.2s; }
    .btn:hover { background: #4338CA; }
    .btn-secondary { background: transparent; border: 1.5px solid #ddd; color: #555; font-weight: 500; }
    .btn-secondary:hover { background: #f5f5f5; }
    .footer { font-size: 12px; color: #aaa; text-align: center; margin-top: 16px; line-height: 1.6; }
    .footer a { color: #4F46E5; text-decoration: none; }
    .divider { border: none; border-top: 1px solid #eee; margin: 28px 0; }
    [dir="ltr"] { text-align: left; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">🤖</div>
  <h1>לפני שמתחילים — שקיפות מלאה</h1>
  <p class="subtitle">Sarah is a Product Intelligence Partner powered by Claude AI (Anthropic).<br>
  כאדמין של ה-workspace, חשוב שתדע מה Sarah ניגשת אליו.</p>

  <div class="section">
    <h2>📊 Data Sarah reads & sends to Claude AI</h2>

    <div class="item">
      <span class="icon">💬</span>
      <span><strong>Slack messages</strong> — messages sent to Sarah in DMs and private channels. Never public channels.</span>
    </div>
    <div class="item">
      <span class="icon">📈</span>
      <span><strong>Mixpanel / Amplitude</strong> — aggregated analytics data only (event counts, funnel rates, retention). No individual user lists or emails.</span>
    </div>
    <div class="item">
      <span class="icon">🎫</span>
      <span><strong>Jira</strong> — issue titles, status, priority, assignee names. Ticket descriptions (may include customer-reported details) are included when relevant to the question.</span>
    </div>
    <div class="item">
      <span class="icon">✅</span>
      <span><strong>ClickUp</strong> — task names and statuses when queried.</span>
    </div>
    <div class="item">
      <span class="icon">🗂️</span>
      <span><strong>Conversation history</strong> — last 10 messages stored per user for context. Auto-deleted after 90 days.</span>
    </div>
  </div>

  <div class="highlight">
    ⚠️ <strong>חשוב לדעת:</strong> כל שאילתה שמשתמש שולח לשרה עשויה לכלול נתוני Jira / Mixpanel הרלוונטיים לשאלה, ולעבור ל-Anthropic (Claude AI) לצורך עיבוד. Anthropic פועלת כ-Data Processor תחת DPA מסחרי עם לקוחות API. הנתונים אינם משמשים לאימון מודלים.
  </div>

  <div class="section">
    <h2>🔒 How data is protected</h2>
    <div class="item"><span class="icon">🔑</span><span>All stored credentials are encrypted (AES-256-GCM)</span></div>
    <div class="item"><span class="icon">🏢</span><span>Complete workspace isolation — no data shared between organizations</span></div>
    <div class="item"><span class="icon">🗑️</span><span>Users can delete their data anytime by typing <em>"delete my data"</em> in Slack</span></div>
    <div class="item"><span class="icon">📅</span><span>Conversation history auto-deleted after 90 days</span></div>
  </div>

  <hr class="divider">

  <a href="${installUrl}" class="btn">
    ✅ I understand — Add Sarah to Slack
  </a>
  <a href="javascript:history.back()" class="btn btn-secondary">Cancel</a>

  <p class="footer">
    By installing Sarah, you confirm that your organization's use of Jira, Mixpanel, and other connected tools is covered by your agreements with those providers, and that you accept Anthropic's
    <a href="https://www.anthropic.com/legal/data-processing-addendum" target="_blank">Data Processing Addendum</a>.<br><br>
    Questions? Contact your Sarah administrator.
  </p>
</div>
</body>
</html>`);
});

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

    const safeTeamName = teamName.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
    res.send(html(
      'Sarah installed!',
      `<p>✅ Sarah was successfully added to workspace <strong>${safeTeamName}</strong></p>
       <p>Open Slack and send Sarah a message to get started.</p>
       <hr style="margin:28px 0;border:none;border-top:1px solid #eee;">
       <p style="font-size:13px;color:#888;line-height:1.7;">
         📋 <strong>Data processing reminder:</strong> Sarah uses Claude AI (Anthropic) to process queries.
         Messages and connected tool data (Jira, Mixpanel, etc.) are sent to Anthropic as a Data Processor
         under their <a href="https://www.anthropic.com/legal/data-processing-addendum" style="color:#4F46E5;">DPA</a>.
         Data is never used to train AI models. Users can type <em>"delete my data"</em> in Slack to remove their history.
       </p>`
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
