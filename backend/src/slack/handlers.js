import {
  getWorkspace,
  getConversationHistory,
  saveConversationHistory,
  clearConversationHistory,
  updateWorkspaceMixpanel,
  updateWorkspaceAmplitude,
  updateWorkspaceClickup,
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
  updateWorkspaceSystemPrompt,
  deleteUserAllData,
  clearAmplitudeCredentials,
  clearMixpanelCredentials,
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
import { encrypt, decrypt } from '../services/encryption.js';
import { sendMessageWithTools, isJiraValid, detectJiraMandate, detectClickUpMandate, detectBaselineQuery, detectFunnelQuestion } from '../services/claude.js';
import { logQueryOutcome } from '../services/zeroInputLog.js';
import { saveInteraction } from '../services/interactionStore.js';
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
import { executeAmplitudeTool } from '../services/amplitude.js';
import { getClickUpTeams } from '../services/clickup.js';

const JIRA_AUTH_URL = (workspaceId, channelId = '') =>
  `${process.env.BACKEND_URL}/api/oauth/jira/start?workspace_id=${workspaceId}${channelId ? `&channel_id=${encodeURIComponent(channelId)}` : ''}`;

// Tracks users currently going through Mixpanel setup flow
const mixpanelSetupState = new Map(); // slackUserId -> { step, projectId, username }

// Tracks users currently going through Amplitude setup flow
const amplitudeSetupState = new Map(); // slackUserId -> { step, apiKey, workspaceId }

// Tracks users currently going through ClickUp setup flow
const clickupSetupState = new Map(); // slackUserId -> { step, token, teams, workspaceId }

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

  // GDPR — show privacy notice once per user on first interaction
  const hasSeenPrivacyNotice = await getUserFlag(workspaceId, userId, 'gdpr_notice_shown');
  if (!hasSeenPrivacyNotice) {
    await setUserFlag(workspaceId, userId, 'gdpr_notice_shown');
    await say({
      text: '🔒 *Privacy notice:* Sarah uses Claude AI (Anthropic) to process your questions. Your messages are stored for conversation context and automatically deleted after 90 days. Type *delete my data* at any time to remove all your data immediately.',
    });
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

  // --- Amplitude setup flow ---
  if (amplitudeSetupState.has(userId)) {
    await handleAmplitudeSetupStep({ userId, workspaceId, text, say });
    return;
  }

  // --- ClickUp setup flow ---
  if (clickupSetupState.has(userId)) {
    await handleClickUpSetupStep({ userId, workspaceId, text, say });
    return;
  }

  // --- Commands ---
  const lower = text.toLowerCase();

  if (lower === '/reset' || lower === 'reset' || lower === 'התחל מחדש') {
    await clearConversationHistory(workspaceId, userId, channelId);
    await say('Conversation reset. Feel free to start fresh!');
    return;
  }

  // Monitoring mute commands
  if (lower === 'mute alerts' || lower === 'pause alerts' || lower === 'השתק התראות') {
    const { muteMonitor, getAllActiveMonitors } = await import('../services/monitoringDb.js');
    const monitors = (await import('../services/monitoringDb.js')).getAllActiveMonitors
      ? await (await import('../services/monitoringDb.js')).getActiveMonitors(workspaceId)
      : [];
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Promise.all(monitors.map(m => muteMonitor(workspaceId, m.monitor_id, until.toISOString())));
    await say({ text: `🔕 All monitoring alerts muted for 24h (until ${until.toLocaleTimeString()}). Type *unmute alerts* to re-enable.` });
    return;
  }

  if (lower === 'unmute alerts' || lower === 'resume alerts' || lower === 'בטל השתקה') {
    const { muteMonitor, getActiveMonitors } = await import('../services/monitoringDb.js');
    // Clear muted_until by setting it to past date
    const { rows } = await (await import('../services/db.js')).default.query(
      `UPDATE monitor_configs SET muted_until = NULL, status = 'active', updated_at = NOW()
       WHERE workspace_id = $1 RETURNING monitor_id`, [workspaceId]
    );
    const count = rows.length;
    await say({ text: `✅ Monitoring alerts resumed — ${count} monitor${count !== 1 ? 's' : ''} active.` });
    return;
  }

  if (lower === 'delete my data' || lower === 'מחק את הנתונים שלי' || lower === 'delete data') {
    await deleteUserAllData(workspaceId, userId);
    await say('✅ Done — all your data has been permanently deleted from Sarah (conversation history, preferences, and activity records).');
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
    if (workspace.amplitude_api_key && workspace.amplitude_secret_key && !lower.includes('reconnect') && !lower.includes('חבר מחדש')) {
      await say({
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: "You're already connected to *Amplitude*. Connect Mixpanel instead? This will replace Amplitude." } },
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Yes, replace Amplitude' }, style: 'danger', action_id: 'confirm_connect_mixpanel' },
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'skip_pm_tool' },
          ]},
        ],
        text: "You're already connected to Amplitude.",
      });
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

  if (lower.includes('connect amplitude') || lower.includes('reconnect amplitude') ||
      lower.includes('חבר amplitude') || lower.includes('חיבור amplitude')) {
    if (workspace.amplitude_api_key && workspace.amplitude_secret_key && !lower.includes('reconnect') && !lower.includes('חבר מחדש')) {
      await say({ text: 'Amplitude is already connected ✅\nTo switch to a different project, type *reconnect amplitude*.' });
      return;
    }
    if (workspace.mixpanel_project_id && !lower.includes('reconnect') && !lower.includes('חבר מחדש')) {
      await say({
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: "You're already connected to *Mixpanel*. Connect Amplitude instead? This will replace Mixpanel." } },
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Yes, replace Mixpanel' }, style: 'danger', action_id: 'confirm_connect_amplitude' },
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'skip_pm_tool' },
          ]},
        ],
        text: "You're already connected to Mixpanel.",
      });
      return;
    }
    await startAmplitudeStep1(userId, say, workspaceId);
    return;
  }

  if (lower.includes('connect clickup') || lower.includes('reconnect clickup') ||
      lower.includes('connect click up') || lower.includes('reconnect click up') ||
      lower.includes('חבר clickup') || lower.includes('חיבור clickup')) {
    if (workspace.clickup_api_token && !lower.includes('reconnect') && !lower.includes('חבר מחדש')) {
      await say({ text: 'ClickUp is already connected ✅\nTo switch workspace, type *reconnect clickup*.' });
      return;
    }
    await startClickUpStep1(userId, say, workspaceId);
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

  // --- !setprompt command (owner-only hot-reload, no deploy needed) ---
  // Usage: send a message where the first line is "!setprompt" and the rest is the new prompt.
  // Only OWNER_SLACK_USER_ID can run this — prevents any workspace member from replacing the prompt.
  if (lower.startsWith('!setprompt')) {
    const ownerId = process.env.OWNER_SLACK_USER_ID;
    if (!ownerId || userId !== ownerId) {
      await say({ text: '❌ `!setprompt` is restricted to the workspace owner.' });
      return;
    }
    // The prompt body is everything after the first line
    const firstNewline = text.indexOf('\n');
    const promptText = firstNewline >= 0 ? text.slice(firstNewline + 1).trim() : '';
    if (!promptText) {
      await say({
        text: [
          '❌ No prompt text found.',
          'Usage: send a message where line 1 is `!setprompt` and the rest is the full prompt.',
          '```',
          '!setprompt',
          'Sarah — Product Intelligence Partner ...',
          '...',
          '```',
          'To *clear* the custom prompt (revert to deploy default): send `!setprompt clear`',
        ].join('\n'),
      });
      return;
    }
    // "!setprompt clear" → wipe the DB entry and revert to the deployed file prompt
    if (promptText.toLowerCase() === 'clear') {
      await updateWorkspaceSystemPrompt(workspaceId, null);
      await say({ text: '✅ Custom prompt cleared. Sarah will now use the deployed default prompt.' });
      return;
    }
    await updateWorkspaceSystemPrompt(workspaceId, promptText);
    const PREVIEW_LEN = 120;
    const preview = promptText.length > PREVIEW_LEN
      ? promptText.slice(0, PREVIEW_LEN) + '...'
      : promptText;
    await say({
      text: [
        `✅ Prompt updated (${promptText.length.toLocaleString()} chars). Takes effect on the *next message* — no deploy needed.`,
        '',
        'Preview:',
        '```',
        preview,
        '```',
        '',
        '_To revert to the deployed prompt, send `!setprompt clear`._',
      ].join('\n'),
    });
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
    const result = await sendMessageWithTools(workspace, text, history, abortController.signal, { slackUserId: userId });
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
    const responseBlocks = await formatResponseSmart(linkedResponse);

    // GZ-1: if Sarah mentioned a not-connected tool, append a connect button
    const gz1Block = buildConnectButton(result.response, workspace, workspaceId, channelId);
    if (gz1Block) responseBlocks.push(gz1Block);

    await client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts,
      blocks: responseBlocks,
      text: linkedResponse,
    });

    // Interaction store — save metadata for continuity context (qualitative only, no metric values)
    saveInteraction({
      workspaceId,
      userId,
      queryText: text,
      sarahResponse: result.response,
      workspace,
    }).catch(() => {});

    // Zero-input KPI logging — fire-and-forget, never blocks
    logQueryOutcome({
      workspaceId,
      slackUserId: userId,
      userMessage: text,
      responseText: result.response,
      workspace,
    }).catch(() => {});

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
    // Extra context for 400 errors — most common cause is payload too large or malformed message
    if (err.status === 400) {
      console.error('[SarahError] 400 detail — likely causes: (1) message payload too large from accumulated tool results, (2) malformed tool_result block, (3) invalid content in conversation history. Check [ToolCall] lines above for context.');
    }
    // Gap 2+4 — Error Shown: track every time Sarah fails to answer
    trackErrorShown(workspaceId, userId, {
      error_code:    err.status || err.code || null,
      error_message: err.message || String(err),
      error_screen:  'chat',
    }).catch(() => {});
    // Detect Anthropic "credit balance too low" — 400 with a billing-related message
    const isBillingError = err.status === 400 &&
      (err.error?.message?.toLowerCase().includes('credit') ||
       err.error?.message?.toLowerCase().includes('billing') ||
       err.message?.toLowerCase().includes('credit') ||
       err.message?.toLowerCase().includes('billing'));
    const userMsg = isBillingError
      ? '⚠️ Sarah has run out of API credits. Please top up the Anthropic account to continue.'
      : err.status === 429
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

