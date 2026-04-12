import {
  getWorkspace,
  getConversationHistory,
  saveConversationHistory,
  clearConversationHistory,
  updateWorkspaceMixpanel,
  checkAndMarkWelcome,
  getUserFlag,
  setUserFlag,
  clearJiraToken,
} from '../services/db.js';
import { getCachedSnapshot, setCachedSnapshot } from '../services/snapshotCache.js';
import { generateSnapshot } from '../services/snapshot.js';
import { encrypt } from '../services/encryption.js';
import { sendMessageWithTools, isJiraValid } from '../services/claude.js';
import {
  formatResponse,
  formatResponseSmart,
  formatMixpanelConfirm,
  formatError,
  formatThinking,
  formatWelcome,
  formatFirstConnection,
} from './formatter.js';
import { popReadMore } from './readMoreStore.js';
import { executeMixpanelTool } from '../services/mixpanel.js';

const JIRA_AUTH_URL = (workspaceId) =>
  `${process.env.BACKEND_URL}/api/oauth/jira/start?workspace_id=${workspaceId}`;

// Tracks users currently going through Mixpanel setup flow
const mixpanelSetupState = new Map(); // slackUserId -> { step, projectId, username }

const GREETING_PATTERN = /^(hi|hey|hello|shalom|שלום|היי|הי|בוקר טוב|צהריים טובים|ערב טוב|מה נשמע|מה קורה|yo|sup)[\s!?.]*$/i;
const STATUS_PATTERN = /^(status|סטטוס|integrations|חיבורים)[\s!?.]*$/i;

export async function handleMessage({ message, say, client, context }) {
  const workspaceId = context.teamId || message.team;
  const userId = message.user;
  const channelId = message.channel;
  const text = (message.text || '').trim();

  if (!text || message.bot_id) return;

  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    await say({ blocks: formatError('Sarah is not configured for this workspace. Please contact your admin.'), text: 'Sarah is not configured.' });
    return;
  }

  // --- Greeting detection: respond briefly, don't send to Claude ---
  if (GREETING_PATTERN.test(text)) {
    await say({ text: 'Hey! 👋 I\'m here and ready to help. What would you like to know about your data?' });
    return;
  }

  // --- Mixpanel setup flow ---
  if (mixpanelSetupState.has(userId)) {
    await handleMixpanelSetupStep({ userId, workspaceId, text, say });
    return;
  }

  // --- Commands ---
  const lower = text.toLowerCase();

  if (lower === '/reset' || lower === 'reset' || lower === 'התחל מחדש') {
    await clearConversationHistory(workspaceId, userId, channelId);
    await say('Conversation reset. Feel free to start fresh!');
    return;
  }

  if (STATUS_PATTERN.test(text) && !lower.includes('connect mixpanel') && !lower.includes('connect jira')) {
    await say({ blocks: formatWelcome(workspace), text: 'Connection status' });
    return;
  }

  if (lower.includes('connect mixpanel') || lower.includes('חבר mixpanel') || lower.includes('חיבור mixpanel')) {
    if (workspace.mixpanel_project_id) {
      await say({ text: 'Mixpanel is already connected ✅' });
      return;
    }
    await startMixpanelStep1(userId, say);
    return;
  }

  if (lower.includes('connect jira') || lower.includes('חבר jira') || lower.includes('חיבור jira')) {
    if (isJiraValid(workspace)) {
      await say({ text: 'Jira is already connected ✅' });
      return;
    }
    await sayJiraConnect(workspaceId, say);
    return;
  }

  // --- Regular message → Claude ---
  const thinkingMsg = await say({ blocks: formatThinking() });

  try {
    const history = await getConversationHistory(workspaceId, userId, channelId);
    const result = await sendMessageWithTools(workspace, text, history);
    await saveConversationHistory(workspaceId, userId, channelId, result.conversationHistory);

    await client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts,
      blocks: await formatResponseSmart(result.response),
      text: result.response,
    });

    // Jira token expired/revoked mid-conversation → clear from DB + show reconnect
    if (result.jiraAuthFailed) {
      await clearJiraToken(workspaceId);
      const jiraUrl = JIRA_AUTH_URL(workspaceId);
      await say({
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: ':warning: *Jira connection expired* — please reconnect:' },
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: 'Reconnect Jira' },
              style: 'primary',
              url: jiraUrl,
              action_id: 'connect_jira',
            }],
          },
        ],
        text: 'Jira connection expired',
      });
    }
  } catch (err) {
    console.error('Claude error:', err);
    await client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts,
      blocks: formatError('Something went wrong. Please try again.'),
      text: 'Error',
    });
  }
}

