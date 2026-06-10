/**
 * monitoringDb.js — DB helpers for the proactive monitoring engine.
 *
 * Security: every function is scoped to workspace_id.
 * Storage rule: fire_log stores ONLY dedup_key + severity + timestamp.
 *               Observed/baseline metric values are NEVER persisted.
 */

import pool from './db.js';

// ---------------------------------------------------------------------------
// Monitor config
// ---------------------------------------------------------------------------

export async function getActiveMonitors(workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM monitor_configs
     WHERE workspace_id = $1
       AND status = 'active'
       AND (muted_until IS NULL OR muted_until < NOW())`,
    [workspaceId]
  );
  return rows;
}

export async function getAllActiveMonitors() {
  const { rows } = await pool.query(
    `SELECT * FROM monitor_configs
     WHERE status = 'active'
       AND (muted_until IS NULL OR muted_until < NOW())`
  );
  return rows;
}

export async function upsertMonitor(config) {
  const {
    workspaceId, monitorId, metricLabel, metric, baseline,
    threshold, schedule, channel, quietHours,
    dailyCap = 3, cooldownHours = 24,
  } = config;
  await pool.query(
    `INSERT INTO monitor_configs
       (workspace_id, monitor_id, metric_label, metric, baseline, threshold,
        schedule, channel, quiet_hours, daily_cap, cooldown_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (workspace_id, monitor_id) DO UPDATE SET
       metric_label   = EXCLUDED.metric_label,
       metric         = EXCLUDED.metric,
       baseline       = EXCLUDED.baseline,
       threshold      = EXCLUDED.threshold,
       schedule       = EXCLUDED.schedule,
       channel        = EXCLUDED.channel,
       quiet_hours    = EXCLUDED.quiet_hours,
       daily_cap      = EXCLUDED.daily_cap,
       cooldown_hours = EXCLUDED.cooldown_hours,
       updated_at     = NOW()`,
    [workspaceId, monitorId, metricLabel,
     JSON.stringify(metric), JSON.stringify(baseline), JSON.stringify(threshold),
     schedule, channel, quietHours ? JSON.stringify(quietHours) : null,
     dailyCap, cooldownHours]
  );
}

export async function muteMonitor(workspaceId, monitorId, untilTimestamp = null) {
  await pool.query(
    `UPDATE monitor_configs
     SET status = $3, muted_until = $4, updated_at = NOW()
     WHERE workspace_id = $1 AND monitor_id = $2`,
    [workspaceId, monitorId,
     untilTimestamp ? 'active' : 'muted',
     untilTimestamp || null]
  );
}

// ---------------------------------------------------------------------------
// Fire log — stores ONLY dedup_key + severity + timestamp
// ---------------------------------------------------------------------------

export async function recordFire(workspaceId, monitorId, dedupKey, severity) {
  await pool.query(
    `INSERT INTO monitor_fire_log (workspace_id, monitor_id, dedup_key, severity)
     VALUES ($1, $2, $3, $4)`,
    [workspaceId, monitorId, dedupKey, severity]
  );
}

export async function wasFiredWithin(workspaceId, dedupKey, hours) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT 1 FROM monitor_fire_log
     WHERE workspace_id = $1 AND dedup_key = $2 AND fired_at > $3
     LIMIT 1`,
    [workspaceId, dedupKey, since]
  );
  return rows.length > 0;
}

export async function getDailyFireCount(workspaceId) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM monitor_fire_log
     WHERE workspace_id = $1 AND fired_at >= $2`,
    [workspaceId, today]
  );
  return parseInt(rows[0]?.count || '0');
}
