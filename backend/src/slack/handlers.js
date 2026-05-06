import {
  getWorkspace,
  getConversationHistory,
  saveConversationHistory,
  clearConversationHistory,
  updateWorkspaceMixpanel,
  updateWorkspaceJiraProject,
  checkAndMarkWelcome,
  getUserFlag,
  setUserFlag,
  clearJiraToken,
  incrementApiUsage,
  getMonthlyUsage,
  getTotalMonthlyUsage,
  addEventToDictionary,
  updateWorkspaceEventDictionary,
} from '../services/db.js';
import { sendOwnerAlert, checkApibudget } from '../services/ownerAlerts.js';
import {
  trackActivated,
  trackErrorShown,
  trackOnboardingStarted,
  trackOnboardingStepCompleted,
  trackOnboardingCompleted,
  trackJiraConnected,
} from '../services/sarahAnalytics.js';
import { getCachedSnapshot, setCachedSnapshot } from '../services/snapshotCache.js';
import { generateSnapshot } from '../services/snapshot.js';
import { encrypt } from '../services/encryption.js';
import { sendMessageWithTools, isJiraValid, detectJiraMandate, detectBaselineQuery, detectFunnelQuestion } from '../services/claude.js';
import {
  formatResponse,
  formatResponseSmart,
  formatMixpanelConfirm,
  formatError,
  formatThinking,
  formatWelcome,
  formatFirstConnection,
  injectLinks,
} from './formatter.js';
import { popReadMore, getReadMore } from './readMoreStore.js';
import { executeMixpanelTool } from '../services/mixpanel.js';

const JIRA_AUTH_URL = (workspaceId, channelId = '') =>
  `${process.env.BACKEND_URL}/api/oauth/jira/start?workspace_id=${workspaceId}${channelId ? `&channel_id=${encodeURIComponent(channelId)}` : ''}`;

// Tracks users currently going through Mixpanel setup flow
const mixpanelSetupState = new Map(); // slackUserId -> { step, projectId, username }

// Tracks in-progress Claude requests so they can be cancelled
const activeRequests = new Map(); // slackUserId -> { abortController, channelId, thinkingTs }

// Bug 1 — Idempotency: prevent processing the same Slack event twice
// (Slack retries if it doesn't get a 200 within 3s; Bolt ACKs immediately but events can
//  still arrive twice in edge cases or when the handler errors mid-flight)
const processedEvents = new Map(); // event_ts -> timestamp
const EVENT_DEDUP_TTL = 60_000; // 60 seconds
function isDuplicate(eventTs) {
  if (processedEvents.has(eventTs)) return true;
  processedEvents.set(eventTs, Date.now());
  // Prune old entries to avoid memory leak
  for (const [key, ts] of processedEvents) {
    if (Date.now() - ts > EVENT_DEDUP_TTL) processedEvents.delete(key);
  }
  return false;
}

// Bug 2 — Message queue per-user: prevent race conditions when a user sends
// two messages before the first reply arrives (replies would interleave)
const userQueues = new Map(); // userId -> Promise
function enqueueForUser(userId, fn) {
  const prev = userQueues.get(userId) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  userQueues.set(userId, next);
  return next;
}

const GREETING_PATTERN = /^(hi|hey|hello|shalom|שלום|היי|הי|בוקר טוב|צהריים טובים|ערב טוב|מה נשמע|מה קורה|yo|sup)[\s!?.]*$/i;
const STATUS_PATTERN = /^(status|סטטוס|integrations|חיבורים)[\s!?.]*$/i;