export async function handleAppMention({ event, say, client, context }) {
  // Strip the mention tag and treat as regular message
  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  await handleMessage({
    message: { ...event, text },
    say,
    client,
    context: { ...context, teamId: event.team },
  });
}

async function startMixpanelStep1(userId, say) {
  mixpanelSetupState.set(userId, { step: 'project_id' });
  await say({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Connect Mixpanel — Step 1 of 3*\n\n' +
                '*Project ID:*\n' +
                '1. Open Mixpanel → Settings → Project Settings\n' +
                '2. Copy your Project ID and send it here:',
        },
      },
    ],
    text: 'Connect Mixpanel — Step 1 of 3',
  });
}

async function sayJiraConnect(workspaceId, say) {
  const url = JIRA_AUTH_URL(workspaceId);
  await say({
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Connect Jira* — click the button to authenticate:' },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Connect Jira' },
            style: 'primary',
            url,
            action_id: 'connect_jira',
          },
        ],
      },
    ],
    text: 'Connect Jira',
  });
}

function stripLabel(text, ...labels) {
  let clean = text.trim();
  for (const label of labels) {
    const regex = new RegExp(`^${label}\\s*[:\\-]?\\s*`, 'i');
    clean = clean.replace(regex, '').trim();
  }
  // Remove trailing punctuation
  return clean.replace(/[.,;]+$/, '').trim();
}

async function handleMixpanelSetupStep({ userId, workspaceId, text, say }) {
  const state = mixpanelSetupState.get(userId);

  if (state.step === 'project_id') {
    const projectId = stripLabel(text, 'project id', 'project_id', 'projectid');
    mixpanelSetupState.set(userId, { ...state, step: 'username', projectId });
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:white_check_mark: Got it ✓  *Step 2 of 3*\n\n` +
                  '*Service Account Username:*\n' +
                  '1. Go to Mixpanel → Settings → Service Accounts\n' +
                  '2. Click *+ Add Service Account*, give it any name\n' +
                  '3. Copy the Username\n\n' +
                  ':warning: *Keep the window open — credentials are shown only once*\n\n' +
                  'Send the Username:',
          },
        },
      ],
      text: 'Step 2 of 3 — Service Account Username',
    });
    return;
  }

  if (state.step === 'username') {
    const username = stripLabel(text, 'username', 'user name', 'service account username');
    mixpanelSetupState.set(userId, { ...state, step: 'secret', username });
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:white_check_mark: Got it ✓  *Step 3 of 3*\n\n` +
                  '*Service Account Secret:*\n' +
                  'From the same window — copy the Secret and send it here:',
          },
        },
      ],
      text: 'Step 3 of 3 — Service Account Secret',
    });
    return;
  }

  if (state.step === 'secret') {
    const secret = stripLabel(text, 'secret', 'service account secret', 'password');
    const { projectId, username } = state;
    mixpanelSetupState.set(userId, { step: 'confirm', projectId, username, secret, workspaceId });
    await say({ blocks: formatMixpanelConfirm(projectId, username) });
  }
}

export async function handleAppHomeOpened({ event, client, context }) {
  const userId = event.user;
  const workspaceId = context.teamId;

  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return;

  // Only send once per day
  if (!await checkAndMarkWelcome(workspaceId, userId)) return;

  const dm = await client.conversations.open({ users: userId });
  const channelId = dm.channel.id;

  const hasMixpanel = !!workspace.mixpanel_project_id;
  const hasJira = !!workspace.jira_access_token;

  // Not connected → show welcome with buttons
  if (!hasMixpanel || !hasJira) {
    await client.chat.postMessage({
      channel: channelId,
      blocks: formatWelcome(workspace),
      text: 'Welcome to Sarah!',
    });
    return;
  }

  // First-time both-connected message (shown once per user, ever)
  const firstShown = await getUserFlag(workspaceId, userId, 'first_connection_message_shown');
  if (!firstShown) {
    await setUserFlag(workspaceId, userId, 'first_connection_message_shown');
    await client.chat.postMessage({
      channel: channelId,
      blocks: formatFirstConnection('en'),
      text: 'Connected! 🎉',
    });
    return;
  }

  // Fully connected — show snapshot (cached or fresh)
  const cacheKey = `${workspaceId}:${userId}`;
  const cached = getCachedSnapshot(cacheKey);

  if (cached) {
    await client.chat.postMessage({
      channel: channelId,
      blocks: formatResponse(cached),
      text: cached,
    });
    return;
  }

  // Generate fresh snapshot
  const thinking = await client.chat.postMessage({
    channel: channelId,
    text: '_Sarah is preparing your daily snapshot..._',
  });

  try {
    const snapshot = await generateSnapshot(workspace, 'en');
    if (!snapshot) throw new Error('Empty snapshot response');
    setCachedSnapshot(cacheKey, snapshot);
    await client.chat.update({
      channel: channelId,
      ts: thinking.ts,
      blocks: formatResponse(snapshot),
      text: snapshot,
    });
  } catch (err) {
    console.error('Snapshot generation error:', err);
    await client.chat.update({
      channel: channelId,
      ts: thinking.ts,
      text: 'Good morning! Ask me anything about your product data and I\'ll answer 😊',
    });
  }
}

