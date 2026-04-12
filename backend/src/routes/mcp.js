import express from 'express';
import {
  getAvailableServers,
  getAllServerStatus,
  initiateOAuthFlow,
  handleOAuthCallback,
  handleOAuthCallbackByState,
  disconnectMcp,
  listMcpTools,
} from '../services/mcpManager.js';

const router = express.Router();

// Get list of available MCP servers and their status
router.get('/status', (req, res) => {
  try {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'Session required' });
    }

    const servers = getAvailableServers();
    const status = getAllServerStatus(sessionId);

    res.json({
      servers,
      status,
    });
  } catch (error) {
    console.error('MCP status error:', error);
    res.status(500).json({ error: 'Failed to get MCP status' });
  }
});

// Initiate connection to an MCP server
router.post('/connect/:server', async (req, res) => {
  try {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'Session required' });
    }

    const { server } = req.params;
    const { region = 'us' } = req.body;

    const result = await initiateOAuthFlow(sessionId, server, region);

    res.json({
      authUrl: result.authUrl,
      message: `Please visit the authorization URL to connect to ${server}`,
    });
  } catch (error) {
    console.error('MCP connect error:', error);
    res.status(500).json({ error: error.message || 'Failed to initiate connection' });
  }
});

// OAuth callback endpoint
// Uses state-based lookup so it works even when session isn't preserved across redirect
router.get('/callback', async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(`
        <html>
          <head><title>Connection Failed</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>Connection Failed</h1>
            <p>${error_description || error}</p>
            <p><a href="${FRONTEND_URL}">Return to app</a></p>
          </body>
        </html>
      `);
    }

    if (!code || !state) {
      return res.status(400).send('Missing authorization code or state');
    }

    // Use state-based lookup to find the original session
    const result = await handleOAuthCallbackByState(code, state);

    // Redirect back to the frontend with success
    res.send(`
      <html>
        <head>
          <title>Connected Successfully</title>
          <script>
            // Notify the opener window
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth_complete', server: '${result.serverId}' }, '*');
              window.close();
            } else {
              // Redirect after a short delay
              setTimeout(() => window.location.href = '${FRONTEND_URL}', 2000);
            }
          </script>
        </head>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>Connected Successfully!</h1>
          <p>You have connected to ${result.serverId}.</p>
          <p>You can close this window and return to the chat.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`
      <html>
        <head><title>Connection Error</title></head>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>Connection Error</h1>
          <p>${error.message}</p>
          <p><a href="${FRONTEND_URL}">Return to app</a></p>
        </body>
      </html>
    `);
  }
});

// Disconnect from an MCP server
router.delete('/disconnect/:server', async (req, res) => {
  try {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'Session required' });
    }

    const { server } = req.params;
    await disconnectMcp(sessionId, server);

    res.json({ success: true, message: `Disconnected from ${server}` });
  } catch (error) {
    console.error('MCP disconnect error:', error);
    res.status(500).json({ error: error.message || 'Failed to disconnect' });
  }
});

// List tools available from a connected MCP server
router.get('/tools/:server', async (req, res) => {
  try {
    const sessionId = req.session?.id;
    if (!sessionId) {
      return res.status(401).json({ error: 'Session required' });
    }

    const { server } = req.params;
    const tools = await listMcpTools(sessionId, server);

    res.json({ tools });
  } catch (error) {
    console.error('MCP tools error:', error);
    res.status(500).json({ error: error.message || 'Failed to list tools' });
  }
});

export default router;
