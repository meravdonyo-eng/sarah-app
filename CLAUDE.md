# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sarah is a web application that provides a chat interface to communicate with Claude AI, with support for MCP (Model Context Protocol) integrations like Mixpanel. It consists of a React frontend and a Node.js/Express backend with an agentic tool execution loop.

## Architecture

```
┌─────────────────────┐                      ┌─────────────────────────────────┐
│   Frontend (React)  │                      │       Backend (Node.js)         │
│                     │  POST /api/chat      │                                 │
│  - Chat interface   │ ──────────────────▶  │  ┌─────────────────────────┐   │
│  - Integration UI   │                      │  │   Claude Service        │   │
│  - OAuth handling   │  GET /api/mcp/*      │  │   - Agentic loop        │   │
│                     │ ──────────────────▶  │  │   - Tool execution      │   │
└─────────────────────┘                      │  └───────────┬─────────────┘   │
        :5173                                │              │                  │
                                             │  ┌───────────▼─────────────┐   │
                                             │  │   MCP Manager           │   │
                                             │  │   - OAuth flow          │   │
                                             │  │   - Per-user clients    │   │
                                             │  └───────────┬─────────────┘   │
                                             │              │           :3001 │
                                             │  ┌───────────▼─────────────┐   │
                                             │  │   Session Store         │   │
                                             │  │   - OAuth tokens        │   │
                                             │  └─────────────────────────┘   │
                                             └─────────────────────────────────┘
                                                            │
         ┌──────────────────────────────────────────────────┘
         │ OAuth Callback Server (:8001)
         │
         ▼
┌─────────────────────────────────────┐
│  Mixpanel MCP Server                │
│  https://mcp.mixpanel.com/mcp       │
│  - Segmentation, Funnels            │
│  - Retention, Event discovery       │
└─────────────────────────────────────┘
```

## Tech Stack

- **Frontend**: React 18 with Vite, Tailwind CSS
- **Backend**: Node.js with Express, express-session
- **AI**: Anthropic SDK (@anthropic-ai/sdk)
- **MCP**: @modelcontextprotocol/sdk
- **Deployment**: Railway

## Project Structure

```
sarah-app/
├── frontend/                    # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx
│   │   ├── config.js            # API URL configuration
│   │   ├── components/
│   │   │   ├── ChatInterface.jsx
│   │   │   ├── IntegrationStatus.jsx
│   │   │   └── AgentConfig.jsx
│   │   └── main.jsx
│   ├── railway.toml             # Railway deployment config
│   └── vite.config.js
├── backend/                     # Express backend
│   ├── src/
│   │   ├── index.js             # Server entry + OAuth callback server
│   │   ├── routes/
│   │   │   ├── chat.js          # POST /api/chat (with tools)
│   │   │   ├── mcp.js           # MCP status & OAuth endpoints
│   │   │   └── agent.js         # Agent configuration
│   │   └── services/
│   │       ├── claude.js        # Claude API + agentic loop
│   │       ├── mcpManager.js    # MCP client & OAuth management
│   │       └── sessionStore.js  # In-memory token storage
│   ├── railway.toml             # Railway deployment config
│   └── .env.example
└── package.json                 # Root workspace
```

## Development Commands

### Setup
```bash
# Install all dependencies (from root)
npm install

# Copy and configure environment variables
cp backend/.env.example backend/.env
# Edit backend/.env and add your ANTHROPIC_API_KEY
```

### Running the Application
```bash
# Run both frontend and backend concurrently (from root)
npm run dev

# Or run separately:
npm run dev:backend   # Backend on http://localhost:3001 + OAuth on :8001
npm run dev:frontend  # Frontend on http://localhost:5173
```

## API Endpoints

### POST /api/chat
Send a message to Claude with optional tool support.

**Request:**
```json
{
  "message": "your question here",
  "useTools": true,
  "conversationHistory": []
}
```

**Response:**
```json
{
  "response": "Claude's answer",
  "conversationHistory": [...],
  "oauthActions": [{ "type": "oauth", "authUrl": "..." }]
}
```

### GET /api/mcp/status
Get MCP integration connection status.

### POST /api/mcp/connect/:server
Initiate OAuth flow for an MCP server (e.g., mixpanel).

### GET /health
Health check endpoint returns `{ "status": "ok" }`.

## Environment Variables

### Backend (`backend/.env`)
```
ANTHROPIC_API_KEY=your-api-key      # Required
PORT=3001                            # Server port
SESSION_SECRET=random-secret         # Session encryption
FRONTEND_URL=http://localhost:5173   # For CORS & redirects
```

### Frontend (`frontend/.env`)
```
VITE_API_URL=                        # Empty for dev (uses proxy), set for production
```

## MCP Integration

### Supported Integrations
- **Mixpanel** - Analytics and user behavior tracking
  - OAuth via MCP dynamic client registration
  - Tools: segmentation, funnels, retention, events

- **Jira (Atlassian Rovo)** - Jira and Confluence integration
  - OAuth 2.1 via Atlassian MCP server
  - Tools: Jira issues, Confluence pages, search, and more
  - Endpoint: https://mcp.atlassian.com/v1/mcp

### OAuth Flow
1. User asks to connect to Mixpanel or Jira
2. Claude uses `connect_integration` tool
3. Backend discovers OAuth endpoints from MCP server
4. User authenticates via popup
5. Callback on port 8001 exchanges code for token
6. Token stored in session, MCP tools become available

### Built-in Tools
- `list_integrations` - Show available/connected integrations
- `connect_integration` - Initiate OAuth for an integration

## Deployment (Railway)

Both services have `railway.toml` configs. Deploy from GitHub:

1. Backend service: root directory `backend`
2. Frontend service: root directory `frontend`
3. Set environment variables in Railway dashboard

### Required Environment Variables for Production

**Backend:**
- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `SESSION_SECRET` - Random secret for session encryption
- `BACKEND_URL` - Your backend URL (e.g., `https://your-backend.railway.app`)
- `FRONTEND_URL` - Your frontend URL (e.g., `https://your-frontend.railway.app`)
- `NODE_ENV=production` - Set to production mode

**Frontend:**
- `VITE_API_URL` - Your backend URL (e.g., `https://your-backend.railway.app`)

### OAuth Integrations in Production

**Important:** OAuth integrations require whitelisting your production callback URL with each provider.

**For Mixpanel:**
1. Contact Mixpanel support or use their developer console
2. Request to add your backend callback URL to their OAuth whitelist:
   - Callback URL: `https://your-backend.railway.app/api/mcp/callback`
3. OR set `OAUTH_CALLBACK_URL_MIXPANEL` env var if you have a custom redirect URL

**For Jira (Atlassian):**
1. Register an OAuth 2.0 app at https://developer.atlassian.com/console/myapps/
2. Add your callback URL in the OAuth settings:
   - Callback URL: `https://your-backend.railway.app/api/mcp/callback`
3. Save your Client ID and Client Secret (if needed)
4. OR set `OAUTH_CALLBACK_URL_JIRA` env var if you have a custom redirect URL

**Note:** In development, dedicated callback servers run on localhost:8001 (Mixpanel) and localhost:5598 (Jira) to match provider whitelists. In production, all callbacks go through the main backend server at `/api/mcp/callback`.

## Known Limitations

- **In-memory sessions**: Tokens lost on server restart (use Redis for production)
- **OAuth whitelists**: Each provider has specific localhost port requirements:
  - Mixpanel: `localhost:8001`
  - Atlassian/Jira: `localhost:5598`
  - Development starts callback servers on all required ports automatically
- **Single region**: Currently hardcoded to US Mixpanel endpoint
