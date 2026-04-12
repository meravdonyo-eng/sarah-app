import { App } from '@slack/bolt';
import { handleMessage, handleAppMention, handleAction } from './handlers.js';

let slackApp = null;

export function createSlackApp() {
  slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    // socketMode: false — we use HTTP (Events API)
    // Express receiver is used via attachToExpress below
  });

  // Direct messages
  slackApp.message(async ({ message, say, client, context }) => {
    if (message.subtype) return; // ignore edits, deletes, etc.
    await handleMessage({ message, say, client, context });
  });

  // @mentions in channels
  slackApp.event('app_mention', async ({ event, say, client, context }) => {
    await handleAppMention({ event, say, client, context });
  });

  // Button actions
  slackApp.action(/.*/, async ({ action, ack, say }) => {
    await handleAction({ action, ack, say });
  });

  console.log('Slack app initialized');
  return slackApp;
}

export function getSlackApp() {
  return slackApp;
}

/**
 * Returns an Express middleware that handles Slack events at /slack/events
 */
export async function createSlackMiddleware() {
  const app = createSlackApp();
  // @slack/bolt ExpressReceiver is used internally when we call app.start()
  // For embedding in existing Express, we use the receiver's router
  return app.receiver.router;
}