// ---- GZ-1: Connect button injection ----
// When Sarah's response mentions a not-connected tool, append a one-click connect button.
// Avoids asking the PM to type a command — makes GZ-1 real.

function buildConnectButton(responseText, workspace, workspaceId, channelId) {
  if (!responseText) return null;
  const lower = responseText.toLowerCase();

  const hasMixpanel  = !!workspace.mixpanel_project_id;
  const hasAmplitude = !!(workspace.amplitude_api_key && workspace.amplitude_secret_key);
  const hasAnalytics = hasMixpanel || hasAmplitude;

  // Jira not connected and Sarah mentions it
  if (!workspace.jira_access_token && (lower.includes('connect jira') || lower.includes('jira isn') || lower.includes('jira is not'))) {
    const url = JIRA_AUTH_URL(workspaceId, channelId || '');
    return {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🔗 Connect Jira' },
        style: 'primary',
        url,
        action_id: 'connect_jira',
      }],
    };
  }

  // Analytics not connected and Sarah mentions it
  if (!hasAnalytics && (lower.includes('connect mixpanel') || lower.includes('connect amplitude') ||
      lower.includes('mixpanel isn') || lower.includes('analytics isn'))) {
    return {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '📊 Connect Mixpanel' }, action_id: 'welcome_connect_mixpanel' },
        { type: 'button', text: { type: 'plain_text', text: '📊 Connect Amplitude' }, action_id: 'welcome_connect_amplitude' },
      ],
    };
  }

  // ClickUp not connected
  if (!workspace.clickup_api_token && (lower.includes('connect clickup') || lower.includes('clickup isn'))) {
    return {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '✅ Connect ClickUp' },
        action_id: 'welcome_connect_clickup',
      }],
    };
  }

  return null;
}

