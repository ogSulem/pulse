import { db } from './db.js';
import { nowIso, uid } from './utils.js';

// Единый журнал действий: аудит + живая лента событий для UI.
// Подготовленные запросы кэшируем: журнал пишется на каждом шаге конвейера, и
// перекомпиляция INSERT/списка на каждый вызов — чистая потеря CPU.
const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};

let writes = 0;
const LOG_LIMIT = 2000;

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
  stmt(
    'INSERT INTO logs (id, ts, level, actor, action, entity_type, entity_id, message, meta) VALUES (@id, @ts, @level, @actor, @action, @entity_type, @entity_id, @message, @meta)'
  ).run(entry);
  // Держим журнал компактным: раз в 500 записей (а не случайно на каждой) —
  // так размер предсказуем, а лишней работы нет.
  writes += 1;
  if (writes % 500 === 0) {
    stmt('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts DESC LIMIT -1 OFFSET ?)').run(LOG_LIMIT);
  }
  return entry;
}

export function recentLogs({ limit = 80, level, entityId, q } = {}) {
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  // поиск на стороне базы: раньше фильтр применялся после LIMIT, поэтому
  // «поиск по журналу» находил совпадения только среди последних N строк
  if (q) { where.push('(message LIKE ? OR action LIKE ? OR actor LIKE ?)'); const like = `%${q}%`; params.push(like, like, like); }
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  return stmt(sql).all(...params, limit);
}
