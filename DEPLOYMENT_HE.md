# מדריך פריסת Sarah לסביבת Production

מדריך זה מסביר איך לפרוס את Sarah לסביבת ייצור (Railway) עם אינטגרציות OAuth עובדות.

## למה OAuth לא עובד ב-Production באופן אוטומטי?

בסביבת פיתוח, Sarah מריצה שרתי OAuth callback נפרדים על פורטים ספציפיים (8001 עבור Mixpanel, 5598 עבור Jira) כי הספקים האלה הוסיפו רק את כתובות ה-localhost האלה לרשימת ההיתרים שלהם.

ב-production, השרתים הנפרדים האלה לא קיימים. במקום זה, כל ה-callbacks של OAuth עוברים דרך השרת הראשי ב-`/api/mcp/callback`.

**הבעיה:** Mixpanel ו-Jira מאפשרים רק redirect URLs שרשומים ברשימת ההיתרים של OAuth שלהם. כתובת ה-production שלך לא נמצאת ברשימת ההיתרים כברירת מחדל.

## הפתרון: רשמי את כתובת ה-Callback של Production

את צריכה לרשום את כתובת ה-callback של production אצל כל ספק OAuth.

### שלב 1: פרסי ל-Railway

1. **פרסי את ה-Backend:**
   - Service root: `backend`
   - Build command: `npm install`
   - Start command: `npm start`

2. **פרסי את ה-Frontend:**
   - Service root: `frontend`
   - Build command: `npm install && npm run build`
   - Start command: `npm run preview`

3. **שמרי את כתובות Railway שלך:**
   - Backend: `https://your-backend.railway.app`
   - Frontend: `https://your-frontend.railway.app`

### שלב 2: הגדירי משתני סביבה ב-Railway

**Backend Service:**

```bash
# חובה
ANTHROPIC_API_KEY=sk-ant-xxx...
SESSION_SECRET=סוד-רנדומלי-שלך-כאן
NODE_ENV=production

# כתובות - החליפי עם כתובות Railway האמיתיות שלך
BACKEND_URL=https://your-backend.railway.app
FRONTEND_URL=https://your-frontend.railway.app

# אופציונלי (רק אם יש לך credentials רשומים מראש)
# OAUTH_CALLBACK_URL_MIXPANEL=https://your-backend.railway.app/api/mcp/callback
# OAUTH_CALLBACK_URL_JIRA=https://your-backend.railway.app/api/mcp/callback
```

**Frontend Service:**

```bash
# החליפי עם כתובת ה-backend Railway האמיתית שלך
VITE_API_URL=https://your-backend.railway.app
```

### שלב 3: רשמי את ה-OAuth Callbacks אצל הספקים

עכשיו את צריכה להוסיף את כתובת ה-callback של production לרשימת ההיתרים אצל כל ספק.

#### עבור Mixpanel

**אפשרות א': צרי קשר עם תמיכת Mixpanel (מומלץ)**

1. שלחי אימייל לתמיכה של Mixpanel: support@mixpanel.com
2. בקשי להוסיף את כתובת ה-callback שלך לרשימת ההיתרים של OAuth:
   ```
   https://your-backend.railway.app/api/mcp/callback
   ```
3. המתיני לאישור (בדרך כלל 1-2 ימי עסקים)

**אפשרות ב': השתמשי ב-Mixpanel Developer Console (אם זמין)**

1. התחברי לחשבון Mixpanel שלך
2. עברי ל-Settings → OAuth Applications
3. רשמי יישום OAuth חדש
4. הוסיפי redirect URI: `https://your-backend.railway.app/api/mcp/callback`
5. שמרי את ה-Client ID ועדכני את משתני הסביבה ב-Railway:
   ```bash
   MIXPANEL_CLIENT_ID=your-client-id
   OAUTH_CALLBACK_URL_MIXPANEL=https://your-backend.railway.app/api/mcp/callback
   ```

#### עבור Jira (Atlassian Rovo)

