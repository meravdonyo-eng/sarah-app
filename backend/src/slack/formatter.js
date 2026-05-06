/**
 * Formats Claude's markdown response into Slack Block Kit blocks.
 * Handles RTL (Hebrew) and LTR (English) automatically.
 */
import { storeReadMore } from './readMoreStore.js';
import { decrypt } from '../services/encryption.js';

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

/**
 * Word-wraps a single LTR line at maxLen chars.
 * Skips RTL lines and lines that contain a URL.
 */
function wrapLine(text, maxLen = 75) {
  if (isRTL(text)) return text;
  if (/https?:\/\/\S+/.test(text)) return text;
  if (text.length <= maxLen) return text;
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxLen) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

/**
 * Classifies each line: header | bullet | text | spacer
 */
function parseSections(text) {
  return text.split('\n').map(line => {
    if (line.trim() === '') return { type: 'spacer', raw: '' };
    // After formatForSlack runs, **Header:** becomes *Header:* — detect single-* bold lines as headers.
    // [^\s*] ensures we don't match bullet items like "* item" (asterisk+space) or "**" leftover.
    if (/^\*[^\s*]/.test(line.trim())) return { type: 'header', raw: line };
    if (/^[•\-*]\s/.test(line.trim()) || /^\d+\.\s/.test(line.trim())) return { type: 'bullet', raw: line };
    return { type: 'text', raw: line };
  });
}

/**
 * Returns true for the Bottom Line block: the first section block that doesn't
 * start with a bold header (*Header:*). The RTL mark prefix (U+200F) is stripped
 * before the check so Hebrew responses are handled correctly.
 */
function isBottomLineBlock(block, index) {
  if (index !== 0 || block.type !== 'section') return false;
  const text = block.text.text.startsWith('‏')
    ? block.text.text.slice(1)
    : block.text.text;
  return !text.startsWith('*');
}

/**
 * Splits Bottom Line text at sentence boundaries so each sentence gets its own line.
 * Rules:
 *   - Only runs when text is longer than maxLineLength chars (short BLs stay untouched)
 *   - Splits at ". " / "! " / "? " when followed by uppercase or digit
 *   - The [^A-Z] lookbehind skips abbreviation-style dots (e.g., vs. or e.g.)
 *   - "word. (Confirmed)" is NOT split — ( is excluded from the lookahead
 *   - Returns original text if no sentence boundary found
 */
function splitBottomLineIntoSentences(text, maxLineLength = 75) {
  if (text.length <= maxLineLength) return text;
  // Require non-uppercase before punctuation to avoid "Mr. Smith" false splits.
  // Require uppercase or digit after to avoid splitting before "(Confirmed)".
  const sentenceEnd = /(?<=[^A-Z][.!?])\s+(?=[A-Z0-9])/g;
  const sentences = text.split(sentenceEnd);
  return sentences.length > 1 ? sentences.join('\n') : text;
}

/**
 * Builds Block Kit section blocks from classified lines.
 * Flushes on spacer or new header.
 */
function buildBlocks(lines, rtl) {
  const blocks = [];
  let current = [];

  function flush() {
    if (current.length === 0) return;
    const content = current.join('\n').trim();
    if (content) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rtl ? '‏' + content : content } });
    }
    current = [];
  }

  for (const line of lines) {
    if (line.type === 'spacer') {
      flush();
    } else if (line.type === 'header' && current.length > 0) {
      flush();
      current.push(wrapLine(line.raw));
    } else {
      current.push(wrapLine(line.raw));
    }
  }
  flush();

  // Apply sentence-level line breaking to the Bottom Line (first block, no header).
  // Skipped for RTL content — Hebrew naturally reads right-to-left without needing manual breaks.
  if (!rtl && blocks.length > 0 && isBottomLineBlock(blocks[0], 0)) {
    const bl = blocks[0];
    const hasRtlPrefix = bl.text.text.startsWith('‏');
    const raw = hasRtlPrefix ? bl.text.text.slice(1) : bl.text.text;
    const broken = splitBottomLineIntoSentences(raw);
    bl.text.text = hasRtlPrefix ? '‏' + broken : broken;
  }

  return blocks;
}

/**
 * Splits any section block whose text exceeds 3000 chars.
 */
function chunkBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type !== 'section' || block.text.text.length <= 3000) {
      result.push(block);
      continue;
    }
    const rtlPrefix = block.text.text.startsWith('‏');
    const raw = rtlPrefix ? block.text.text.slice(1) : block.text.text;
    let remaining = raw;
    while (remaining.length > 3000) {
      const cutAt = remaining.lastIndexOf('\n', 3000) || 3000;
      const chunk = remaining.slice(0, cutAt).trim();
      result.push({ type: 'section', text: { type: 'mrkdwn', text: rtlPrefix ? '‏' + chunk : chunk } });
      remaining = remaining.slice(cutAt).trimStart();
    }
    if (remaining) result.push({ type: 'section', text: { type: 'mrkdwn', text: rtlPrefix ? '‏' + remaining : remaining } });
  }
  return result;
}

/**
 * Injects auto-links into text:
 * - Jira ticket IDs (PROJ-123) → link to Jira browse URL
 * - Word "Mixpanel" → link to Mixpanel project dashboard
 * workspace must have jira_cloud_url and/or mixpanel_project_id set.
 */
export function injectLinks(text, workspace) {
  if (!workspace) return text;

  // Jira ticket IDs (PROJ-123) → browse URL (stored as plain text, no decrypt needed).
  // Use alternation to skip text already inside Slack URL format <...|...> — replacing
  // a ticket ID inside an existing Slack URL would produce broken nested markup.
  const jiraBase = workspace.jira_cloud_url;
  if (jiraBase) {
    text = text.replace(/(<[^>]+>)|(\b[A-Z][A-Z0-9]+-\d+\b)/g, (match, slackUrl, ticketId) => {
      if (slackUrl) return slackUrl; // already a Slack URL — keep as-is
      return `<${jiraBase}/browse/${ticketId}|${ticketId}>`; // bare ticket ID — link it
    });
  }

  // Mixpanel project ID is encrypted in DB — decrypt before building URL
  const encryptedProjectId = workspace.mixpanel_project_id;
  if (encryptedProjectId) {
    let projectId;
    try { projectId = decrypt(encryptedProjectId); } catch { projectId = encryptedProjectId; }
    const mixpanelUrl = `https://mixpanel.com/project/${projectId}`;

    // Replace [MIXPANEL_LINK] placeholder that Claude writes for explicit dashboard links.
    // We do NOT use a broad /\bMixpanel\b/ replacement — if Claude writes a Slack URL like
    // <url|Mixpanel> and the regex also matches the label "Mixpanel", it double-links and
    // produces broken markup like <url|<url2|Mixpanel>>. Controlled placeholder only.
    text = text.replace(/\[MIXPANEL_LINK\]/g, `<${mixpanelUrl}|Mixpanel dashboard>`);
  }

  return text;
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
  const cleaned = cleanResponseText(text);
  const rtl = isRTL(cleaned);
  // DEBUG — log cleaned text before formatForSlack; reveals whether headers have asterisks
  console.log('[DEBUG:preFmt] text before formatForSlack\n---\n' + cleaned + '\n---');
  const slackText = formatForSlack(cleaned);
  const lines = parseSections(slackText);
  const blocks = buildBlocks(lines, rtl);
  return chunkBlocks(blocks);
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

  // Store both halves so we can toggle between them without losing content
  const [restId, summaryId] = await Promise.all([
    storeReadMore(cleanedRest),
    storeReadMore(cleanedSummary),
  ]);
  const rtl = isRTL(cleanedSummary);

  // DEBUG — log summary before formatForSlack; check header syntax (*Key Data:* vs Key Data:)
  console.log('[DEBUG:preFmt] summary before formatForSlack\n---\n' + cleanedSummary + '\n---');
  const slackText = formatForSlack(cleanedSummary);
  const blocks = chunkBlocks(buildBlocks(parseSections(slackText), rtl));

  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Read more ▼' },
      action_id: 'read_more',
      // composite value: restId|summaryId — both needed for the toggle
      value: `${restId}|${summaryId}`,
    }],
  });

  return blocks;
}

const THINKING_MESSAGES = [
  '_Sarah is working on it..._',
  '_Give Sarah a moment..._',
  '_Sarah is on it — this may take a few seconds..._',
  '_Sarah is pulling the data — this may take a few seconds..._',
];

export function formatThinking(isComplex = false) {
  const msg = isComplex
    ? THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)]
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
