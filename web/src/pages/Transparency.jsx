import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Empty, Progress, ScoreRing } from '../components/ui.jsx';
import EpisodeDrawer from '../components/EpisodeDrawer.jsx';
import { fmt, full, money, bytes, pct, relative, platformLabel } from '../lib/format.js';

const STATE = {
  ok: { tone: 'success', icon: 'check', label: 'ок' },
  // info — не проблема, а пояснение: например, роликов ещё не рендерили
  info: { tone: 'muted', icon: 'info', label: 'инфо' },
  warn: { tone: 'warn', icon: 'alert', label: 'внимание' },
  fail: { tone: 'danger', icon: 'x', label: 'блок' },
};

function Check({ item }) {
  const s = STATE[item.state] || STATE.info;
  return (
    <div className={`check-row ${item.state}`}>
      <div className={`check-icon ${s.tone}`}><Icon name={s.icon} size={14} /></div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="check-title">{item.label}</div>
        <div className="check-detail">{item.detail}</div>
      </div>
      <Badge tone={s.tone}>{s.label}</Badge>
    </div>
  );
}

export default function Transparency() {
  const { data } = useApp();
  const [t, setT] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.transparency().then(setT).catch(() => {});
  }, [data.pipeline?.published, data.pipeline?.scheduled, data.pipeline?.review]);

  if (!t) return <div className="page"><div className="skeleton" style={{ height: 220 }} /></div>;

  const render = t.render || {};
  const counts = t.pipeline || {};
  const media = t.media || {};

  return (
    <div className="page">
      <div className="row-between wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">без чёрных ящиков</div>
          <h1 className="page-h1">Прозрачность</h1>
          <p className="page-sub">
            Что система сделала сама, что отдала вам на проверку и почему. Лимиты площадок — фактическое потребление,
            а не обещания. Если что-то не так — здесь видно первым.
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Badge tone={render.available ? 'success' : 'warn'} dot>{render.available ? 'рендер включён' : 'рендер выключен'}</Badge>
          <Badge tone="muted">{t.generated_at ? relative(t.generated_at) : ''}</Badge>
        </div>
      </div>

      <div className="grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Ролики с файлом</span><span className="kpi-icon"><Icon name="film" size={14} /></span></div>
          <div className="kpi-value">{media.count || 0}<small>{bytes(media.bytes || 0)}</small></div>
          <div className="kpi-foot">средний рендер {media.avgRenderSec || 0} с</div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">На проверке</span><span className="kpi-icon"><Icon name="shield" size={14} /></span></div>
          <div className="kpi-value">{counts.review || 0}<small>шт</small></div>
          <div className="kpi-foot">требуют вашего решения</div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Запланировано</span><span className="kpi-icon"><Icon name="calendar" size={14} /></span></div>
          <div className="kpi-value">{counts.scheduled || 0}<small>шт</small></div>
          <div className="kpi-foot">выйдут автоматически</div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Ошибки</span><span className="kpi-icon"><Icon name="alert" size={14} /></span></div>
          <div className="kpi-value">{counts.failed || 0}<small>шт</small></div>
          <div className="kpi-foot">с причинами ниже</div>
        </div>
      </div>

      <div className="grid-2-1">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Проверки системы</div>
              <div className="card-sub">каждая строка — реальное состояние, а не статус-баннер</div>
            </div>
          </div>
          <div className="check-list">
            {t.checks.map((c) => <Check key={c.id} item={c} />)}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Лимиты площадок</div></div>
          <div className="col" style={{ gap: 16 }}>
            {t.quotas.map((q) => (
              <div key={q.platform}>
                <div className="row-between" style={{ marginBottom: 7 }}>
                  <span className="row" style={{ gap: 8 }}><PlatformIcon platform={q.platform} size={15} />{q.label || platformLabel(q.platform)}</span>
                  <span className="mono" style={{ fontSize: 11.5 }}>{q.used}/{q.cap}</span>
                </div>
                <Progress value={q.cap ? (q.used / q.cap) * 100 : 0} tone={q.left === 0 ? 'danger' : q.used / q.cap > 0.7 ? 'warn' : 'accent'} />
                <div className="field-hint" style={{ marginTop: 6 }}>{q.window} · осталось {q.left}</div>
              </div>
            ))}
          </div>
          <div className="hr" />
          <div className="col" style={{ gap: 10, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            {Object.entries(t.platformRules || {}).map(([key, r]) => (
              <div key={key}>
                <b style={{ color: 'var(--text-2)' }}>{r.label}</b>
                <div>{r.notes?.[0]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div className="card-title tone-rose">Заблокировано правилами</div>
            <Badge tone="danger">{t.blocked.length}</Badge>
          </div>
          {t.blocked.length ? t.blocked.map((b) => (
            <button className="issue-row" key={b.id} onClick={() => setSelected(b.id)}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="issue-title truncate">{b.title}</div>
                <div className="issue-sub">{b.compliance?.blocking?.[0]?.reason || 'есть блокирующее нарушение'}</div>
              </div>
              <ScoreRing value={b.viral || 0} size={34} />
            </button>
          )) : <div className="empty-inline">Все ролики прошли проверку правил</div>}
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title tone-amber">Низкий вирусный скор</div>
            <Badge tone="warn">{t.lowViral.length}</Badge>
          </div>
          {t.lowViral.length ? t.lowViral.map((v) => (
            <button className="issue-row" key={v.id} onClick={() => setSelected(v.id)}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="issue-title truncate">{v.title}</div>
                <div className="issue-sub">{v.advice?.[0] || 'усильте хук и сократите длину'}</div>
              </div>
              <ScoreRing value={v.viral} size={34} />
            </button>
          )) : <div className="empty-inline">Нет роликов ниже порога</div>}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><div className="card-title">Ошибки конвейера</div></div>
          {t.failed.length ? t.failed.map((f) => (
            <div className="issue-row static" key={f.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="issue-title truncate">{f.title}</div>
                <div className="issue-sub">{f.stage}: {f.error || 'нет деталей'}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(f.id)}>Открыть</button>
            </div>
          )) : <div className="empty-inline">Ошибок нет</div>}
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Что можно проверить руками</div></div>
          <div className="col" style={{ gap: 12 }}>
            <div className="api-row"><code>GET /t/&lt;token&gt;</code><span>короткая ссылка ролика: считает клик и ведёт на лендинг</span></div>
            <div className="api-row"><code>POST /api/postback</code><span>уведомление о покупке: <code>click_id</code> или <code>token</code>, идемпотентно по <code>external_id</code></span></div>
            <div className="api-row"><code>GET /media/&lt;id&gt;.mp4</code><span>готовый файл ролика, можно скачать и залить вручную</span></div>
            <div className="api-row"><code>POST /api/episodes/:id/check</code><span>проверка текста на правила и «залетит ли» без публикации</span></div>
          </div>
          <div className="hr" />
          <div className="mini-kv tight">
            <div><span>ffmpeg</span><b>{render.ffmpeg ? 'есть' : 'нет'}</b></div>
            <div><span>sharp</span><b>{render.sharp ? 'есть' : 'нет'}</b></div>
            <div><span>шрифты</span><b>{render.fonts ? 'загружены' : 'нет'}</b></div>
            <div><span>кадр</span><b>{render.width}×{render.height} · {render.fps} fps</b></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ borderColor: 'rgba(167,139,250,.22)' }}>
        <div className="grid-2" style={{ gap: 22 }}>
          <div>
            <div className="eyebrow">что автоматизировано честно</div>
            <h3 style={{ margin: '6px 0 10px', fontSize: 16 }}>Автоматика без «серых» схем</h3>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-2)' }}>
              Pulse не обходит модерацию и не покупает просмотры. Он делает то, что разрешено API площадок:
              публикует через официальные эндпоинты, соблюдает окна лимитов, маркирует рекламу и ИИ-контент,
              останавливается сам, когда лимит исчерпан, и передаёт человеку всё, что требует решения.
            </p>
          </div>
          <div>
            <div className="eyebrow">что остаётся за человеком</div>
            <h3 style={{ margin: '6px 0 10px', fontSize: 16 }}>Границы автоматизации</h3>
            <ul className="plain-list">
              <li>Аудит приложений Meta и TikTok — заявка и модерация на стороне площадок.</li>
              <li>Стратегия, офферы и продуктовые смыслы — модель предлагает, решение за вами.</li>
              <li>Финальный просмотр роликов с риском или низким скором.</li>
              <li>Юридические требования: маркировка рекламы в вашей юрисдикции.</li>
            </ul>
          </div>
        </div>
      </div>

      <EpisodeDrawer episodeId={selected} onClose={() => setSelected(null)} onChange={() => {}} />
    </div>
  );
}
