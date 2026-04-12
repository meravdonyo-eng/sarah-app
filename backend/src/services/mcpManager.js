import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getToken, setToken, setOAuthState, getOAuthState, clearOAuthState, findOAuthStateByToken } from './sessionStore.js';
import crypto from 'crypto';

// OAuth callback configuration
// Each MCP server may require a different callback port based on their OAuth whitelist
// In production, use OAUTH_CALLBACK_URL_* env vars (requires providers to whitelist your domain)

// MCP server configurations with per-server callback ports
const MCP_SERVERS = {
  mixpanel: {
    name: 'Mixpanel',
    description: 'Analytics and user behavior tracking',
    endpoints: {
      us: 'https://mcp.mixpanel.com/mcp',
      eu: 'https://mcp-eu.mixpanel.com/mcp',
      india: 'https://mcp-in.mixpanel.com/mcp',
    },
    defaultRegion: 'us',
    registrationEndpoint: 'https://mcp.mixpanel.com/oauth/register',
    callbackPort: 8001, // Mixpanel whitelists localhost:8001
  },
  jira: {
    name: 'Jira (Atlassian Rovo)',
    description: 'Jira and Confluence integration via Atlassian Rovo MCP',
    endpoints: {
      default: 'https://mcp.atlassian.com/v1/mcp',
    },
    defaultRegion: 'default',
    callbackPort: 5598, // Atlassian whitelists localhost:5598
  },
};

// Get the redirect URI for a specific server
function getRedirectUri(serverId) {
  const serverConfig = MCP_SERVERS[serverId];
  const envVar = `OAUTH_CALLBACK_URL_${serverId.toUpperCase()}`;
  if (process.env[envVar]) {
    return process.env[envVar];
  }

  // In production, use the backend's main URL
  if (process.env.NODE_ENV === 'production' && process.env.BACKEND_URL) {
    return `${process.env.BACKEND_URL}/api/mcp/callback`;
  }

  // In development, use the dedicated callback port (for OAuth whitelisting)
  const port = serverConfig?.callbackPort || 8001;
  return `http://localhost:${port}/callback`;
}

// Get all unique callback ports for starting OAuth servers
export function getOAuthCallbackPorts() {
  const ports = new Set();
  for (const config of Object.values(MCP_SERVERS)) {
    if (config.callbackPort) {
      ports.add(config.callbackPort);
    }
  }
  return Array.from(ports);
}

// Cache of MCP clients per session
const clientCache = new Map();

// Cache for dynamically registered client credentials per registration endpoint
const registeredClients = new Map();

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