// ---- Key Events Onboarding ----
// Called fire-and-forget after Mixpanel connects.
// Scores event list for likely conversion + error candidates,
// presents max 3 options as buttons, saves choice to event_dictionary.

function scoreEvent(name, keywords) {
  const lower = name.toLowerCase().replace(/[_\s-]/g, ' ');
  return keywords.reduce((s, kw) => (lower.includes(kw) ? s + 1 : s), 0);
}

function topCandidates(eventNames, keywords, limit = 3) {
  return eventNames
    .map(name => ({ name, score: scoreEvent(name, keywords) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(e => e.name);
}

function makeEventButtons(candidates, actionId) {
  const btns = candidates.map(name => ({
    type: 'button',
    text: { type: 'plain_text', text: name.length > 24 ? name.slice(0, 22) + '…' : name },
    action_id: actionId,
    value: name,
  }));
  btns.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Skip →' },
    action_id: actionId,
    value: '__skip__',
  });
  return btns;
}

async function startKeyEventsOnboarding(workspaceId, say, creds) {
  // Brief pause so "Mixpanel connected" message appears first
  await new Promise(r => setTimeout(r, 1500));

  let eventNames = [];
  try {
    const events = await executeMixpanelTool('mixpanel_list_events', {}, creds);
    eventNames = (Array.isArray(events) ? events : [])
      .map(e => (typeof e === 'string' ? e : (e?.name ?? null)))
      .filter(Boolean);
  } catch {
    return; // Can't fetch events — skip silently
  }

  if (eventNames.length === 0) return;

  const conversionKeywords = ['complet', 'sign', 'activat', 'purchas', 'paid', 'subscrib', 'convert', 'onboard', 'success', 'register'];
  const candidates = topCandidates(eventNames, conversionKeywords);
  if (candidates.length === 0) return;

  await say({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🎯 *Quick setup — one question*\n\nI found events that look like your main conversion milestone.\nWhich one represents *success* in your product?',
        },
      },
      { type: 'actions', elements: makeEventButtons(candidates, 'key_event_conversion_select') },
    ],
    text: 'Key events setup — which is your main conversion event?',
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

// ---------------------------------------------------------------------------
// Amplitude setup flow — 2 steps: API Key → Secret Key → verify → save
// ---------------------------------------------------------------------------

async function startAmplitudeStep1(userId, say, workspaceId) {
  amplitudeSetupState.set(userId, { step: 'api_key', workspaceId });
  await say({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Connect Amplitude — Step 1 of 2*\n\n' +
                '*API Key:*\n' +
                '1. Open Amplitude → Settings → Projects → [your project]\n' +
                '2. Copy the *API Key* and send it here:',
        },
      },
    ],
    text: 'Connect Amplitude — Step 1 of 2',
  });
}

