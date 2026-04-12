# Sarah App - Production Deployment Guide

This guide explains how to deploy Sarah to production (Railway) with working OAuth integrations.

## Why OAuth Doesn't Work in Production by Default

In development, Sarah runs separate OAuth callback servers on specific ports (8001 for Mixpanel, 5598 for Jira) because these providers have whitelisted only these localhost URLs.

In production, these separate servers don't exist. Instead, all OAuth callbacks go through the main backend server at `/api/mcp/callback`.

**The problem:** Mixpanel and Jira only allow redirect URLs that are registered in their OAuth whitelist. Your production URL is not whitelisted by default.

## Solution: Register Your Production Callback URL

You need to register your production callback URL with each OAuth provider.

### Step 1: Deploy to Railway

1. **Deploy Backend:**
   - Service root: `backend`
   - Build command: `npm install`
   - Start command: `npm start`

2. **Deploy Frontend:**
   - Service root: `frontend`
   - Build command: `npm install && npm run build`
   - Start command: `npm run preview`

3. **Note your Railway URLs:**
   - Backend: `https://your-backend.railway.app`
   - Frontend: `https://your-frontend.railway.app`

### Step 2: Configure Environment Variables in Railway

**Backend Service:**

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-xxx...
SESSION_SECRET=your-random-secret-here-change-me
NODE_ENV=production

# URLs - replace with your actual Railway URLs
BACKEND_URL=https://your-backend.railway.app
FRONTEND_URL=https://your-frontend.railway.app

# Optional (only if you have pre-registered credentials)
# OAUTH_CALLBACK_URL_MIXPANEL=https://your-backend.railway.app/api/mcp/callback
# OAUTH_CALLBACK_URL_JIRA=https://your-backend.railway.app/api/mcp/callback
```

**Frontend Service:**

```bash
# Replace with your actual backend Railway URL
VITE_API_URL=https://your-backend.railway.app
```

### Step 3: Register OAuth Callbacks with Providers

Now you need to whitelist your production callback URL with each provider.

#### For Mixpanel

**Option A: Contact Mixpanel Support (Recommended)**

1. Email Mixpanel support at support@mixpanel.com
2. Request to add your callback URL to the OAuth whitelist:
   ```
   https://your-backend.railway.app/api/mcp/callback
   ```
3. Wait for confirmation (usually 1-2 business days)

**Option B: Use Mixpanel Developer Console (if available)**

1. Log in to your Mixpanel account
2. Go to Settings → OAuth Applications
3. Register a new OAuth application
4. Add redirect URI: `https://your-backend.railway.app/api/mcp/callback`
5. Save the Client ID and update your Railway env vars:
   ```bash
   MIXPANEL_CLIENT_ID=your-client-id
   OAUTH_CALLBACK_URL_MIXPANEL=https://your-backend.railway.app/api/mcp/callback
   ```

#### For Jira (Atlassian Rovo)

1. Go to [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/)
2. Click "Create" → "OAuth 2.0 integration"
3. Fill in:
   - App name: Sarah Chat App
   - Callback URL: `https://your-backend.railway.app/api/mcp/callback`
4. Select required scopes (Jira read/write, Confluence read)
5. Save and copy your Client ID and Client Secret
6. Update Railway environment variables:
   ```bash
   JIRA_CLIENT_ID=your-client-id
   JIRA_CLIENT_SECRET=your-client-secret
   OAUTH_CALLBACK_URL_JIRA=https://your-backend.railway.app/api/mcp/callback
   ```

### Step 4: Test OAuth in Production

1. Open your production frontend: `https://your-frontend.railway.app`
2. In the chat, ask: "Connect to Mixpanel" or "Connect to Jira"
3. Click the OAuth link
4. Complete the authentication flow
5. You should be redirected back to your app with a success message

## Troubleshooting

### "redirect_uri_mismatch" Error

This means the callback URL you're using doesn't match what's registered with the provider.

**Fix:**
1. Check your `BACKEND_URL` environment variable in Railway - it should match exactly (including https://)
2. Verify the redirect URL registered with the provider matches: `https://your-backend.railway.app/api/mcp/callback`
3. Make sure there are no trailing slashes

### "Invalid OAuth state" Error

This means the OAuth state token expired or was lost.

**Causes:**
- Session expired (default: 24 hours)
- Server restarted (sessions are in-memory)

**Fix for Production:**
- Use Redis or a persistent session store (see Known Limitations below)

### OAuth Works Locally but Not in Production

**Check:**
1. `NODE_ENV=production` is set in Railway
2. `BACKEND_URL` points to your production backend (not localhost)
3. Your production callback URL is whitelisted by the provider

## Known Limitations

### 1. In-Memory Sessions

Sessions (including OAuth tokens) are stored in memory and lost on server restart.

**Production Fix:**
- Use `connect-redis` with Redis for persistent sessions
- Or use a database-backed session store

### 2. Provider Whitelist Requirements

Each OAuth provider has their own whitelist and registration process:
- **Mixpanel**: Requires contacting support or using developer console
- **Jira**: Self-service via Atlassian Developer Console

### 3. HTTPS Required

Most OAuth providers require HTTPS for production callbacks. Railway provides HTTPS by default.

## Architecture Differences: Development vs Production

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

The key difference: In production, OAuth callbacks go through the main backend server instead of separate callback servers.

## Need Help?

- Check Railway logs for error messages
- Verify environment variables are set correctly
- Test OAuth endpoints manually: `https://your-backend.railway.app/api/mcp/status`
- Review [CLAUDE.md](./CLAUDE.md) for technical details
