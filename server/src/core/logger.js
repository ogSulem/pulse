import { db } from './db.js';
import { nowIso, uid } from './utils.js';

// Единый журнал действий: аудит + живая лента событий для UI.
export function log({ level = 'info', actor = 'system', action, entityType = '', entityId = '', message, meta = {} }) {
  const entry = {
    id: uid('log_'),
    ts: nowIso(),
    level,
    actor,
    action,
    entity_type: entityType,
    entity_id: entityId,
    message,
    meta: JSON.stringify(meta || {}),
  };
  db.prepare(
    'INSERT INTO logs (id, ts, level, actor, action, entity_type, entity_id, message, meta) VALUES (@id, @ts, @level, @actor, @action, @entity_type, @entity_id, @message, @meta)'
  ).run(entry);
  // держим журнал компактным на демо-стенде
  if (Math.random() < 0.02) {
    db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts DESC LIMIT -1 OFFSET 2000)").run();
  }
  return entry;
}

export function recentLogs({ limit = 80, level, entityId } = {}) {
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit);
}