async function handleAmplitudeSetupStep({ userId, workspaceId, text, say }) {
  const state = amplitudeSetupState.get(userId);

  if (state.step === 'api_key') {
    const apiKey = stripLabel(text, 'api key', 'api_key', 'apikey');
    amplitudeSetupState.set(userId, { ...state, step: 'secret_key', apiKey });
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':white_check_mark: Got it ✓  *Step 2 of 2*\n\n' +
                  '*Secret Key:*\n' +
                  'From the same project page — copy the *Secret Key* and send it here:',
          },
        },
      ],
      text: 'Step 2 of 2 — Secret Key',
    });
    return;
  }

  if (state.step === 'secret_key') {
    const secretKey = stripLabel(text, 'secret key', 'secret_key', 'secretkey', 'secret');
    const { apiKey } = state;

    await say({ text: '_Verifying Amplitude connection..._' });

    try {
      await executeAmplitudeTool('amplitude_list_events', {}, { apiKey, secretKey });

      // Success — save encrypted credentials
      await updateWorkspaceAmplitude(workspaceId, {
        apiKey:    encrypt(apiKey),
        secretKey: encrypt(secretKey),
      });
      amplitudeSetupState.delete(userId);

      const jiraUrlAmp = JIRA_AUTH_URL(workspaceId, '');
      await say({
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: ':white_check_mark: *Amplitude connected successfully!*\n\nWell done! Want to connect a project management tool too?' },
          },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Connect Jira' }, style: 'primary', url: jiraUrlAmp, action_id: 'connect_jira' },
              { type: 'button', text: { type: 'plain_text', text: 'Connect ClickUp' }, action_id: 'welcome_connect_clickup' },
              { type: 'button', text: { type: 'plain_text', text: 'Skip for now' }, action_id: 'skip_pm_tool' },
            ],
          },
        ],
        text: 'Amplitude connected successfully!',
      });
    } catch (err) {
      console.error('[AmplitudeSetup] Connection failed:', err.message);
      amplitudeSetupState.set(userId, { step: 'api_key', workspaceId });
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':x: *Connection failed* — one of the credentials may be incorrect.\n' +
                    'Let\'s start over — Step 1 of 2:\n\n' +
                    '*API Key:*\n' +
                    '1. Open Amplitude → Settings → Projects → [your project]\n' +
                    '2. Copy the *API Key* and send it here:',
            },
          },
        ],
        text: 'Connection failed — please try again',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// ClickUp setup flow — 2 steps: API Token → auto-detect team → save
// If the token has access to multiple workspaces, ask the user to choose.
// ---------------------------------------------------------------------------

