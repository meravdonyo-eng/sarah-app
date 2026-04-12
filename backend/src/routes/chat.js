import express from 'express';
import { sendMessage, sendMessageWithTools } from '../services/claude.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { message, useTools = false, conversationHistory = [] } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (useTools) {
      const sessionId = req.session?.id;
      if (!sessionId) {
        return res.status(401).json({ error: 'Session required for tool use' });
      }

      const result = await sendMessageWithTools(sessionId, message, conversationHistory);
      res.json(result);
    } else {
      const response = await sendMessage(message);
      res.json({ response });
    }
  } catch (error) {
    console.error('Chat error:', error);
    if (error.status === 429) {
      const retryAfter = error.headers?.['retry-after'] || 60;
      return res.status(429).json({
        error: `Rate limit exceeded. Please wait ${retryAfter} seconds and try again.`,
        retryAfter: Number(retryAfter),
      });
    }
    res.status(500).json({ error: 'Failed to get response from Claude' });
  }
});

export default router;
