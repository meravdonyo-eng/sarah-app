/**
 * Admin UI — password-protected web interface.
 * Routes:
 *   GET  /admin          → login page
 *   POST /admin/login    → verify password, set session cookie
 *   GET  /admin/prompt   → global prompt editor (protected)
 *   POST /admin/prompt   → save global prompt to file
 *   GET  /admin/logout   → clear session
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_PATH = path.join(__dirname, '../../prompts/system_prompt.txt');

const router = express.Router();

// --- Simple in-memory sessions ---
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

function getSessionToken(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/sarah_admin=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

function requireAuth(req, res, next) {
  if (isValidSession(getSessionToken(req))) return next();
  res.redirect('/admin');
}

// --- Read/write prompt file ---
function readPrompt() {
  try {
    const content = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
    if (!content || content.startsWith('#')) return '';
    return content;
  } catch { return ''; }
}

function writePrompt(content) {
  fs.mkdirSync(path.dirname(PROMPT_PATH), { recursive: true });
  fs.writeFileSync(PROMPT_PATH, content, 'utf8');
}

// --- HTML shell ---
function page(title, body) {
  return `<!DOCTYPE html>
<html lang="he" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Sarah Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .topbar { background: #1e293b; border-bottom: 1px solid #334155;
              padding: 14px 32px; display: flex; align-items: center; gap: 16px; }
    .topbar h1 { font-size: 18px; font-weight: 700; color: #38bdf8; }
    .topbar .sub { font-size: 13px; color: #64748b; }
    .topbar a { margin-left: auto; font-size: 13px; color: #94a3b8;
                text-decoration: none; padding: 6px 12px; border: 1px solid #334155;
                border-radius: 6px; }
    .topbar a:hover { background: #334155; color: #e2e8f0; }
    .container { max-width: 960px; margin: 40px auto; padding: 0 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px;
            padding: 28px; margin-bottom: 24px; }
    .card h2 { font-size: 16px; font-weight: 700; color: #f1f5f9; margin-bottom: 6px; }
    .card p  { font-size: 13px; color: #64748b; margin-bottom: 18px; line-height: 1.6; }
    label { display: block; font-size: 12px; font-weight: 600; color: #94a3b8;
            margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    input[type=password] { width: 100%; padding: 10px 14px; background: #0f172a;
      border: 1px solid #334155; border-radius: 8px; color: #e2e8f0;
      font-size: 14px; outline: none; margin-bottom: 18px; }
    input[type=password]:focus { border-color: #38bdf8; }
    textarea { width: 100%; padding: 14px; background: #0f172a; border: 1px solid #334155;
      border-radius: 8px; color: #e2e8f0; font-family: 'SF Mono','Fira Code',monospace;
      font-size: 13px; line-height: 1.65; resize: vertical; min-height: 500px; outline: none; }
    textarea:focus { border-color: #38bdf8; }
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 22px;
           border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
           border: none; transition: all 0.15s; text-decoration: none; }
    .btn-primary { background: #0ea5e9; color: #fff; }
    .btn-primary:hover { background: #0284c7; }
    .btn-ghost  { background: transparent; color: #94a3b8; border: 1px solid #334155; }
    .btn-ghost:hover { background: #1e293b; color: #e2e8f0; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-danger:hover { background: #dc2626; }
    .alert { padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
    .alert-success { background: #14532d; border: 1px solid #22c55e; color: #86efac; }
    .alert-error   { background: #7f1d1d; border: 1px solid #ef4444; color: #fca5a5; }
    .meta { font-size: 12px; color: #475569; margin-top: 8px; }
    .footer { display: flex; align-items: center; justify-content: space-between;
              margin-top: 14px; }
    /* Login */
    .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { background: #1e293b; border: 1px solid #334155; border-radius: 16px;
                  padding: 40px; width: 100%; max-width: 360px; }
    .login-card h2 { font-size: 22px; font-weight: 700; color: #38bdf8; margin-bottom: 4px; }
    .login-card p  { font-size: 14px; color: #64748b; margin-bottom: 28px; }
    .login-card .btn { width: 100%; justify-content: center; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /admin
router.get('/', (req, res) => {
  if (isValidSession(getSessionToken(req))) return res.redirect('/admin/prompt');
  const err = req.query.error
    ? '<div class="alert alert-error">❌ סיסמא שגויה. נסי שוב.</div>' : '';
  res.send(page('כניסה', `
    <div class="login-wrap">
      <div class="login-card">
        <h2>🤖 Sarah Admin</h2>
        <p>ניהול System Prompt גלובלי</p>
        ${err}
        <form method="POST" action="/admin/login">
          <label>סיסמת מנהל</label>
          <input type="password" name="password" placeholder="••••••••" autofocus>
          <button type="submit" class="btn btn-primary">כניסה →</button>
        </form>
      </div>
    </div>
  `));
});

// POST /admin/login
router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { password } = req.body;
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  if (!expected || password !== expected) return res.redirect('/admin?error=1');
  const token = createSession();
  res.setHeader('Set-Cookie',
    `sarah_admin=${token}; HttpOnly; Path=/admin; SameSite=Lax; Max-Age=28800`);
  res.redirect('/admin/prompt');
});

// GET /admin/logout
router.get('/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'sarah_admin=; Path=/admin; Max-Age=0');
  res.redirect('/admin');
});

