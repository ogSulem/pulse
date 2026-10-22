// ─────────────────────────────────────────────────────────────────────────────
// A/B-тесты, которые действительно заканчиваются решением.
//
// Раньше A/B был «двумя вариантами описания» ради галочки: варианты создавались,
// но никто не сравнивал результат. Здесь тест закрывается сам:
//   • берём эпизоды, где оба варианта опубликованы и прожили >= N часов;
//   • сравниваем охват и CTR, считаем значимость по простому z-тесту пропорций;
//   • при разнице >= 8% и достаточной выборке фиксируем победителя в эпизоде;
//   • проект запоминает, какой стиль выигрывает, и следующие ролики выходят
//     сразу в выигрышном стиле (а не тратят половину охвата на проигрыш).
// ─────────────────────────────────────────────────────────────────────────────
import { db, nowIso } from '../core/db.js';
import { log } from '../core/logger.js';
import { clamp, num, parseJson } from '../core/utils.js';

const MIN_AGE_HOURS = 20;
const MIN_DIFF = 0.08;

/** z-тест для двух пропорций (CTR) и относительной разницы охвата */
function significance(a, b) {
  // CTR: клики / просмотры
  const p1 = a.views > 0 ? a.clicks / a.views : 0;
  const p2 = b.views > 0 ? b.clicks / b.views : 0;
  const pooled = (a.clicks + b.clicks) / Math.max(1, a.views + b.views);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, a.views) + 1 / Math.max(1, b.views)));
  const z = se > 0 ? Math.abs(p1 - p2) / se : 0;
  return { z: Math.round(z * 100) / 100, p1, p2 };
}

export function evaluateAB({ minAgeHours = MIN_AGE_HOURS } = {}) {
  const cutoff = new Date(Date.now() - minAgeHours * 3600000).toISOString();
  const episodes = db.prepare(`SELECT * FROM episodes
      WHERE ab_test = 1 AND status = 'published' AND ab_winner IS NULL
        AND published_at IS NOT NULL AND published_at < ?`).all(cutoff);

  const decided = [];
  for (const ep of episodes) {
    const pubs = db.prepare("SELECT * FROM publications WHERE episode_id = ? AND status = 'published'").all(ep.id);
    const A = pubs.filter((p) => p.variant !== 'B').reduce((acc, p) => ({
      views: acc.views + (p.views || 0), clicks: acc.clicks + (p.clicks || 0), count: acc.count + 1,
    }), { views: 0, clicks: 0, count: 0 });
    const B = pubs.filter((p) => p.variant === 'B').reduce((acc, p) => ({
      views: acc.views + (p.views || 0), clicks: acc.clicks + (p.clicks || 0), count: acc.count + 1,
    }), { views: 0, clicks: 0, count: 0 });
    if (!A.count || !B.count || A.views < 300 || B.views < 300) continue;

    // симметричная разница: A/B по 5000/2000 → +60%, а не +150%
    const relDiff = (A.views - B.views) / Math.max(1, Math.max(A.views, B.views));
    const sig = significance(A, B);
    // решения нет, если разница в пределах шума — так и пишем
    const winner = Math.abs(relDiff) < MIN_DIFF ? 'tie' : (A.views > B.views ? 'A' : 'B');
    const meta = {
      A, B,
      lift: Math.round(relDiff * 1000) / 10,
      ctrA: Math.round(sig.p1 * 10000) / 100,
      ctrB: Math.round(sig.p2 * 10000) / 100,
      z: sig.z,
      confidence: sig.z >= 1.96 ? 'высокая' : sig.z >= 1.28 ? 'средняя' : 'низкая',
      decided_at: nowIso(),
    };
    db.prepare('UPDATE episodes SET ab_winner = ?, ab_meta = ? WHERE id = ?')
      .run(winner, JSON.stringify(meta), ep.id);
    decided.push({ episodeId: ep.id, title: ep.title, winner, ...meta });
    log({
      level: 'success', actor: 'abtest', action: 'abtest.decided', entityType: 'episode', entityId: ep.id,
      message: `A/B закрыт: вариант ${winner === 'tie' ? 'равен' : winner} (${winner === 'tie' ? 'разница в шуме' : `${meta.lift > 0 ? '+' : ''}${meta.lift}% охвата`}), CTR ${meta.ctrA}% / ${meta.ctrB}%`,
      meta,
    });
  }
  return decided;
}

/**
 * Выигрышный стиль проекта по закрытым тестам.
 * Используется при публикации: одиночный пост выходит сразу в лучшем варианте.
 */
export function preferredVariant(projectId, { days = 60 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`SELECT ab_winner, ab_meta FROM episodes
      WHERE project_id = ? AND ab_winner IS NOT NULL AND published_at > ?`).all(projectId, since);
  const votes = { A: 0, B: 0 };
  let liftSum = 0;
  let liftN = 0;
  for (const r of rows) {
    if (r.ab_winner === 'A' || r.ab_winner === 'B') votes[r.ab_winner]++;
    const meta = parseJson(r.ab_meta, {});
    if (typeof meta.lift === 'number') { liftSum += Math.abs(meta.lift); liftN++; }
  }
  const total = votes.A + votes.B;
  const variant = total === 0 ? 'A' : votes.B > votes.A ? 'B' : 'A';
  return {
    variant,
    decided: total,
    votes,
    avgLift: liftN ? Math.round((liftSum / liftN) * 10) / 10 : null,
    confidence: total >= 5 ? 'высокая' : total >= 2 ? 'средняя' : 'низкая',
    // «B» — это короткое описание и вторая обложка: если он выигрывает, проект
    // переходит на короткие описания, и это видно в интерфейсе
    style: variant === 'B' ? 'короткое описание + обложка B' : 'полное описание + обложка A',
  };
}

/** Сводка для экрана аналитики: сколько тестов закрыто и что это дало */
export function abSummary({ projectId = null } = {}) {
  const where = projectId ? 'AND project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const closed = db.prepare(`SELECT ab_winner, ab_meta FROM episodes
      WHERE ab_winner IS NOT NULL ${where}`).all(...args);
  const wins = closed.filter((r) => r.ab_winner !== 'tie');
  const lifts = wins.map((r) => Math.abs(num(parseJson(r.ab_meta, {}).lift, 0))).filter((x) => x > 0);
  return {
    closed: closed.length,
    ties: closed.length - wins.length,
    wins: wins.length,
    avgLift: lifts.length ? Math.round((lifts.reduce((a, b) => a + b, 0) / lifts.length) * 10) / 10 : null,
    preferred: projectId ? preferredVariant(projectId) : null,
  };
}

/** Ограничитель: не запускать тест, если у аккаунта нет запаса квоты на 2 поста */
export function abBudgetOk(projectId) {
  const row = db.prepare(`SELECT COUNT(*) n FROM publications pb
      WHERE pb.project_id = ? AND pb.published_at > ?`).get(projectId, new Date(Date.now() - 86400000).toISOString());
  return clamp(row.n, 0, 100) < 40;
}