async function registerDynamicClient(registrationEndpoint, redirectUri) {
  // Cache key includes redirect URI since different servers may need different redirects
  const cacheKey = `${registrationEndpoint}:${redirectUri}`;

  // Return cached client if available for this registration endpoint + redirect URI combo
  if (registeredClients.has(cacheKey)) {
    return registeredClients.get(cacheKey);
  }

  console.log('Registering dynamic OAuth client at:', registrationEndpoint);
  console.log('With redirect URI:', redirectUri);

  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'Sarah Chat App',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Dynamic client registration failed: ${error}`);
  }

  const registeredClient = await response.json();
  registeredClients.set(cacheKey, registeredClient);
  console.log('Registered client_id:', registeredClient.client_id);
  console.log('Allowed redirect_uris:', registeredClient.redirect_uris);

  return registeredClient;
}

// Export MCP_SERVERS for index.js to access callback ports
export { MCP_SERVERS };

export function getAvailableServers() {
  return Object.entries(MCP_SERVERS).map(([id, config]) => ({
    id,
    name: config.name,
    description: config.description,
  }));
}

export function getServerStatus(sessionId, serverId) {
  const token = getToken(sessionId, serverId);
  return {
    id: serverId,
    name: MCP_SERVERS[serverId]?.name || serverId,
    connected: !!token,
    expiresAt: token?.expires_at || null,
  };
}

export function getAllServerStatus(sessionId) {
  return Object.keys(MCP_SERVERS).map((serverId) => getServerStatus(sessionId, serverId));
}

export async function initiateOAuthFlow(sessionId, serverId, region = 'us') {
  const serverConfig = MCP_SERVERS[serverId];
  if (!serverConfig) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }

  const endpoint = serverConfig.endpoints[region] || serverConfig.endpoints[serverConfig.defaultRegion];
  const redirectUri = getRedirectUri(serverId);

  // Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  // MCP servers return 401 with WWW-Authenticate header for OAuth discovery
  try {
    console.log(`Discovering OAuth endpoints from ${serverId} MCP server...`);
    console.log('Using redirect URI:', redirectUri);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'Sarah', version: '1.0.0' },
        },
        id: 1,
      }),
    });

    if (response.status === 401) {
      // Parse WWW-Authenticate header for OAuth metadata
      const wwwAuth = response.headers.get('WWW-Authenticate');
      console.log('WWW-Authenticate header:', wwwAuth);

      let oauthMetadata = null;
      let resourceMetadata = null;

      if (wwwAuth) {
        const resourceMetadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);
        if (resourceMetadataMatch) {
          // MCP-style OAuth discovery via resource_metadata
          const resourceMetadataUrl = resourceMetadataMatch[1];
          console.log('Resource metadata URL:', resourceMetadataUrl);

          resourceMetadata = await fetch(resourceMetadataUrl).then(r => r.json());
          const authServerUrl = resourceMetadata.authorization_servers?.[0];
          console.log('Auth server URL:', authServerUrl);

          if (authServerUrl) {
            const oauthMetadataUrl = `${authServerUrl}.well-known/oauth-authorization-server`;
            console.log('OAuth metadata URL:', oauthMetadataUrl);
            oauthMetadata = await fetch(oauthMetadataUrl).then(r => r.json());
          }
        }
      }

      // Fallback: Try standard OAuth discovery at the server's base URL
      if (!oauthMetadata) {
        const endpointUrl = new URL(endpoint);
        const wellKnownUrl = `${endpointUrl.origin}/.well-known/oauth-authorization-server`;
        console.log('Trying standard OAuth discovery at:', wellKnownUrl);

        try {
          const wellKnownResponse = await fetch(wellKnownUrl);
          if (wellKnownResponse.ok) {
            oauthMetadata = await wellKnownResponse.json();
            console.log('Found OAuth metadata via standard discovery');
          }
        } catch (e) {
          console.log('Standard OAuth discovery failed:', e.message);
        }
      }

      if (oauthMetadata) {
        console.log('OAuth metadata:', JSON.stringify(oauthMetadata, null, 2));

        // Register dynamic client if registration endpoint exists
        let clientId;
        if (oauthMetadata.registration_endpoint) {
          const client = await registerDynamicClient(oauthMetadata.registration_endpoint, redirectUri);
          clientId = client.client_id;
        } else {
          // Fallback to env var for pre-registered clients
          const envClientId = process.env[`${serverId.toUpperCase()}_CLIENT_ID`];
          clientId = envClientId || 'sarah-chat-app';
        }

        // Store OAuth state for callback verification (including redirectUri for token exchange)
        setOAuthState(sessionId, state, {
          serverId,
          region,
          endpoint,
          codeVerifier: pkce.verifier,
          tokenEndpoint: oauthMetadata.token_endpoint,
          authorizationEndpoint: oauthMetadata.authorization_endpoint,
          clientId,
          redirectUri,
        });

        // Build OAuth URL with scopes from metadata
        const authUrl = new URL(oauthMetadata.authorization_endpoint);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');

        // Use supported scopes from metadata
        const scopes = resourceMetadata?.scopes_supported || oauthMetadata.scopes_supported || [];
        if (scopes.length > 0) {
          authUrl.searchParams.set('scope', scopes.join(' '));
        }

        console.log('OAuth URL:', authUrl.toString());

        return {
          authUrl: authUrl.toString(),
          state,
        };
      }
    }

    // If we get here without finding OAuth endpoints, the server might not require auth
    throw new Error('Could not discover OAuth endpoints from MCP server');
  } catch (error) {
    console.error('OAuth discovery error:', error);
    throw error;
  }
}

// Handle OAuth callback with just state token (for callback server on port 8001)
export async function handleOAuthCallbackByState(code, state) {
  const oauthData = findOAuthStateByToken(state);
  if (!oauthData) {
    throw new Error('Invalid or expired OAuth state');
  }

  const { sessionId, serverId, codeVerifier, tokenEndpoint, clientId } = oauthData;
  return handleOAuthCallbackInternal(sessionId, code, state, oauthData);
}

export async function handleOAuthCallback(sessionId, code, state) {
  const oauthData = getOAuthState(sessionId, state);
  if (!oauthData) {
    throw new Error('Invalid or expired OAuth state');
  }

  return handleOAuthCallbackInternal(sessionId, code, state, oauthData);
}

async function handleOAuthCallbackInternal(sessionId, code, state, oauthData) {
  const { serverId, codeVerifier, tokenEndpoint, clientId, redirectUri } = oauthData;

  console.log('Exchanging code for token...');
  console.log('Token endpoint:', tokenEndpoint);
  console.log('Client ID:', clientId);
  console.log('Redirect URI:', redirectUri);

  // Exchange code for token
  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    console.error('Token exchange failed:', error);
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokenData = await tokenResponse.json();
  console.log('Token received successfully');
  console.log('Token type:', tokenData.token_type);
  console.log('Token keys:', Object.keys(tokenData));
  console.log('Access token (first 20 chars):', tokenData.access_token?.substring(0, 20) + '...');

  // Store the token
  setToken(sessionId, serverId, {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
    token_type: tokenData.token_type || 'Bearer',
  });

  // Clear OAuth state
  clearOAuthState(sessionId, state);

  return {
    serverId,
    success: true,
  };
}

async function createMcpClient(sessionId, serverId, region = 'us') {
  const serverConfig = MCP_SERVERS[serverId];
  if (!serverConfig) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }

  const token = getToken(sessionId, serverId);
  if (!token) {
    throw new Error(`Not authenticated with ${serverId}. Please connect first.`);
  }

  const endpoint = serverConfig.endpoints[region] || serverConfig.endpoints[serverConfig.defaultRegion];

  console.log(`Creating MCP client for ${serverId}`);
  console.log('Endpoint:', endpoint);
  console.log('Token type:', token.token_type);
  console.log('Token (first 20 chars):', token.access_token?.substring(0, 20) + '...');

  // Create MCP client with HTTP transport
  // Always use "Bearer" (capitalized) as per HTTP Authorization header standard
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    },
  });

  const client = new Client(
    { name: 'sarah-chat', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  return client;
}

export async function getMcpClient(sessionId, serverId, region = 'us') {
  const cacheKey = `${sessionId}:${serverId}`;

  // Return cached client if available
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  const client = await createMcpClient(sessionId, serverId, region);

  // Cache the client
  clientCache.set(cacheKey, client);

  return client;
}

// Invalidate cached client and create a fresh one
async function reconnectMcpClient(sessionId, serverId, region = 'us') {
  const cacheKey = `${sessionId}:${serverId}`;

  // Close old client if exists
  if (clientCache.has(cacheKey)) {
    try {
      await clientCache.get(cacheKey).close();
    } catch (e) {
      // Ignore close errors
    }
    clientCache.delete(cacheKey);
  }

  const client = await createMcpClient(sessionId, serverId, region);
  clientCache.set(cacheKey, client);
  return client;
}

export async function listMcpTools(sessionId, serverId, region = 'us') {
  try {
    const client = await getMcpClient(sessionId, serverId, region);
    const tools = await client.listTools();
    return tools.tools || [];
  } catch (error) {
    // Retry once on session errors (server-side session expired)
    if (error.code === 404 || error.message?.includes('Session not found')) {
      console.log(`MCP session expired for ${serverId}, reconnecting...`);
      try {
        const client = await reconnectMcpClient(sessionId, serverId, region);
        const tools = await client.listTools();
        return tools.tools || [];
      } catch (retryError) {
        console.error(`Error listing tools for ${serverId} after reconnect:`, retryError);
        return [];
      }
    }
    console.error(`Error listing tools for ${serverId}:`, error);
    return [];
  }
}

export async function callMcpTool(sessionId, serverId, toolName, args, region = 'us') {
  try {
    const client = await getMcpClient(sessionId, serverId, region);
    const result = await client.callTool({ name: toolName, arguments: args });
    return result;
  } catch (error) {
    // Retry once on session errors (server-side session expired)
    if (error.code === 404 || error.message?.includes('Session not found')) {
      console.log(`MCP session expired for ${serverId}, reconnecting...`);
      const client = await reconnectMcpClient(sessionId, serverId, region);
      const result = await client.callTool({ name: toolName, arguments: args });
      return result;
    }
    throw error;
  }
}

export async function disconnectMcp(sessionId, serverId) {
  const cacheKey = `${sessionId}:${serverId}`;

  // Close and remove cached client
  if (clientCache.has(cacheKey)) {
    const client = clientCache.get(cacheKey);
    try {
      await client.close();
    } catch (e) {
      // Ignore close errors
    }
    clientCache.delete(cacheKey);
  }

  // Remove token
  const { removeToken } = await import('./sessionStore.js');
  removeToken(sessionId, serverId);

  return { success: true };
}

export async function getAllAvailableTools(sessionId) {
  const tools = [];

  // Add built-in tools
  tools.push({
    name: 'list_integrations',
    description: 'List available MCP integrations and their connection status',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  });

  tools.push({
    name: 'connect_integration',
    description: 'Connect to an MCP integration like Mixpanel or Jira. Returns an OAuth URL the user must visit to authenticate.',
    input_schema: {
      type: 'object',
      properties: {
        integration: {
          type: 'string',
          description: 'The integration to connect to (e.g., "mixpanel", "jira")',
          enum: Object.keys(MCP_SERVERS),
        },
        region: {
          type: 'string',
          description: 'The region for the integration (us, eu, or india for Mixpanel; default for Jira)',
          enum: ['us', 'eu', 'india', 'default'],
        },
      },
      required: ['integration'],
    },
  });

  // Get tools from connected MCP servers
  for (const serverId of Object.keys(MCP_SERVERS)) {
    const token = getToken(sessionId, serverId);
    if (token) {
      try {
        const mcpTools = await listMcpTools(sessionId, serverId);
        for (const tool of mcpTools) {
          tools.push({
            ...tool,
            _mcpServer: serverId,
          });
        }
      } catch (error) {
        console.error(`Error getting tools from ${serverId}:`, error);
      }
    }
  }

  return tools;
}

export async function executeTool(sessionId, toolName, args) {
  // Handle built-in tools
  if (toolName === 'list_integrations') {
    const status = getAllServerStatus(sessionId);
    return {
      integrations: status,
      message: status.some((s) => s.connected)
        ? `Connected integrations: ${status.filter((s) => s.connected).map((s) => s.name).join(', ')}`
        : 'No integrations connected. Available: ' + status.map((s) => s.name).join(', '),
    };
  }

  if (toolName === 'connect_integration') {
    const { integration, region = 'us' } = args;
    const result = await initiateOAuthFlow(sessionId, integration, region);
    return {
      action: 'oauth_required',
      authUrl: result.authUrl,
      message: `Please click the link to authenticate with ${MCP_SERVERS[integration]?.name || integration}: ${result.authUrl}`,
    };
  }

  // Check if tool belongs to an MCP server
  const allTools = await getAllAvailableTools(sessionId);
  const tool = allTools.find((t) => t.name === toolName);

  if (tool && tool._mcpServer) {
    const result = await callMcpTool(sessionId, tool._mcpServer, toolName, args);
    return result;
  }

  throw new Error(`Unknown tool: ${toolName}`);
}