async function startClickUpStep1(userId, say, workspaceId) {
  clickupSetupState.set(userId, { step: 'token', workspaceId });
  await say({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Connect ClickUp — Step 1 of 2*\n\n' +
                '*Personal API Token:*\n' +
                '1. Open ClickUp → Settings (bottom-left avatar) → Apps\n' +
                '2. Under *API Token*, click *Generate*\n' +
                '3. Copy the token (starts with `pk_`) and send it here:\n\n' +
                '_Sarah will automatically detect your ClickUp workspace._',
        },
      },
    ],
    text: 'Connect ClickUp — Step 1 of 2',
  });
}

async function handleClickUpSetupStep({ userId, workspaceId, text, say }) {
  const state = clickupSetupState.get(userId);

  if (state.step === 'token') {
    const token = stripLabel(text, 'token', 'api token', 'personal api token');

    await say({ text: '_Verifying ClickUp token..._' });

    try {
      const teams = await getClickUpTeams(token);
      if (teams.length === 0) {
        throw new Error('No workspaces found for this token');
      }

      if (teams.length === 1) {
        // Only one workspace — auto-select and save immediately
        const team = teams[0];
        await updateWorkspaceClickup(workspaceId, {
          apiToken: encrypt(token),
          teamId:   team.id,
        });
        clickupSetupState.delete(userId);
        await say({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:white_check_mark: *ClickUp connected!*\n\nWorkspace: *${team.name}*\n\n` +
                      'You can now ask Sarah things like:\n' +
                      '• "Show me all high-priority open tasks"\n' +
                      '• "What tasks are due this week?"\n' +
                      '• "Find tasks related to onboarding"\n\n' +
                      'What would you like to know?',
              },
            },
          ],
          text: 'ClickUp connected!',
        });
      } else {
        // Multiple workspaces — ask user to choose (A, B, C…)
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const teamList = teams.map((t, i) => `${letters[i]}) ${t.name}`).join('\n');
        clickupSetupState.set(userId, { step: 'choose_team', token, teams, workspaceId });
        await say({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:white_check_mark: קיבלתי ✓  *Step 2 of 2*\n\nFound ${teams.length} workspaces. Which one would you like to use?\n\n${teamList}\n\nSend the corresponding letter:`,
              },
            },
          ],
          text: 'Which ClickUp workspace?',
        });
      }
    } catch (err) {
      console.error('[ClickUpSetup] Token validation failed:', err.message);
      clickupSetupState.delete(userId);
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':x: *Connection failed* — the token may be invalid or expired.\n' +
                    'Please try again with `connect clickup`.\n\n' +
                    '_Tip: Make sure you copy the full token starting with `pk_`._',
            },
          },
        ],
        text: 'ClickUp connection failed',
      });
    }
    return;
  }

  if (state.step === 'choose_team') {
    const { token, teams } = state;
    const input = text.trim();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let selectedTeam = null;

    // Try letter selection (A, B, C…)
    const letterIdx = letters.indexOf(input.toUpperCase());
    if (letterIdx >= 0 && letterIdx < teams.length) {
      selectedTeam = teams[letterIdx];
    } else {
      // Try name match (case-insensitive)
      selectedTeam = teams.find(t => t.name.toLowerCase().includes(input.toLowerCase()));
    }

    if (!selectedTeam) {
      const teamList = teams.map((t, i) => `*${i + 1}.* ${t.name}`).join('\n');
      await say({
        text: `Couldn't find that workspace. Please reply with a number:\n\n${teamList}`,
      });
      return;
    }

    await updateWorkspaceClickup(workspaceId, {
      apiToken: encrypt(token),
      teamId:   selectedTeam.id,
    });
    clickupSetupState.delete(userId);
    await say({
      text: `:white_check_mark: *ClickUp connected!*\n\nWorkspace: *${selectedTeam.name}*\n\nAsk Sarah about tasks, priorities, or due dates anytime.`,
    });
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

  // --- Monitoring alert buttons ---
  if (action.action_id === 'monitor_mute') {
    try {
      const { muteMonitor } = await import('../services/monitoringDb.js');
      const { workspace_id: wsId, monitor_id: monId, hours = 24 } = JSON.parse(action.value || '{}');
      const until = new Date(Date.now() + hours * 60 * 60 * 1000);
      await muteMonitor(wsId, monId, until.toISOString());
      await say({ text: `🔕 Monitor *${monId}* muted for ${hours}h (until ${until.toLocaleTimeString()}). Type *connect mixpanel* to re-enable.` });
    } catch (err) {
      await say({ text: `Could not mute monitor: ${err.message}` });
    }
    return;
  }

  if (action.action_id === 'monitor_adjust') {
    const { monitor_id: monId } = JSON.parse(action.value || '{}');
    await say({
      text: `⚙️ To adjust the threshold for *${monId}*, contact your Sarah admin or use the API:\n` +
            `\`threshold: {"type":"pct_change","direction":"both","value":0.20}\` for 20% sensitivity.`,
    });
    return;
  }

  if (action.action_id === 'monitor_why') {
    const { monitor_id: monId, delta_pct, severity } = JSON.parse(action.value || '{}');
    const pct = Math.abs(((delta_pct || 0) * 100)).toFixed(1);
    await say({
      text: `❓ *Why this alert?*\n` +
            `Monitor *${monId}* detected a *${pct}% drop* (severity: ${severity}) vs the rolling baseline.\n` +
            `Sarah fires when the change exceeds the configured threshold (default 10%).\n` +
            `To mute or adjust sensitivity, use the buttons in the alert.`,
    });
    return;
  }

  // --- Skip PM tool suggestion ---
  if (action.action_id === 'skip_pm_tool') {
    await say({ text: "No problem! You can connect anytime by typing *connect jira* or *connect clickup*." });
    return;
  }

  // --- Welcome screen buttons → trigger setup flows ---
  if (action.action_id === 'welcome_connect_mixpanel' || action.action_id === 'confirm_connect_mixpanel') {
    const ws = await getWorkspace(workspaceId);
    // Clear Amplitude if switching
    if (action.action_id === 'confirm_connect_mixpanel') {
      await clearAmplitudeCredentials(workspaceId);
    }
    await startMixpanelStep1(userId, say, workspaceId);
    return;
  }

  if (action.action_id === 'welcome_connect_amplitude' || action.action_id === 'confirm_connect_amplitude') {
    // Clear Mixpanel if switching
    if (action.action_id === 'confirm_connect_amplitude') {
      await clearMixpanelCredentials(workspaceId);
    }
    await startAmplitudeStep1(userId, say, workspaceId);
    return;
  }

  if (action.action_id === 'welcome_connect_clickup') {
    await startClickUpStep1(userId, say, workspaceId);
    return;
  }

  // --- Key Events: conversion event selected ---
  if (action.action_id === 'key_event_conversion_select') {
    const selected = action.value;
    const channelId = body.channel?.id || body.container?.channel_id;
    const messageTs = body.message?.ts;

    if (selected !== '__skip__') {
      await addEventToDictionary(workspaceId, 'main conversion event', selected);
    }

    const confirmText = selected === '__skip__'
      ? '⏩ Skipped — you can set this later with `set event main conversion event = EventName`'
      : `✅ Saved *${selected}* as your main conversion event.`;

    if (messageTs && channelId) {
      await client.chat.update({
        channel: channelId, ts: messageTs,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: confirmText } }],
        text: confirmText,
      });
    }

    // Now ask about error event
    const ws = await getWorkspace(workspaceId);
    if (!ws?.mixpanel_project_id) return;

    let eventNames = [];
    try {
      const creds = {
        projectId: decrypt(ws.mixpanel_project_id),
        username:  decrypt(ws.mixpanel_username),
        secret:    decrypt(ws.mixpanel_secret),
      };
      const events = await executeMixpanelTool('mixpanel_list_events', {}, creds);
      eventNames = (Array.isArray(events) ? events : [])
        .map(e => (typeof e === 'string' ? e : (e?.name ?? null)))
        .filter(Boolean);
    } catch { return; }

    const errorKeywords = ['error', 'exception', 'crash', 'fail', 'fault', 'warning'];
    const candidates = topCandidates(eventNames, errorKeywords);
    if (candidates.length === 0) {
      await say({ text: '🎉 *Sarah is ready!* Ask me anything about your product data.' });
      return;
    }

    await say({
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '🚨 *Last question* — which event represents an *error or problem* in your product?' },
        },
        { type: 'actions', elements: makeEventButtons(candidates, 'key_event_error_select') },
      ],
      text: 'Key events setup — which is your main error event?',
    });
    return;
  }

  // --- Key Events: error event selected ---
  if (action.action_id === 'key_event_error_select') {
    const selected = action.value;
    const channelId = body.channel?.id || body.container?.channel_id;
    const messageTs = body.message?.ts;

    if (selected !== '__skip__') {
      await addEventToDictionary(workspaceId, 'main error event', selected);
    }

    const confirmText = selected === '__skip__'
      ? '⏩ Skipped — you can set this later with `set event main error event = EventName`'
      : `✅ Saved *${selected}* as your main error event.`;

    if (messageTs && channelId) {
      await client.chat.update({
        channel: channelId, ts: messageTs,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: confirmText } }],
        text: confirmText,
      });
    }

    // Final summary
    const ws = await getWorkspace(workspaceId);
    const dict = ws?.event_dictionary
      ? (typeof ws.event_dictionary === 'string' ? JSON.parse(ws.event_dictionary) : ws.event_dictionary)
      : {};
    const convEvent  = dict['main conversion event'];
    const errorEvent = selected !== '__skip__' ? selected : dict['main error event'];

    const lines = ['🎉 *Sarah is ready!* Here\'s what I\'ll track:'];
    if (convEvent)  lines.push(`• Conversion: *${convEvent}*`);
    if (errorEvent) lines.push(`• Errors: *${errorEvent}*`);
    lines.push('', '_Ask me: "What\'s our conversion rate this month?" to get started._');

    await say({
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
      text: lines.join('\n'),
    });
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
      // Fire-and-forget key events onboarding (asks about conversion + error events)
      startKeyEventsOnboarding(workspaceId, say, creds).catch(() => {});

      const jiraUrl = JIRA_AUTH_URL(workspaceId, body?.channel?.id || '');
      await say({
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: ':white_check_mark: *Mixpanel connected successfully!*\n\nWell done! Want to connect a project management tool too?' },
          },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Connect Jira' }, style: 'primary', url: jiraUrl, action_id: 'connect_jira' },
              { type: 'button', text: { type: 'plain_text', text: 'Connect ClickUp' }, action_id: 'welcome_connect_clickup' },
              { type: 'button', text: { type: 'plain_text', text: 'Skip for now' }, action_id: 'skip_pm_tool' },
            ],
          },
        ],
        text: 'Mixpanel connected successfully!',
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

  if (action.action_id === 'welcome_connect_amplitude') {
    const workspace = await getWorkspace(workspaceId);
    if (workspace?.amplitude_api_key) {
      await say({ text: 'Amplitude is already connected ✅' });
      return;
    }
    await startAmplitudeStep1(userId, say, workspaceId);
    return;
  }

  if (action.action_id === 'welcome_connect_clickup') {
    const workspace = await getWorkspace(workspaceId);
    if (workspace?.clickup_api_token) {
      await say({ text: 'ClickUp is already connected ✅' });
      return;
    }
    await startClickUpStep1(userId, say, workspaceId);
    return;
  }
}

