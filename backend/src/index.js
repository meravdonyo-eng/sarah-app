import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import { initDb, getWorkspace, deleteOldConversations } from './services/db.js';
import { runScheduledChecks } from './services/monitoring.js';
import { decrypt } from './services/encryption.js';
import { handleMessage, handleAppMention, handleAction, handleAppHomeOpened, handleSarahCommand, handleSarahSettingsSubmission } from './slack/handlers.js';
import { startTokenRefreshDaemon } from './services/ownerAlerts.js';
import oauthRouter from './routes/oauth.js';
import agentRouter from './routes/agent.js';
import slackRouter from './routes/slack.js';
import adminRouter from './routes/admin.js';
import adminUiRouter from './routes/adminUi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env'), override: true });

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// --- Multi-workspace authorize: fetches token from DB per workspace ---
async function authorize({ teamId }) {
  const workspace = await getWorkspace(teamId);
  if (!workspace) throw new Error(`Workspace ${teamId} not installed`);
  return { botToken: decrypt(workspace.bot_token) };
}

// --- Slack Bolt with Express receiver ---
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const slackApp = new App({
  authorize,
  receiver,
});

// Slack event handlers
slackApp.message(async ({ message, say, client, context }) => {
  if (message.subtype) return;
  await handleMessage({ message, say, client, context });
});

slackApp.event('app_mention', async ({ event, say, client, context }) => {
  await handleAppMention({ event, say, client, context });
});

slackApp.action(/.*/, async ({ action, ack, say, body, context, client }) => {
  await handleAction({ action, ack, say, body, context, client });
});

slackApp.event('app_home_opened', async ({ event, client, context }) => {
  if (event.tab === 'messages') {
    await handleAppHomeOpened({ event, client, context });
  }
});

// /sarah slash command + settings modal submission
slackApp.command('/sarah', async (args) => { await handleSarahCommand(args); });
slackApp.view('sarah_settings_modal', async (args) => { await handleSarahSettingsSubmission(args); });

slackApp.error(async (error) => {
  console.error('[BOLT ERROR]', error.message, error.stack);
});

// --- Express app (uses receiver's internal app) ---
const app = receiver.app;

// Log ALL incoming requests
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} | x-slack-signature: ${req.headers['x-slack-signature'] ? 'present' : 'MISSING'}`);
  next();
});

// Trust Railway's reverse proxy so express-rate-limit reads the correct client IP
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// --- Rate limiting ---
// Admin panel: very strict — protects against brute-force on ADMIN_TOKEN
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// OAuth install/callback: rare action, limit to prevent abuse
const oauthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API: generous limit for normal use
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use('/api/oauth', oauthLimiter, oauthRouter);
app.use('/api/agent', adminLimiter, agentRouter);
app.use('/api/slack', oauthLimiter, slackRouter);
app.use('/api/admin', adminLimiter, adminRouter);
app.use('/admin', adminLimiter, adminUiRouter);
app.use('/health', generalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (req, res) => {
  res.json({
    name: 'Sarah API',
    version: '2.0.0',
    endpoints: {
      'POST /slack/events': 'Slack Events API',
      'GET /api/oauth/jira/start': 'Start Jira OAuth',
      'GET /api/oauth/jira/callback': 'Jira OAuth callback',
      'GET /health': 'Health check',
    },
  });
});

// --- Start ---
async function start() {
  await initDb();
  await slackApp.start(PORT);
  console.log(`Sarah running on port ${PORT}`);
  console.log(`Slack events: http://localhost:${PORT}/slack/events`);

  // Alert C — OAuth token refresh daemon (runs every 4h)
  startTokenRefreshDaemon();

  // GDPR — Retention cleanup: delete conversation history older than 90 days
  // Runs once at startup then every 24 hours
  async function runRetentionCleanup() {
    try {
      const deleted = await deleteOldConversations(90);
      if (deleted > 0) console.log(`[GDPR Retention] Deleted ${deleted} conversations older than 90 days`);
    } catch (err) {
      console.error('[GDPR Retention] Cleanup failed:', err.message);
    }
  }
  runRetentionCleanup();
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);

  // Proactive monitoring — daily check at ~09:00 UTC
  // Polls every 5 minutes; fires once per calendar day when the UTC hour is 9.
  let monitoringLastRunDate = null;
  setInterval(async () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();
    const today   = now.toISOString().split('T')[0];
    if (utcHour === 9 && utcMin < 5 && monitoringLastRunDate !== today) {
      monitoringLastRunDate = today;
      try {
        await runScheduledChecks();
      } catch (err) {
        console.error('[Monitoring] Cron run failed:', err.message);
      }
    }
  }, 5 * 60 * 1000); // check every 5 minutes
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
// v2.0.1
