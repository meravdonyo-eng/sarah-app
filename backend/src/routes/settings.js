import express from 'express';
import { getApiSettings, setApiSettings } from '../services/sessionStore.js';

const router = express.Router();

// Get current settings
router.get('/', (req, res) => {
  const sessionId = req.session.id;
  const settings = getApiSettings(sessionId);

  res.json({
    hasApiKey: !!settings.apiKey,
    model: settings.model || null,
    // Don't expose the actual API key, just indicate if one is set
  });
});

// Save settings
router.post('/', (req, res) => {
  const sessionId = req.session.id;
  const { apiKey, model } = req.body;

  const updates = {};
  if (apiKey !== undefined) {
    updates.apiKey = apiKey || null; // Allow clearing by sending empty string
  }
  if (model !== undefined) {
    updates.model = model;
  }

  setApiSettings(sessionId, updates);

  const settings = getApiSettings(sessionId);
  res.json({
    hasApiKey: !!settings.apiKey,
    model: settings.model || null,
    message: 'Settings saved successfully',
  });
});

// Delete API key
router.delete('/api-key', (req, res) => {
  const sessionId = req.session.id;
  setApiSettings(sessionId, { apiKey: null });

  res.json({
    hasApiKey: false,
    message: 'API key removed',
  });
});

// Fetch available models
router.get('/models', async (req, res) => {
  const sessionId = req.session.id;
  const settings = getApiSettings(sessionId);

  // Use user's API key if available, otherwise fall back to server key
  const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      error: 'No API key configured',
      message: 'Please add your Anthropic API key in settings',
    });
  }

  try {
    // Use direct API call since SDK may not have models.list()
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return res.status(401).json({
          error: 'Invalid API key',
          message: 'The provided API key is invalid',
        });
      }
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();

    // Filter and format models for the frontend
    const models = (data.data || [])
      .filter(model => model.id.startsWith('claude'))
      .map(model => ({
        id: model.id,
        name: model.display_name || model.id,
        created: model.created_at,
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ models });
  } catch (error) {
    console.error('Error fetching models:', error);

    res.status(500).json({
      error: 'Failed to fetch models',
      message: error.message,
    });
  }
});

// Validate API key
router.post('/validate-key', async (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey) {
    return res.status(400).json({
      valid: false,
      message: 'API key is required',
    });
  }

  try {
    // Use direct API call to validate the key
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (response.ok) {
      res.json({
        valid: true,
        message: 'API key is valid',
      });
    } else {
      res.json({
        valid: false,
        message: response.status === 401 ? 'Invalid API key' : `API returned ${response.status}`,
      });
    }
  } catch (error) {
    res.json({
      valid: false,
      message: error.message,
    });
  }
});

export default router;