// ---------------------------------------------------------------------------
// /sarah settings — slash command
// ---------------------------------------------------------------------------

/**
 * Handle /sarah slash command.
 * /sarah settings  → opens a Settings modal
 * /sarah           → same as /sarah settings
 * anything else    → shows help
 */
export async function handleSarahCommand({ command, ack, client, context }) {
  await ack();
  const workspaceId = command.team_id || context.teamId;
  const userId      = command.user_id;
  const sub         = (command.text || '').trim().toLowerCase();

  if (sub === 'settings' || sub === '') {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      await client.chat.postEphemeral({
        channel: command.channel_id, user: userId,
        text: 'Sarah is not configured for this workspace. Please reinstall.',
      });
      return;
    }

    // Build status lines
    const hasMixpanel  = !!(workspace.mixpanel_project_id && workspace.mixpanel_username);
    const hasAmplitude = !!(workspace.amplitude_api_key && workspace.amplitude_secret_key);
    const hasClickUp   = !!(workspace.clickup_api_token && workspace.clickup_team_id);
    const hasJira      = isJiraValid(workspace);
    let mpProjectId    = null;
    if (hasMixpanel) {
      try { mpProjectId = decrypt(workspace.mixpanel_project_id); } catch {}
    }
    const mixpanelLine = hasMixpanel
      ? `✅ Mixpanel${mpProjectId ? ` (project ${mpProjectId})` : ''}`
      : '❌ Mixpanel — not connected';
    const amplitudeLine = hasAmplitude
      ? '✅ Amplitude'
      : '❌ Amplitude — not connected';
    const clickupLine = hasClickUp
      ? `✅ ClickUp`
      : '❌ ClickUp — not connected';
    const jiraLine = hasJira
      ? `✅ Jira${workspace.jira_cloud_id ? ` (${workspace.jira_cloud_id})` : ''}`
      : '❌ Jira — not connected';

    const rawDict = workspace.event_dictionary
      ? (typeof workspace.event_dictionary === 'string'
          ? JSON.parse(workspace.event_dictionary)
          : workspace.event_dictionary)
      : {};
    const dictCount = Object.keys(rawDict).length;

    const modal = {
      type: 'modal',
      callback_id: 'sarah_settings_modal',
      title:  { type: 'plain_text', text: 'Sarah Settings' },
      submit: { type: 'plain_text', text: 'Save'           },
      close:  { type: 'plain_text', text: 'Close'          },
      private_metadata: JSON.stringify({ workspaceId, channelId: command.channel_id }),
      blocks: [
        // ── Connected tools (read-only) ──────────────────────────────────
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Connected tools*\n${mixpanelLine}\n${amplitudeLine}\n${clickupLine}\n${jiraLine}` },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Type `connect mixpanel`, `connect amplitude`, `connect clickup`, or `connect jira` in chat to connect or reconnect.' }],
        },
        { type: 'divider' },
        // ── Default Jira project (editable) ─────────────────────────────
        {
          type: 'input',
          optional: true,
          block_id: 'jira_project_block',
          label: { type: 'plain_text', text: 'Default Jira project key' },
          hint:  { type: 'plain_text', text: 'Sarah adds project = "KEY" to all Jira queries. Leave blank to search across all projects.' },
          element: {
            type: 'plain_text_input',
            action_id: 'jira_project_input',
            initial_value: workspace.jira_default_project || '',
            placeholder: { type: 'plain_text', text: 'e.g. SAAS' },
          },
        },
        { type: 'divider' },
        // ── Event dictionary (read-only summary) ─────────────────────────
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Event dictionary* — ${dictCount === 0 ? 'empty' : `${dictCount} ${dictCount === 1 ? 'entry' : 'entries'}`}\n` +
              (dictCount > 0
                ? 'Type `show event dictionary` to view · `set event [name] = [description]` to add'
                : 'Type `set event [name] = [description]` to add your first entry.'),
          },
        },
        { type: 'divider' },
        // ── Conversation reset (instruction only) ────────────────────────
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Conversation*\nType `reset` in chat to clear Sarah\'s conversation memory.' },
        },
      ],
    };

    try {
      await client.views.open({ trigger_id: command.trigger_id, view: modal });
    } catch (err) {
      // Fallback: post ephemeral text if modal fails (e.g. trigger_id expired)
      console.warn('[Settings] Modal open failed, posting ephemeral fallback:', err.message);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: [
          '*Sarah Settings*',
          mixpanelLine, jiraLine,
          '',
          `*Default Jira project:* ${workspace.jira_default_project || 'none (all projects)'}`,
          `*Event dictionary:* ${dictCount} ${dictCount === 1 ? 'entry' : 'entries'}`,
          '',
          '_Type `set jira project KEY` to change default project._',
          '_Type `connect mixpanel` / `connect jira` to manage connections._',
        ].join('\n'),
      });
    }
    return;
  }

  // Unknown sub-command → help
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: userId,
    text: 'Available commands:\n• `/sarah settings` — open Sarah settings\n• `/sarah` — same as `/sarah settings`',
  });
}

