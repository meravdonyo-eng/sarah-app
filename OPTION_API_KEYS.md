# Option: Use API Keys Instead of OAuth

If you cannot get your production URL whitelisted by Mixpanel or Jira, you can bypass OAuth entirely by using direct API key authentication.

## Advantages
- ✅ No OAuth whitelist requirements
- ✅ Works immediately in production
- ✅ Simpler setup
- ✅ No session management needed

## Disadvantages
- ❌ Less secure (API keys vs. user-specific tokens)
- ❌ Single account access (not multi-user)
- ❌ You need to implement the API calls yourself
- ❌ Bypasses MCP servers (lose some MCP features)

---

## Option 3A: Direct Mixpanel API (Recommended)

### Step 1: Get Mixpanel Credentials

1. Log into your Mixpanel account
2. Go to **Project Settings**
3. Note your **Project ID**
4. Go to **Project Settings > Service Accounts**
5. Create a new service account
6. Save the **Username** and **Secret**

### Step 2: Add to Environment Variables

In Railway (or your `.env` file):

```bash
# Mixpanel Direct API (no OAuth)
MIXPANEL_PROJECT_ID=your-project-id
MIXPANEL_SERVICE_ACCOUNT_USERNAME=your-username
MIXPANEL_SERVICE_ACCOUNT_SECRET=your-secret
```

### Step 3: Integrate with Your Backend

I've created a file `backend/src/services/mixpanelDirect.js` that implements direct Mixpanel API calls.

**Update `mcpManager.js` to include these tools:**

```javascript
// In mcpManager.js, add at the top:
import { MIXPANEL_TOOLS, executeMixpanelTool } from './mixpanelDirect.js';

// In getAllAvailableTools(), add after built-in tools:
export async function getAllAvailableTools(sessionId) {
  const tools = [];

  // ... existing built-in tools ...

  // Add direct Mixpanel tools (no OAuth needed)
  if (process.env.MIXPANEL_PROJECT_ID) {
    tools.push(...MIXPANEL_TOOLS);
  }

  // ... rest of the function ...
}

// In executeTool(), add before checking MCP servers:
export async function executeTool(sessionId, toolName, args) {
  // ... existing built-in tool handlers ...

  // Handle direct Mixpanel tools
  if (toolName.startsWith('mixpanel_')) {
    return executeMixpanelTool(toolName, args);
  }

  // ... rest of the function ...
}
```

### Step 4: Test

Ask Claude:
```
"Show me a segmentation of Sign Up events for the last 30 days"
```

Claude will use the direct API tools instead of OAuth.

---

## Option 3B: Direct Jira API

### Step 1: Create API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a name and save the token
4. Note your **email** and **Jira domain** (e.g., `yourcompany.atlassian.net`)

### Step 2: Add to Environment Variables

```bash
# Jira Direct API (no OAuth)
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token
JIRA_DOMAIN=yourcompany.atlassian.net
```

### Step 3: Create Jira Direct Service

Create `backend/src/services/jiraDirect.js`:

```javascript
import fetch from 'node-fetch';

const JIRA_API_VERSION = '3';

function getJiraCredentials() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const domain = process.env.JIRA_DOMAIN;

  if (!email || !token || !domain) {
    throw new Error('Jira credentials not configured');
  }

  return { email, token, domain };
}

async function jiraRequest(endpoint, method = 'GET', body = null) {
  const { email, token, domain } = getJiraCredentials();
  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  const url = `https://${domain}/rest/api/${JIRA_API_VERSION}/${endpoint}`;

  const options = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jira API error: ${response.status} - ${error}`);
  }

  return response.json();
}

export async function searchJiraIssues(jql, fields = ['summary', 'status', 'assignee']) {
  return jiraRequest(`search?jql=${encodeURIComponent(jql)}&fields=${fields.join(',')}`);
}

export async function getJiraIssue(issueKey) {
  return jiraRequest(`issue/${issueKey}`);
}

export async function createJiraIssue(projectKey, summary, description, issueType = 'Task') {
  return jiraRequest('issue', 'POST', {
    fields: {
      project: { key: projectKey },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }],
          },
        ],
      },
      issuetype: { name: issueType },
    },
  });
}

export const JIRA_TOOLS = [
  {
    name: 'jira_search',
    description: 'Search Jira issues using JQL (Jira Query Language)',
    input_schema: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description: 'JQL query (e.g., "project = PROJ AND status = Open")',
        },
        fields: {
          type: 'array',
          description: 'Fields to return',
          items: { type: 'string' },
        },
      },
      required: ['jql'],
    },
  },
  {
    name: 'jira_get_issue',
    description: 'Get details of a specific Jira issue',
    input_schema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key (e.g., "PROJ-123")',
        },
      },
      required: ['issueKey'],
    },
  },
  {
    name: 'jira_create_issue',
    description: 'Create a new Jira issue',
    input_schema: {
      type: 'object',
      properties: {
        projectKey: {
          type: 'string',
          description: 'Project key (e.g., "PROJ")',
        },
        summary: {
          type: 'string',
          description: 'Issue summary/title',
        },
        description: {
          type: 'string',
          description: 'Issue description',
        },
        issueType: {
          type: 'string',
          description: 'Issue type (e.g., "Task", "Bug", "Story")',
        },
      },
      required: ['projectKey', 'summary', 'description'],
    },
  },
];

export async function executeJiraTool(toolName, args) {
  switch (toolName) {
    case 'jira_search':
      return searchJiraIssues(args.jql, args.fields);
    case 'jira_get_issue':
      return getJiraIssue(args.issueKey);
    case 'jira_create_issue':
      return createJiraIssue(args.projectKey, args.summary, args.description, args.issueType);
    default:
      throw new Error(`Unknown Jira tool: ${toolName}`);
  }
}
```

---

## Option 3C: Hybrid Approach

You can support **both** OAuth (for local development) **and** API keys (for production):

```javascript
export async function getAllAvailableTools(sessionId) {
  const tools = [];

  // ... built-in tools ...

  // Try OAuth first (for local dev)
  for (const serverId of Object.keys(MCP_SERVERS)) {
    const token = getToken(sessionId, serverId);
    if (token) {
      try {
        const mcpTools = await listMcpTools(sessionId, serverId);
        tools.push(...mcpTools.map(t => ({ ...t, _mcpServer: serverId })));
      } catch (error) {
        console.error(`Error getting MCP tools from ${serverId}:`, error);
      }
    }
  }

  // Fallback to direct API (for production)
  if (tools.length === 0) {
    if (process.env.MIXPANEL_PROJECT_ID) {
      tools.push(...MIXPANEL_TOOLS);
    }
    if (process.env.JIRA_API_TOKEN) {
      tools.push(...JIRA_TOOLS);
    }
  }

  return tools;
}
```

This way:
- **Local development**: Uses OAuth with MCP servers
- **Production**: Falls back to direct API keys

---

## Summary

| Method | Setup Effort | Production Ready | Multi-User | Security |
|--------|--------------|------------------|------------|----------|
| **OAuth + Whitelist** | High | ✅ (if whitelisted) | ✅ Yes | ⭐⭐⭐ Best |
| **Direct API Keys** | Low | ✅ Yes | ❌ Single account | ⭐⭐ Good |
| **Hybrid** | Medium | ✅ Yes | ❌ Single account | ⭐⭐ Good |

**My Recommendation:**
- If you can get whitelisted → Use OAuth (current approach)
- If you can't get whitelisted → Use Direct API Keys (Option 3A/3B)
- If unsure → Use Hybrid approach (works everywhere)