export async function handleMessage({ message, say, client, context }) {
  const workspaceId = context.teamId || message.team;
  const userId = message.user;
  const channelId = message.channel;
  const text = (message.text || '').trim();

  if (!text || message.bot_id) return;

  // Bug 1 — Idempotency: skip if we already processed this exact event
  const eventTs = message.event_ts || message.ts;
  if (eventTs && isDuplicate(eventTs)) {
    console.log(`[Idempotency] Skipping duplicate event_ts=${eventTs}`);
    return;
  }

  // Feature — Public Channel Block: only respond in DMs and private channels
  try {
    const channelInfo = await client.conversations.info({ channel: channelId });
    const ch = channelInfo.channel;
    const isPrivate = ch.is_im || ch.is_mpim || ch.is_private;
    if (!isPrivate) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: message.ts,
        text: 'אני עובדת רק ב-DM או בערוצים פרטיים כדי להגן על הדאטה של החברה. שלחי לי הודעה ישירה 🔒',
      });
      return;
    }
  } catch {
    // If we can't check channel type (e.g. missing scope), proceed normally
  }

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

  if (lower.includes('connect mixpanel') || lower.includes('reconnect mixpanel') ||
      lower.includes('חבר mixpanel') || lower.includes('חיבור mixpanel') || lower.includes('חבר מחדש mixpanel')) {
    if (workspace.mixpanel_project_id && !lower.includes('reconnect') && !lower.includes('חבר מחדש')) {
      await say({ text: 'Mixpanel is already connected ✅\nTo switch to a different project, type *reconnect mixpanel*.' });
      return;
    }
    await startMixpanelStep1(userId, say, workspaceId);
    return;
  }

  if (lower.includes('connect jira') || lower.includes('חבר jira') || lower.includes('חיבור jira') ||
      lower.includes('reconnect jira') || lower.includes('חבר מחדש jira')) {
    if (isJiraValid(workspace) && !lower.includes('reconnect') && !lower.includes('חבר מחדש')) {
      await say({ text: 'Jira is already connected ✅' });
      return;
    }
    await sayJiraConnect(workspaceId, say, channelId);
    return;
  }

  // --- Set default Jira project ---
  const jiraProjectMatch = lower.match(/set jira project\s+([a-z0-9_-]+)/i) ||
                           text.match(/set jira project\s+([A-Z0-9_-]+)/i);
  if (jiraProjectMatch) {
    const projectKey = jiraProjectMatch[1].toUpperCase();
    await updateWorkspaceJiraProject(workspaceId, projectKey);
    await say({ text: `✅ Default Jira project set to *${projectKey}*. Sarah will now filter all Jira queries to this project.` });
    return;
  }

  // --- Event Dictionary commands ---
  // "set event [name] = [description]"  → add/update single entry
  // "clear event dictionary"             → wipe all entries
  // "show event dictionary"              → display current dictionary
  const setEventMatch = text.match(/^set event\s+(.+?)\s*=\s*(.+)$/i);
  if (setEventMatch) {
    const [, eventName, description] = setEventMatch;
    await addEventToDictionary(workspaceId, eventName.trim(), description.trim());
    await say({ text: `✅ Event dictionary updated:\n\`${eventName.trim()}\` = ${description.trim()}` });
    return;
  }
  if (lower === 'clear event dictionary') {
    await updateWorkspaceEventDictionary(workspaceId, {});
    await say({ text: '✅ Event dictionary cleared.' });
    return;
  }
  if (lower === 'show event dictionary') {
    const ws = await getWorkspace(workspaceId);
    const dict = ws.event_dictionary
      ? (typeof ws.event_dictionary === 'string' ? JSON.parse(ws.event_dictionary) : ws.event_dictionary)
      : {};
    const entries = Object.entries(dict);
    if (entries.length === 0) {
      await say({ text: 'Event dictionary is empty.\nAdd entries with: `set event [name] = [description]`' });
    } else {
      const lines = entries.map(([k, v]) => `• \`${k}\` = ${v}`).join('\n');
      await say({ text: `*Event Dictionary* (${entries.length} entries):\n${lines}` });
    }
    return;
  }

  // --- Regular message → Claude ---
  // Bug 0 — Check API budget before calling Claude
  try {
    const totalSpend = await getTotalMonthlyUsage();
    const budgetExceeded = await checkApibudget(totalSpend);
    if (budgetExceeded) {
      await say({ text: 'Sarah חוזרת עוד כמה שעות. נסי שוב מאוחר יותר 🙏' });
      return;
    }
  } catch { /* budget check must never block the user */ }

  const isComplex = detectJiraMandate(text) || detectBaselineQuery(text) || detectFunnelQuestion(text);
  const thinkingMsg = await say({
    blocks: formatThinking(isComplex),
    text: 'Sarah is thinking...',
  });

  const abortController = new AbortController();
  activeRequests.set(userId, { abortController, channelId, thinkingTs: thinkingMsg.ts });

  // Bug 2 — Enqueue this request so parallel messages from the same user run in order
  await enqueueForUser(userId, async () => {
  try {
    const history = await getConversationHistory(workspaceId, userId, channelId);
    const result = await sendMessageWithTools(workspace, text, history, abortController.signal);
    activeRequests.delete(userId);
    await saveConversationHistory(workspaceId, userId, channelId, result.conversationHistory);

    // Per-tenant cost tracking
    if (result.usage) {
      const { input_tokens, output_tokens } = result.usage;
      try {
        const callCost = await incrementApiUsage(workspaceId, input_tokens || 0, output_tokens || 0);
        const monthTotal = await getMonthlyUsage(workspaceId);
        const TENANT_ALERT = 5.00;
        if (monthTotal > TENANT_ALERT) {
          sendOwnerAlert({
            subject: `High usage: workspace ${workspaceId}`,
            body: `Monthly: $${monthTotal.toFixed(2)}. Last call: $${callCost.toFixed(4)}.`,
            channels: ['slack_dm'],
          }).catch(() => {});
        }
      } catch { /* cost tracking must never block the user */ }
    }

    // DEBUG — log raw Sarah output before any post-processing
    console.log('[DEBUG:raw] Sarah raw response\n---\n' + result.response + '\n---');

    const linkedResponse = injectLinks(result.response, workspace);
    await client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts,
      blocks: await formatResponseSmart(linkedResponse),
      text: linkedResponse,
    });

    // Gap 2 — Activated: fire once per user on their first successful data answer
    if (result.response && !result.jiraAuthFailed) {
      const alreadyActivated = await getUserFlag(workspaceId, userId, 'activated');
      if (!alreadyActivated) {
        await setUserFlag(workspaceId, userId, 'activated');
        // Detect which feature (tool) Claude used to answer
        const toolsUsed = result.conversationHistory
          .flatMap(m => Array.isArray(m.content) ? m.content : [])
          .filter(b => b.type === 'tool_use')
          .map(b => b.name);
        const featureName = toolsUsed.includes('mixpanel_funnel')    ? 'funnel'
                          : toolsUsed.includes('mixpanel_retention') ? 'retention'
                          : toolsUsed.some(n => n.startsWith('jira_')) ? 'jira'
                          : toolsUsed.some(n => n.startsWith('mixpanel_')) ? 'mixpanel'
                          : null;
        trackActivated(workspaceId, userId, { feature_name: featureName }).catch(() => {});
      }
    }

    // Jira token expired/revoked mid-conversation → clear from DB + show reconnect
    if (result.jiraAuthFailed) {
      await clearJiraToken(workspaceId);
      const jiraUrl = JIRA_AUTH_URL(workspaceId, channelId);
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
    activeRequests.delete(userId);
    if (err.name === 'AbortError' || err.message?.includes('abort')) {
      await client.chat.update({
        channel: channelId,
        ts: thinkingMsg.ts,
        blocks: formatError('Cancelled. Feel free to ask again.'),
        text: 'Cancelled',
      });
      return;
    }
    // Log every field that could identify the root cause
    console.error('[SarahError] status=%s type=%s message=%s stack=%s',
      err.status ?? err.statusCode ?? 'n/a',
      err.error?.type ?? err.type ?? err.name ?? 'n/a',
      err.message ?? String(err),
      err.stack?.split('\n').slice(0, 3).join(' | ')
    );
    if (err.error) console.error('[SarahError] API error body:', JSON.stringify(err.error).slice(0, 500));
    // Gap 2+4 — Error Shown: track every time Sarah fails to answer
    trackErrorShown(workspaceId, userId, {
      error_code:    err.status || err.code || null,
      error_message: err.message || String(err),
      error_screen:  'chat',
    }).catch(() => {});
    const userMsg = err.status === 429
      ? 'Sarah is handling too many requests right now — please try again in a minute 🙏'
      : err.message === 'TIMEOUT'
        ? 'Sarah took too long to respond — please try again 🙏'
        : err.status === 401 || err.status === 403
          ? 'Sarah can\'t reach the AI API right now — please contact support.'
          : err.status >= 400 && err.status < 500
            ? `Something went wrong (error ${err.status}). Please try again.`
            : 'Something went wrong. Please try again.';
    await client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts,
      blocks: formatError(userMsg),
      text: userMsg,
    });
  }
  }); // end enqueueForUser
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