/**
 * Handle modal submission from /sarah settings.
 * Currently saves: default Jira project key.
 */
export async function handleSarahSettingsSubmission({ ack, view, body, client }) {
  await ack();
  let workspaceId, channelId;
  try {
    ({ workspaceId, channelId } = JSON.parse(view.private_metadata || '{}'));
  } catch { return; }
  if (!workspaceId) return;

  const userId    = body.user?.id;
  const rawKey    = view.state.values?.jira_project_block?.jira_project_input?.value;
  const projectKey = (rawKey || '').trim().toUpperCase() || null;

  try {
    await updateWorkspaceJiraProject(workspaceId, projectKey);
  } catch (err) {
    console.error('[Settings] Failed to save project key:', err.message);
    return;
  }

  const msg = projectKey
    ? `✅ Settings saved — default Jira project set to *${projectKey}*.`
    : '✅ Settings saved — default Jira project cleared (Sarah will search all projects).';

  // Try ephemeral in original channel; fall back to DM if channel unavailable
  const postTarget = async (channel) =>
    client.chat.postEphemeral({ channel, user: userId, text: msg });

  try {
    if (channelId) await postTarget(channelId);
    else           await client.chat.postMessage({ channel: userId, text: msg });
  } catch {
    try { await client.chat.postMessage({ channel: userId, text: msg }); } catch { /* non-critical */ }
  }
}
