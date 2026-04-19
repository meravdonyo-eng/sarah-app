/**
 * Formats Claude's markdown response into Slack Block Kit blocks.
 * Handles RTL (Hebrew) and LTR (English) automatically.
 */
import { storeReadMore } from './readMoreStore.js';

/**
 * Converts standard markdown to Slack mrkdwn format.
 * Skips content inside code blocks and inline code to preserve it as-is.
 */
export function formatForSlack(text) {
  // Split on fenced code blocks and inline code — odd-indexed segments are code
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments.map((seg, i) => {
    if (i % 2 === 1) return seg; // code — preserve unchanged
    return seg
      .replace(/\*\*(.*?)\*\*/gs, '*$1*')   // **bold** → *bold*
      .replace(/~~(.*?)~~/gs, '~$1~');       // ~~strike~~ → ~strike~
  }).join('');
}

function isRTL(text) {
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  return hebrewChars > text.length * 0.2;
}

function chunkText(text, maxLen = 3000) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cutAt = remaining.lastIndexOf('\n', maxLen) || maxLen;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Strips emojis and the "Bottom Line:" label from Claude's analytical responses.
 * Applied AFTER splitAtReadMore (which needs the raw text to find split points).
 */
function cleanResponseText(text) {
  return text
    // Remove "Bottom Line:" label completely (with or without 🎯 emoji + bold markers)
    .replace(/🎯\s*\*{0,2}Bottom Line:\*{0,2}\s*/gi, '')
    .replace(/\*{0,2}Bottom Line:\*{0,2}\s*/gi, '')
    // Remove emojis before section headers — keep the header text
    .replace(/^📊\s*(\*{0,2}Key Data)/gm, '$1')
    .replace(/^💡\s*(\*{0,2}(?:Key Signal|Recommended Action))/gm, '$1')
    .replace(/^🔍\s*(\*{0,2}(?:Root Cause|\[Show Deep Dive\]))/gm, '$1')
    .replace(/^❓\s*(\*{0,2}What I Don)/gm, '$1')
    .replace(/^➡️\s*(\*{0,2}Next Step)/gm, '$1')
    // Clean up any double blank lines left behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatResponse(text) {
  const blocks = [];
  const cleaned = cleanResponseText(text);
  const rtl = isRTL(cleaned);
  const chunks = chunkText(formatForSlack(cleaned));

  for (const chunk of chunks) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Prepend RLM (U+200F) so Slack renders the block right-to-left
        text: rtl ? '\u200F' + chunk : chunk,
      },
    });
  }

  return blocks;
}

export function formatConnectPrompt(integration) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Connect ${integration}*\nכדי להתחבר ל-${integration}, לחצ/י על הכפתור:`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `Connect ${integration}` },
          style: 'primary',
          action_id: `connect_${integration.toLowerCase()}`,
        },
      ],
    },
  ];
}

export function formatMixpanelSetup() {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*חיבור Mixpanel*\nשלח/י את הפרטים הבאים בהודעות נפרדות:',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '1. *Project ID* — מ-Settings → Project Settings\n2. *Service Account Username* — מ-Settings → Service Accounts\n3. *Service Account Secret* — אותה הגדרה',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'הפרטים מוצפנים ונשמרים בצורה מאובטחת.',
        },
      ],
    },
  ];
}

export function formatError(message) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: ${message}`,
      },
    },
  ];
}

