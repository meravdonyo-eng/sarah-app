import express from 'express';
import {
  getWorkspace,
  updateWorkspaceSystemPrompt,
} from '../services/db.js';

const router = express.Router();

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  if (req.get('x-admin-token') !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/agent/:workspaceId — get system prompt for a workspace
router.get('/:workspaceId', requireAdmin, async (req, res) => {
  try {
    const workspace = await getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ prompt: workspace.system_prompt || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/:workspaceId — set system prompt
router.post('/:workspaceId', requireAdmin, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (typeof prompt !== 'string') return res.status(400).json({ error: 'prompt must be a string' });
    await updateWorkspaceSystemPrompt(req.params.workspaceId, prompt.trim() || null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