async function startMixpanelStep1(userId, say, workspaceId) {
  mixpanelSetupState.set(userId, { step: 'project_id', workspaceId });
  // Gap 3 — Onboarding Started
  trackOnboardingStarted(workspaceId, userId).catch(() => {});
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

async function sayJiraConnect(workspaceId, say, channelId = '') {
  const url = JIRA_AUTH_URL(workspaceId, channelId);
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
    // Gap 3 — Onboarding Step 1 completed
    trackOnboardingStepCompleted(workspaceId, userId, 1, 'project_id').catch(() => {});
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
    // Gap 3 — Onboarding Step 2 completed
    trackOnboardingStepCompleted(workspaceId, userId, 2, 'username').catch(() => {});
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
    // Gap 3 — Onboarding Step 3 completed
    trackOnboardingStepCompleted(workspaceId, userId, 3, 'secret').catch(() => {});
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

  if (action.action_id === 'cancel_sarah') {
    const active = activeRequests.get(userId);
    if (active) {
      active.abortController.abort();
      activeRequests.delete(userId);
      await client.chat.update({
        channel: active.channelId,
        ts: active.thinkingTs,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '_Cancelled. Feel free to ask again._' } }],
        text: 'Cancelled',
      });
    }
    return;
  }

  if (action.action_id === 'read_more') {
    // value is either "restId|summaryId" (new) or just "restId" (legacy messages)
    const hasToggle = action.value.includes('|');
    const [restId, summaryId] = hasToggle ? action.value.split('|') : [action.value, null];

    // Use non-destructive get for new format so Read less can restore the summary;
    // fall back to destructive pop for legacy messages that have no summaryId.
    const rest = hasToggle
      ? await getReadMore(restId)
      : await popReadMore(restId);

    if (!rest) {
      await say({ text: ':hourglass: This content has expired — please ask again.' });
      return;
    }

    const channelId = body.channel?.id || body.container?.channel_id;
    const summaryBlocks = (body.message?.blocks || []).filter(b => b.type !== 'actions');
    const restBlocks = formatResponse(rest);

    // For new-format messages append a "Read less ▲" toggle button
    const toggleBlock = hasToggle ? [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Read less ▲' },
        action_id: 'read_less',
        value: `${summaryId}|${restId}`,
      }],
    }] : [];

    const fullBlocks = [...summaryBlocks, ...restBlocks, ...toggleBlock];
    const fullText = summaryBlocks.map(b => b.text?.text || '').join(' ').trim() + '\n' + rest;

    if (client && channelId && body.message?.ts) {
      await client.chat.update({
        channel: channelId,
        ts: body.message.ts,
        blocks: fullBlocks,
        text: fullText.slice(0, 200),
      });
    }
    return;
  }

  if (action.action_id === 'read_less') {
    // value is "summaryId|restId"
    const [summaryId, restId] = action.value.split('|');
    const summary = await getReadMore(summaryId);

    if (!summary) {
      await say({ text: ':hourglass: This content has expired — please ask again.' });
      return;
    }

    const channelId = body.channel?.id || body.container?.channel_id;
    const summaryBlocks = formatResponse(summary);

    summaryBlocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Read more ▼' },
        action_id: 'read_more',
        value: `${restId}|${summaryId}`,
      }],
    });

    const collapseText = summaryBlocks
      .filter(b => b.type === 'section')
      .map(b => b.text?.text || '')
      .join(' ')
      .trim()
      .slice(0, 200);

    if (client && channelId && body.message?.ts) {
      await client.chat.update({
        channel: channelId,
        ts: body.message.ts,
        blocks: summaryBlocks,
        text: collapseText,
      });
    }
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
      // Gap 3 — Onboarding Completed (Mixpanel fully connected)
      trackOnboardingCompleted(workspaceId, userId).catch(() => {});

      const jiraUrl = JIRA_AUTH_URL(workspaceId, body?.channel?.id || '');
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
    await startMixpanelStep1(userId, say, workspaceId);
    return;
  }

  if (action.action_id === 'welcome_connect_jira') {
    const workspace = await getWorkspace(workspaceId);
    if (isJiraValid(workspace)) {
      await say({ text: 'Jira is already connected ✅' });
      return;
    }
    const channelIdForJira = body?.channel?.id || body?.container?.channel_id || '';
    await sayJiraConnect(workspaceId, say, channelIdForJira);
    return;
  }
}