export function formatWelcome(workspace, lang = 'en') {
  const now = new Date();
  const hour = now.getHours();

  let greeting;
  if (lang === 'he') {
    if (hour >= 5 && hour < 12) greeting = 'בוקר טוב ☀️';
    else if (hour >= 12 && hour < 17) greeting = 'צהריים טובים 🌤️';
    else if (hour >= 17 && hour < 22) greeting = 'ערב טוב 🌙';
    else greeting = 'היי 👋';
  } else {
    if (hour >= 5 && hour < 12) greeting = 'Good morning ☀️';
    else if (hour >= 12 && hour < 17) greeting = 'Good afternoon 🌤️';
    else if (hour >= 17 && hour < 22) greeting = 'Good evening 🌙';
    else greeting = 'Hey 👋';
  }

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = days[now.getDay()];
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const hasMixpanel = !!workspace.mixpanel_project_id;
  const hasJira = !!workspace.jira_access_token &&
    (!workspace.jira_expires_at || Date.now() < parseInt(workspace.jira_expires_at));
  const allConnected = hasMixpanel && hasJira;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${greeting}*\n${dayName}, ${dateStr}`,
      },
    },
  ];

  // If everything is connected — just greet, nothing more
  if (allConnected) return blocks;

  // Show connect prompt + buttons for missing tools only
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: lang === 'he'
        ? 'כדי להתחיל, חבר את הכלים שלך:'
        : 'To get started, connect your tools:',
    },
  });

  const buttons = [];
  if (!hasMixpanel) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Connect Mixpanel' },
      style: 'primary',
      action_id: 'welcome_connect_mixpanel',
    });
  }
  if (!hasJira) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Connect Jira' },
      action_id: 'welcome_connect_jira',
    });
  }

  blocks.push({ type: 'actions', elements: buttons });

  return blocks;
}

export function formatMixpanelConfirm(projectId, username) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':white_check_mark: קיבלתי את כל הפרטים:\n' +
              `• *Project ID:* ${projectId}\n` +
              `• *Username:* ${username}\n` +
              `• *Secret:* ••••••••\n\n` +
              'לחצ/י על הכפתור כדי לבדוק את החיבור:',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Connect Mixpanel' },
          style: 'primary',
          action_id: 'mixpanel_connect_confirm',
        },
      ],
    },
  ];
}

export function formatFirstConnection(lang = 'he') {
  const text = lang === 'he'
    ? 'מחוברת! 🎉 הנה כמה שאלות שאפשר לשאול אותי:\n\n' +
      '• באילו נקודות במסע המשתמש מתרחשות הכי הרבה שגיאות, ואיך הן משפיעות על השלמת תהליכים?\n' +
      '• איזה מסלול onboarding מוביל ליותר activation וריטנשן?\n' +
      '• מה ההשפעה של שגיאות על conversion ועל השלמת תהליכים?\n\n' +
      'מה רוצה לדעת?'
    : 'Connected! 🎉 Here are some questions you can ask me:\n\n' +
      '• At which points in the user journey do most errors occur, and how do they impact process completion?\n' +
      '• Which onboarding path leads to higher activation and retention?\n' +
      '• What is the impact of errors on conversion and process completion rates?\n\n' +
      'What would you like to know?';

  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

/**
 * Detects if a response has a Bottom Line / Read more structure.
 * Splits it into summary (shown immediately) and rest (shown on click).
 * Returns null if no split point found.
 */
function splitAtReadMore(text) {
  // Strategy 1: Claude explicitly writes "Read more" (with or without asterisks/emoji)
  const explicitMarker = text.match(/^([\s\S]*?)\n+\*{0,2}Read more[^\n]*\n+([\s\S]+)$/i);
  if (explicitMarker) {
    return { summary: explicitMarker[1].trim(), rest: explicitMarker[2].trim() };
  }

  // Strategy 2: split after "Bottom Line" section, before next major section header
  // A major section header is a line starting with an emoji followed by ** OR just **[Capital]
  const blIdx = text.indexOf('Bottom Line');
  if (blIdx === -1) return null;

  const after = text.slice(blIdx);
  // Emoji range covers most common emoji (U+1F300–U+1FAFF) plus misc symbols
  const nextSection = after.match(/\n{2,}(?=[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]|\*\*[A-Z])/u);
  if (!nextSection) return null;

  const cut = blIdx + nextSection.index;
  return {
    summary: text.slice(0, cut).trim(),
    rest: text.slice(cut).trim(),
  };
}

/**
 * Smart formatter: if the response has a Bottom Line section,
 * shows it with a "Read more ▼" button. Otherwise shows the full response.
 */
export async function formatResponseSmart(text) {
  const split = splitAtReadMore(text);
  if (!split) return formatResponse(text);

  // Clean AFTER splitting so splitAtReadMore can still find emoji/Bottom Line markers
  const cleanedSummary = cleanResponseText(split.summary);
  const cleanedRest = cleanResponseText(split.rest);

  const id = await storeReadMore(cleanedRest);
  const rtl = isRTL(cleanedSummary);

  const blocks = chunkText(formatForSlack(cleanedSummary)).map(chunk => ({
    type: 'section',
    text: { type: 'mrkdwn', text: rtl ? '\u200F' + chunk : chunk },
  }));

  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Read more ▼' },
      action_id: 'read_more',
      value: id,
    }],
  });

  return blocks;
}

export function formatThinking(isComplex = false) {
  const msg = isComplex
    ? '_Sarah is cross-referencing Mixpanel and Jira — this may take a few seconds..._'
    : '_Sarah is thinking..._';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: msg },
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '✕ Cancel' },
        action_id: 'cancel_sarah',
        style: 'danger',
      }],
    },
  ];
}
