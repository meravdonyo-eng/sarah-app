import axios from 'axios';
import { updateWorkspaceJira } from './db.js';
import { encrypt } from './encryption.js';

const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// --- Token refresh ---
export async function refreshJiraToken(creds) {
  const response = await axios.post(ATLASSIAN_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: process.env.JIRA_CLIENT_ID,
    client_secret: process.env.JIRA_CLIENT_SECRET,
    refresh_token: creds.refreshToken,
  });

  const { access_token, refresh_token, expires_in } = response.data;
  const expiresAt = Date.now() + expires_in * 1000;

  await updateWorkspaceJira(creds.workspaceId, {
    accessToken: encrypt(access_token),
    refreshToken: encrypt(refresh_token),
    cloudId: creds.cloudId,
    expiresAt,
  });

  return { ...creds, accessToken: access_token, expiresAt };
}

async function getValidCreds(creds) {
  if (Date.now() > creds.expiresAt - 60000) {
    return refreshJiraToken(creds);
  }
  return creds;
}

function jiraClient(accessToken, cloudId) {
  return axios.create({
    baseURL: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
}

// --- OAuth helpers ---
export function buildJiraAuthUrl(workspaceId) {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: process.env.JIRA_CLIENT_ID,
    scope: 'read:jira-work read:jira-user offline_access',
    redirect_uri: process.env.JIRA_REDIRECT_URI,
    state: workspaceId,
    response_type: 'code',
    prompt: 'consent',
  });
  return `https://auth.atlassian.com/authorize?${params}`;
}

export async function exchangeJiraCode(code, workspaceId) {
  const tokenRes = await axios.post(ATLASSIAN_TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: process.env.JIRA_CLIENT_ID,
    client_secret: process.env.JIRA_CLIENT_SECRET,
    code,
    redirect_uri: process.env.JIRA_REDIRECT_URI,
  });

  const { access_token, refresh_token, expires_in } = tokenRes.data;
  const expiresAt = Date.now() + expires_in * 1000;

  // Get cloud ID
  const resourcesRes = await axios.get(ATLASSIAN_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const cloudId = resourcesRes.data[0]?.id;
  if (!cloudId) throw new Error('No Jira cloud resource found');

  await updateWorkspaceJira(workspaceId, {
    accessToken: encrypt(access_token),
    refreshToken: encrypt(refresh_token),
    cloudId,
    expiresAt,
  });

  return { cloudId };
}

// --- Tool definitions for Claude ---
export const JIRA_TOOLS = [
  {
    name: 'jira_search_issues',
    description: 'Search Jira issues using JQL query',
    input_schema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'JQL query (e.g. "project = MYPROJ AND status = Open")' },
        max_results: { type: 'number', description: 'Max results to return (default 20)' },
      },
      required: ['jql'],
    },
  },
  {
    name: 'jira_get_issue',
    description: 'Get details of a specific Jira issue by key',
    input_schema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string', description: 'Issue key (e.g. "PROJ-123")' },
      },
      required: ['issue_key'],
    },
  },
  {
    name: 'jira_list_projects',
    description: 'List all Jira projects the user has access to',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'jira_get_sprint_issues',
    description: 'Get all issues in the current active sprint for a board',
    input_schema: {
      type: 'object',
      properties: {
        board_id: { type: 'number', description: 'Jira board ID' },
      },
      required: ['board_id'],
    },
  },
];

export async function executeJiraTool(toolName, args, creds) {
  const validCreds = await getValidCreds(creds);
  const client = jiraClient(validCreds.accessToken, validCreds.cloudId);

  switch (toolName) {
    case 'jira_search_issues': {
      const res = await client.post('/search/jql', {
        jql: args.jql,
        maxResults: args.max_results || 20,
      });
      return res.data;
    }
    case 'jira_get_issue': {
      const res = await client.get(`/issue/${args.issue_key}`);
      return res.data;
    }
    case 'jira_list_projects': {
      const res = await client.get('/project');
      return res.data;
    }
    case 'jira_get_sprint_issues': {
      // Requires Jira Software API
      const res = await axios.get(
        `https://api.atlassian.com/ex/jira/${validCreds.cloudId}/rest/agile/1.0/board/${args.board_id}/sprint`,
        { headers: { Authorization: `Bearer ${validCreds.accessToken}` } }
      );
      const activeSprint = res.data.values?.find((s) => s.state === 'active');
      if (!activeSprint) return { error: 'No active sprint found' };
      const issuesRes = await axios.get(
        `https://api.atlassian.com/ex/jira/${validCreds.cloudId}/rest/agile/1.0/sprint/${activeSprint.id}/issue`,
        { headers: { Authorization: `Bearer ${validCreds.accessToken}` } }
      );
      return issuesRes.data;
    }
    default:
      throw new Error(`Unknown Jira tool: ${toolName}`);
  }
}
