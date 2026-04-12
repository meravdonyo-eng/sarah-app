import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import { initDb, getWorkspace } from './services/db.js';
import { decrypt } from './services/encryption.js';
import { handleMessage, handleAppMention, handleAction, handleAppHomeOpened } from './slack/handlers.js';
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

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// Routes
app.use('/api/oauth', oauthRouter);
app.use('/api/agent', agentRouter);
app.use('/api/slack', slackRouter);
app.use('/api/admin', adminRouter);
app.use('/admin', adminUiRouter);

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
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