1. עברי ל-[Atlassian Developer Console](https://developer.atlassian.com/console/myapps/)
2. לחצי "Create" → "OAuth 2.0 integration"
3. מלאי:
   - App name: Sarah Chat App
   - Callback URL: `https://your-backend.railway.app/api/mcp/callback`
4. בחרי את ה-scopes הנדרשים (Jira read/write, Confluence read)
5. שמרי והעתיקי את ה-Client ID ו-Client Secret
6. עדכני משתני סביבה ב-Railway:
   ```bash
   JIRA_CLIENT_ID=your-client-id
   JIRA_CLIENT_SECRET=your-client-secret
   OAUTH_CALLBACK_URL_JIRA=https://your-backend.railway.app/api/mcp/callback
   ```

### שלב 4: בדקי את OAuth ב-Production

1. פתחי את ה-frontend של production: `https://your-frontend.railway.app`
2. בצ'אט, בקשי: "Connect to Mixpanel" או "Connect to Jira"
3. לחצי על קישור ה-OAuth
4. השלימי את תהליך האימות
5. את אמורה לחזור לאפליקציה שלך עם הודעת הצלחה

## פתרון בעיות

### שגיאת "redirect_uri_mismatch"

המשמעות היא שכתובת ה-callback שאת משתמשת בה לא תואמת למה שרשום אצל הספק.

**פתרון:**
1. בדקי את משתנה הסביבה `BACKEND_URL` ב-Railway - זה צריך להתאים בדיוק (כולל https://)
2. ודאי שכתובת ה-redirect הרשומה אצל הספק תואמת: `https://your-backend.railway.app/api/mcp/callback`
3. ודאי שאין קווים נטויים בסוף

### שגיאת "Invalid OAuth state"

המשמעות היא ש-token ה-state של OAuth פג או אבד.

**סיבות:**
- ה-Session פג (ברירת מחדל: 24 שעות)
- השרת אותחל מחדש (sessions נמצאים ב-memory)

**פתרון ל-Production:**
- השתמשי ב-Redis או ב-session store קבוע (ראי מגבלות ידועות למטה)

### OAuth עובד מקומית אבל לא ב-Production

**בדקי:**
1. `NODE_ENV=production` מוגדר ב-Railway
2. `BACKEND_URL` מצביע על ה-backend של production שלך (לא localhost)
3. כתובת ה-callback של production שלך נמצאת ברשימת ההיתרים אצל הספק

## מגבלות ידועות

### 1. Sessions בזיכרון

Sessions (כולל tokens של OAuth) נשמרים בזיכרון ואובדים כשהשרת מופעל מחדש.

**פתרון ל-Production:**
- השתמשי ב-`connect-redis` עם Redis עבור sessions קבועים
- או השתמשי ב-session store מבוסס מסד נתונים

### 2. דרישות רשימת היתרים של ספקים

לכל ספק OAuth יש רשימת היתרים ותהליך רישום משלו:
- **Mixpanel**: דורש פנייה לתמיכה או שימוש ב-developer console
- **Jira**: שירות עצמי דרך Atlassian Developer Console

### 3. נדרש HTTPS

רוב ספקי ה-OAuth דורשים HTTPS עבור callbacks של production. Railway מספק HTTPS כברירת מחדל.

## הבדלים באדריכלות: Development מול Production

### Development
```
Frontend (:5173) → Backend (:3001) → Claude API
                                   ↓
                      OAuth Callbacks (:8001, :5598)
                                   ↓
                           Mixpanel/Jira MCP
```

### Production
```
Frontend (Railway) → Backend (Railway) → Claude API
                                       ↓
                      OAuth Callbacks (/api/mcp/callback)
                                       ↓
                              Mixpanel/Jira MCP
```

ההבדל המרכזי: ב-production, callbacks של OAuth עוברים דרך השרת הראשי במקום שרתי callback נפרדים.

## צריכה עזרה?

- בדקי logs של Railway להודעות שגיאה
- ודאי שמשתני הסביבה מוגדרים נכון
- בדקי endpoints של OAuth ידנית: `https://your-backend.railway.app/api/mcp/status`
- עיני ב-[CLAUDE.md](./CLAUDE.md) לפרטים טכניים