// GET /admin/prompt
router.get('/prompt', requireAuth, (req, res) => {
  const current = readPrompt();
  const charCount = current.length.toLocaleString('he-IL');
  const saved = req.query.saved === '1'
    ? '<div class="alert alert-success">✅ הפרומפט נשמר ונכנס לתוקף מיד לכל הworkspaces.</div>' : '';

  const errors = {
    nofile: '❌ לא נבחר קובץ.',
    filetype: '❌ סוג קובץ לא נתמך. השתמשי ב-.pdf, .md או .txt בלבד.',
    empty: '❌ הקובץ ריק או לא ניתן לחלץ ממנו טקסט.',
    parse: '❌ שגיאה בפענוח הקובץ. נסי קובץ אחר.',
  };
  const errorMsg = req.query.error && errors[req.query.error]
    ? `<div class="alert alert-error">${errors[req.query.error]}</div>` : '';

  const escaped = current.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  res.send(page('System Prompt', `
    <div class="topbar">
      <h1>🤖 Sarah Admin</h1>
      <span class="sub">Global System Prompt</span>
      <a href="/admin/logout">התנתק</a>
    </div>
    <div class="container">
      ${saved}
      ${errorMsg}

      <div class="card">
        <h2>📎 העלאת קובץ פרומפט</h2>
        <p>העלי קובץ <strong>.pdf</strong>, <strong>.md</strong> או <strong>.txt</strong> — הטקסט יחלץ אוטומטית ויחליף את הפרומפט הנוכחי.</p>
        <form method="POST" action="/admin/upload" enctype="multipart/form-data"
              style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <input type="file" name="file" accept=".pdf,.md,.txt"
                 style="color:#e2e8f0;font-size:14px;flex:1;min-width:200px">
          <button type="submit" class="btn btn-primary">⬆️ העלה וטען</button>
        </form>
      </div>

      <div class="card">
        <h2>System Prompt גלובלי</h2>
        <p>
          פרומפט זה חל על <strong>כל</strong> הworkspaces ועל כל הלקוחות.<br>
          שינוי נכנס לתוקף <strong>מיד</strong> — ללא הפעלה מחדש של השרת.<br>
          אם ריק — Sarah חוזרת לפרומפט ברירת המחדל (V3.7.2 hardcoded).
        </p>
        <form method="POST" action="/admin/prompt">
          <label>תוכן הפרומפט</label>
          <textarea name="prompt" id="prompt"
                    oninput="updateCount(this)">${escaped}</textarea>
          <div class="footer">
            <span class="meta" id="charCount">${charCount} תווים</span>
            <div style="display:flex;gap:10px">
              <button type="submit" name="prompt" value=""
                      class="btn btn-ghost"
                      onclick="return confirm('לאפס לפרומפט ברירת המחדל?')">
                🗑 אפס
              </button>
              <button type="submit" class="btn btn-primary">💾 שמור ועדכן</button>
            </div>
          </div>
        </form>
      </div>
    </div>
    <script>
      function updateCount(el) {
        document.getElementById('charCount').textContent =
          el.value.length.toLocaleString('he-IL') + ' תווים';
      }
    </script>
  `));
});

// POST /admin/prompt — save typed text
router.post('/prompt', requireAuth,
  express.urlencoded({ extended: false, limit: '2mb' }),
  (req, res) => {
    const content = (req.body.prompt || '').trim();
    writePrompt(content);
    res.redirect('/admin/prompt?saved=1');
  }
);

// POST /admin/upload — upload PDF or MD file
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/prompt?error=nofile');

  const ext = path.extname(req.file.originalname).toLowerCase();
  let text = '';

  try {
    if (ext === '.pdf') {
      const data = await pdfParse(req.file.buffer);
      text = data.text.trim();
    } else if (ext === '.md' || ext === '.txt') {
      text = req.file.buffer.toString('utf8').trim();
    } else {
      return res.redirect('/admin/prompt?error=filetype');
    }

    if (!text) return res.redirect('/admin/prompt?error=empty');
    writePrompt(text);
    res.redirect('/admin/prompt?saved=1');
  } catch (err) {
    console.error('Upload parse error:', err);
    res.redirect('/admin/prompt?error=parse');
  }
});

export default router;