export async function handleAction({ action, ack, say, body, context, client }) {
  await ack();
  const workspaceId = body.team?.id || context.teamId;
  const userId = body.user?.id;
  console.log(`[ACTION] action_id=${action.action_id} userId=${userId} workspaceId=${workspaceId}`);

  if (action.action_id === 'read_more') {
    const rest = await popReadMore(action.value);
    if (!rest) {
      await say({ text: ':hourglass: This content has expired — please ask again.' });
      return;
    }
    // Remove the "Read more" button from the original message
    const channelId = body.channel?.id || body.container?.channel_id;
    const summaryBlocks = (body.message?.blocks || []).filter(b => b.type !== 'actions');
    if (client && channelId && body.message?.ts) {
      const summaryText = summaryBlocks.map(b => b.text?.text || '').join(' ').trim() || '...';
      await client.chat.update({
        channel: channelId,
        ts: body.message.ts,
        blocks: summaryBlocks,
        text: summaryText,
      });
    }
    // Post the rest as a new message
    await say({ blocks: formatResponse(rest), text: rest.slice(0, 200) });
    return;
  }

  if (action.action_id === 'mixpanel_connect_confirm') {
    const state = mixpanelSetupState.get(userId);
    if (!state || state.step !== 'confirm') {
      await say({ text: 'No connection details found. Please try again with `connect mixpanel`.' });
      return;
    }

    const { projectId, username, secret } = state;
    const creds = { projectId, username, secret };

    await say({ text: '_Verifying Mixpanel connection..._' });

    try {
      await executeMixpanelTool('mixpanel_list_events', {}, creds);

      // Connection succeeded — save to DB
      await updateWorkspaceMixpanel(workspaceId, {
        projectId: encrypt(projectId),
        username: encrypt(username),
        secret: encrypt(secret),
      });
      mixpanelSetupState.delete(userId);

      const jiraUrl = JIRA_AUTH_URL(workspaceId);
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':white_check_mark: *Mixpanel connected successfully!*\n\nGreat work! Now let\'s connect Jira:',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Connect Jira' },
                style: 'primary',
                url: jiraUrl,
                action_id: 'connect_jira',
              },
            ],
          },
        ],
      });
    } catch (err) {
      // Connection failed — restart the flow
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':x: *Connection failed* — one of the details may be incorrect.\nLet\'s start over — Step 1 of 3:\n\n' +
                    '*Project ID:*\n' +
                    '1. Open Mixpanel → Settings → Project Settings\n' +
                    '2. Copy your Project ID and send it here:',
            },
          },
        ],
        text: 'Connection failed — please try again',
      });
      mixpanelSetupState.set(userId, { step: 'project_id' });
    }
    return;
  }

  if (action.action_id === 'welcome_connect_mixpanel') {
    const workspace = await getWorkspace(workspaceId);
    if (workspace?.mixpanel_project_id) {
      await say({ text: 'Mixpanel is already connected ✅' });
      return;
    }
    await startMixpanelStep1(userId, say);
    return;
  }

  if (action.action_id === 'welcome_connect_jira') {
    const workspace = await getWorkspace(workspaceId);
    if (isJiraValid(workspace)) {
      await say({ text: 'Jira is already connected ✅' });
      return;
    }
    await sayJiraConnect(workspaceId, say);
    return;
  }
}
