/**
 * Admin API — protected by ADMIN_TOKEN header
 * Used by the frontend admin panel
 */
import express from 'express';
import pool from '../services/db.js';

const router = express.Router();

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  if (req.get('x-admin-token') !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.use(requireAdmin);

// GET /api/admin/workspaces — list all installed workspaces
router.get('/workspaces', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        workspace_id,
        team_name,
        created_at,
        updated_at,
        (mixpanel_project_id IS NOT NULL) AS has_mixpanel,
        (jira_access_token IS NOT NULL)   AS has_jira,
        system_prompt
      FROM workspaces
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/workspaces/:id — single workspace detail
router.get('/workspaces/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT workspace_id, team_name, created_at, updated_at,
              (mixpanel_project_id IS NOT NULL) AS has_mixpanel,
              (jira_access_token IS NOT NULL) AS has_jira,
              system_prompt
       FROM workspaces WHERE workspace_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/workspaces/:id/prompt — update system prompt
router.post('/workspaces/:id/prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (typeof prompt !== 'string') return res.status(400).json({ error: 'prompt must be a string' });
    await pool.query(
      'UPDATE workspaces SET system_prompt = $2, updated_at = NOW() WHERE workspace_id = $1',
      [req.params.id, prompt.trim() || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats — quick stats
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                          AS total_workspaces,
        COUNT(*) FILTER (WHERE mixpanel_project_id IS NOT NULL) AS with_mixpanel,
        COUNT(*) FILTER (WHERE jira_access_token IS NOT NULL)   AS with_jira
      FROM workspaces
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/readmore-debug — inspect read_more_store table
router.get('/readmore-debug', async (req, res) => {
  try {
    // Check if table exists
    const { rows: tableCheck } = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'read_more_store'
      ) AS table_exists
    `);

    const tableExists = tableCheck[0]?.table_exists;
    if (!tableExists) {
      return res.json({ table_exists: false, rows: [] });
    }

    const { rows } = await pool.query(`
      SELECT id, length(content) AS content_length, expires_at,
             expires_at > NOW() AS is_valid
      FROM read_more_store
      ORDER BY expires_at DESC
      LIMIT 10
    `);
    res.json({ table_exists: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/workspaces/:id/morning-channel — configure daily briefing channel
router.post('/workspaces/:id/morning-channel', async (req, res) => {
  try {
    const { channel } = req.body;
    await pool.query(
      `UPDATE workspaces SET morning_channel = $2, updated_at = NOW() WHERE workspace_id = $1`,
      [req.params.id, channel || null]
    );
    res.json({ success: true, morning_channel: channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/zero-input/kpi — zero-input KPI across all workspaces
router.get('/zero-input/kpi', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const { rows } = await pool.query(
      `SELECT
         workspace_id,
         outcome,
         gap_type,
         COUNT(*) AS count
       FROM zero_input_log
       WHERE logged_at > NOW() - ($1 || ' days')::interval
       GROUP BY workspace_id, outcome, gap_type
       ORDER BY workspace_id, count DESC`,
      [days]
    );

    // Aggregate KPI per workspace
    const byWorkspace = {};
    for (const r of rows) {
      if (!byWorkspace[r.workspace_id]) byWorkspace[r.workspace_id] = { total: 0, answered: 0, breakdown: [] };
      const n = parseInt(r.count);
      byWorkspace[r.workspace_id].total += n;
      if (r.outcome === 'answered') byWorkspace[r.workspace_id].answered += n;
      byWorkspace[r.workspace_id].breakdown.push(r);
    }

    const result = Object.entries(byWorkspace).map(([ws, d]) => ({
      workspace_id: ws,
      kpi_pct: d.total > 0 ? parseFloat(((d.answered / d.total) * 100).toFixed(1)) : null,
      total_queries: d.total,
      answered: d.answered,
      breakdown: d.breakdown,
    }));

    res.json({ period_days: days, workspaces: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/monitoring/run — trigger monitoring checks immediately (testing)
router.post('/monitoring/run', async (req, res) => {
  try {
    const { runScheduledChecks } = await import('../services/monitoring.js');
    console.log('[Admin] Manual monitoring trigger');
    runScheduledChecks().catch(err => console.error('[Admin] monitoring run error:', err.message));
    res.json({ status: 'started', message: 'runScheduledChecks() triggered — check Deploy Logs' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/workspaces/:id/monitors — list monitors for a workspace
router.get('/workspaces/:id/monitors', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM monitor_configs WHERE workspace_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/workspaces/:id/monitors — insert/upsert a monitor config
router.post('/workspaces/:id/monitors', async (req, res) => {
  try {
    const { upsertMonitor } = await import('../services/monitoringDb.js');
    await upsertMonitor({ workspaceId: req.params.id, ...req.body });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/workspaces/:id/monitors/:monitorId — delete a monitor
router.delete('/workspaces/:id/monitors/:monitorId', async (req, res) => {
  try {
    const { deleteMonitor } = await import('../services/monitoringDb.js');
    await deleteMonitor(req.params.id, req.params.monitorId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/workspaces/:id/monitors/:monitorId/mute — mute/unmute a monitor
router.post('/workspaces/:id/monitors/:monitorId/mute', async (req, res) => {
  try {
    const { muteMonitor, unmuteMonitor } = await import('../services/monitoringDb.js');
    const { hours } = req.body;
    if (hours === 0 || hours === '0') {
      await unmuteMonitor(req.params.id, req.params.monitorId);
    } else {
      const until = new Date(Date.now() + (parseInt(hours) || 24) * 60 * 60 * 1000);
      await muteMonitor(req.params.id, req.params.monitorId, until.toISOString());
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/monitors — all monitors across all workspaces
router.get('/monitors', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT mc.*, w.team_name,
             (SELECT COUNT(*) FROM monitor_fire_log f
              WHERE f.workspace_id = mc.workspace_id AND f.monitor_id = mc.monitor_id
                AND f.fired_at > NOW() - INTERVAL '7 days') AS fires_7d
      FROM monitor_configs mc
      LEFT JOIN workspaces w ON w.workspace_id = mc.workspace_id
      ORDER BY mc.updated_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
