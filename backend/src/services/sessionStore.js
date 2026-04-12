// In-memory session store for per-user OAuth tokens
// Structure: { sessionId: { tokens: { mixpanel: { access_token, refresh_token, expires_at } }, mcpClients: {} } }

const sessions = new Map();

// Global index of OAuth states: { state -> sessionId }
const oauthStateIndex = new Map();

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      tokens: {},
      oauthState: {},
    });
  }
  return sessions.get(sessionId);
}

export function setToken(sessionId, provider, tokenData) {
  const session = getSession(sessionId);
  session.tokens[provider] = {
    ...tokenData,
    stored_at: Date.now(),
  };
}

export function getToken(sessionId, provider) {
  const session = getSession(sessionId);
  const token = session.tokens[provider];

  if (!token) {
    return null;
  }

  // Check if token is expired (with 5 minute buffer)
  if (token.expires_at && Date.now() > token.expires_at - 5 * 60 * 1000) {
    return null;
  }

  return token;
}

export function removeToken(sessionId, provider) {
  const session = getSession(sessionId);
  delete session.tokens[provider];
}

export function setOAuthState(sessionId, state, data) {
  const session = getSession(sessionId);
  session.oauthState[state] = {
    ...data,
    sessionId, // Store sessionId in the data for lookup
    created_at: Date.now(),
  };
  // Add to global index for state-only lookup
  oauthStateIndex.set(state, sessionId);
}

export function getOAuthState(sessionId, state) {
  const session = getSession(sessionId);
  const oauthData = session.oauthState[state];

  if (!oauthData) {
    return null;
  }

  // OAuth state expires after 10 minutes
  if (Date.now() - oauthData.created_at > 10 * 60 * 1000) {
    delete session.oauthState[state];
    oauthStateIndex.delete(state);
    return null;
  }

  return oauthData;
}

// Look up OAuth state by just the state token (for callback server)
export function findOAuthStateByToken(state) {
  const sessionId = oauthStateIndex.get(state);
  if (!sessionId) {
    return null;
  }
  return getOAuthState(sessionId, state);
}

export function clearOAuthState(sessionId, state) {
  const session = getSession(sessionId);
  delete session.oauthState[state];
  oauthStateIndex.delete(state);
}

export function getAllTokens(sessionId) {
  const session = getSession(sessionId);
  const validTokens = {};

  for (const [provider, token] of Object.entries(session.tokens)) {
    // Only return non-expired tokens
    if (!token.expires_at || Date.now() <= token.expires_at - 5 * 60 * 1000) {
      validTokens[provider] = {
        connected: true,
        expires_at: token.expires_at,
      };
    }
  }

  return validTokens;
}

export function clearSession(sessionId) {
  sessions.delete(sessionId);
}

// API Settings (API key and model selection)
export function setApiSettings(sessionId, settings) {
  const session = getSession(sessionId);
  session.apiSettings = {
    ...session.apiSettings,
    ...settings,
    updated_at: Date.now(),
  };
}

export function getApiSettings(sessionId) {
  const session = getSession(sessionId);
  return session.apiSettings || {};
}
