import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import { Badge, Empty, Field, Kpi, Modal, Progress, ScoreRing, Segmented, useToast } from '../components/ui.jsx';
import { fmt, money, relative } from '../lib/format.js';

// Страница сериалов. Порядок на экране повторяет порядок работы: сначала мир и
// сезон, потом сценарий и аудит, потом сборка, потом деньги. Ни один шаг не
// спрятан в «настройках»: сериал — это последовательность, и её видно целиком.

const STAGE_TONE = {
  planned: 'muted',
  script: 'accent',
  voice: 'accent',
  render: 'warn',
  review: 'warn',
  scheduled: 'accent',
  published: 'success',
  failed: 'danger',
};

const STAGE_LABEL = {
  planned: 'план',
  script: 'сценарий',
  voice: 'озвучка',
  render: 'сборка',
  review: 'готова',
  scheduled: 'в графике',
  published: 'опубликована',
  failed: 'ошибка',
};

const VERDICT_TONE = { 'безопасно': 'success', 'доработать': 'warn', 'риск демонетизации': 'danger' };

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function Stat({ label, value, hint }) {
  return (
    <div className="mini">
      <div className="mini-label">{label}</div>
      <div className="mini-value">{value}</div>
      {hint && <div className="mini-hint">{hint}</div>}
    </div>
  );
}

function BibleCard({ series, onRebuild, busy }) {
  const b = series.bible || {};
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Библия сериала</div>
          <div className="card-sub">Мир, герои и правило, на котором держится вся история</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onRebuild} disabled={busy}>
          <Icon name="refresh" size={14} className={busy ? 'spin' : ''} />Другая вариация
        </button>
      </div>
      <div className="card-body col" style={{ gap: 14 }}>
        <p className="prose">{b.premise}</p>
        <div className="grid-3">
          <Stat label="Место" value={b.world?.place} />
          <Stat label="Цена" value={b.world?.price} />
          <Stat label="Секрет сезона" value={b.world?.secret} />
        </div>
        <div className="bible-rule">
          <Icon name="shield" size={15} />
          <span>{b.world?.rule}</span>
        </div>
        <div className="grid-3">
          {(b.characters || []).map((c) => (
            <div className="char" key={c.name}>
              <div className="char-top">
                <b>{c.name}</b>
                <Badge tone={c.role === 'антагонист' ? 'danger' : c.role === 'союзник' ? 'accent' : 'success'}>{c.role}</Badge>
              </div>
              <div className="char-role">{c.profession}</div>
              <div className="char-line">Хочет: {c.want}</div>
              <div className="char-line">Рана: {c.wound}</div>
              <div className="char-line muted">Тайна: {c.secret}</div>
            </div>
          ))}
        </div>
        <div className="hint-row">
          <Badge tone="muted">маркировка ИИ</Badge>
          <span className="muted" style={{ fontSize: 12 }}>{b.disclosure}</span>
        </div>
        {b.contentWarning && (
          <div className="hint-row">
            <Badge tone="warn">возраст</Badge>
            <span className="muted" style={{ fontSize: 12 }}>{b.contentWarning}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SeasonPlan({ series, onPlan, busy }) {
  const plan = series.season_plan || {};
  const episodes = plan.episodes || [];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Арка сезона · {series.season || 1}</div>
          <div className="card-sub">{plan.cadence || '2 серии в неделю'} · {episodes.length} серий по {series.minutes} мин</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onPlan} disabled={busy}>
          <Icon name="calendar" size={14} />Пересобрать план
        </button>
      </div>
      <div className="card-body col" style={{ gap: 10 }}>
        {episodes.map((e) => (
          <div className="arc-row" key={e.number}>
            <div className="arc-no">{e.number}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="arc-title">{e.title}</div>
              <div className="arc-line">{e.logline}</div>
              <div className="arc-hook">Крючок: {e.cliffhanger}</div>
            </div>
            <div className="arc-date">
              {e.publishAt ? new Date(e.publishAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) : '—'}
            </div>
          </div>
        ))}
        {(plan.advice || []).length > 0 && (
          <div className="advice">
            {plan.advice.map((a, i) => (
              <div className="advice-row" key={i}><Icon name="check" size={13} /><span>{a}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EpisodeCard({ ep, onOpen, onCompose, busy }) {
  return (
    <div className="ep-card">
      <div className="ep-head">
        <div className="ep-no">Серия {ep.episode_no}</div>
        <Badge tone={STAGE_TONE[ep.stage] || 'muted'}>{STAGE_LABEL[ep.stage] || ep.stage}</Badge>
      </div>
      <div className="ep-title">{ep.title || 'Без сценария'}</div>
      {ep.logline && <div className="ep-line">{ep.logline}</div>}
      <div className="ep-meta">
        <span><Icon name="film" size={12} />{ep.duration_sec ? mmss(ep.duration_sec) : '—'}</span>
        <span><Icon name="chart" size={12} />{ep.scores?.total ?? '—'}</span>
        <span><Icon name="shield" size={12} />{ep.authenticity?.score ?? '—'}</span>
        {ep.mid_rolls > 0 && <span><Icon name="target" size={12} />{ep.mid_rolls} мид-ролл</span>}
        {ep.views > 0 && <span><Icon name="eye" size={12} />{fmt(ep.views)}</span>}
      </div>
      <div className="ep-actions">
        {!ep.scenes?.length ? (
          <button className="btn btn-soft btn-sm" onClick={() => onCompose(ep)} disabled={busy}>
            <Icon name="sparkles" size={13} />Написать сценарий
          </button>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => onOpen(ep)}>Открыть</button>
        )}
      </div>
    </div>
  );
}

function EpisodeDrawer({ episodeId, onClose, onChanged }) {
  const toast = useToast();
  const [ep, setEp] = useState(null);
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState('script');
  const [cuts, setCuts] = useState(null);
  const [publishResult, setPublishResult] = useState(null);

  const load = async () => {
    try {
      const res = await api.seriesEpisode(episodeId);
      setEp(res);
      setCuts(res.cuts || null);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Серия не загрузилась', text: err.message });
    }
  };

  useEffect(() => { if (episodeId) { setEp(null); setPublishResult(null); load(); } }, [episodeId]);

  const run = async (key, fn, okTitle) => {
    setBusy(key);
    try {
      const res = await fn();
      if (okTitle) toast.push({ tone: 'success', title: okTitle });
      await load();
      onChanged?.();
      return res;
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не получилось', text: err.message });
      return null;
    } finally {
      setBusy('');
    }
  };

  if (!episodeId) return null;

  return (
    <Modal open={Boolean(episodeId)} onClose={onClose} title={ep ? ep.title : 'Серия'} wide
      subtitle={ep ? `${ep.minutes} мин · ${ep.words} слов · ${ep.wpm} слов/мин · ${ep.scenes.length} планов` : 'Загрузка…'}>
      {!ep ? (
        <div className="col" style={{ gap: 10 }}><Progress value={40} /><span className="muted">Загружаем сценарий…</span></div>
      ) : (
        <div className="col" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => run('voice', () => api.voiceSeriesEpisode(ep.id), 'Озвучка готова')}>
              <Icon name="mic" size={14} className={busy === 'voice' ? 'spin' : ''} />Озвучить
            </button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run('render', () => api.renderSeriesEpisode(ep.id, { wait: false }), 'Сборка запущена')}>
              <Icon name="film" size={14} className={busy === 'render' ? 'spin' : ''} />Собрать видео
            </button>
            <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => run('ai', () => api.composeSeriesEpisodeAi(ep.id), 'Текст переписан моделью')}>
              <Icon name="sparkles" size={14} className={busy === 'ai' ? 'spin' : ''} />Пересобрать ИИ
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run('recompose', () => api.recomposeSeriesEpisode(ep.id), 'Сценарий переписан')}>
              <Icon name="refresh" size={14} />Другая версия
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run('cuts', () => api.planSeriesCuts(ep.id, { count: 3 }), 'Нарезки спланированы')}>
              <Icon name="scissors" size={14} />Нарезки
            </button>
            {ep.stage === 'review' && (
              <>
                <button className="btn btn-soft btn-sm" disabled={busy} onClick={async () => {
                  const res = await run('publish', () => api.publishSeriesEpisode(ep.id), 'Серия отправлена на YouTube');
                  if (res) setPublishResult(res);
                }}>
                  <Icon name="upload" size={14} />Опубликовать
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run('schedule', () => api.scheduleSeriesEpisode(ep.id), 'Серия в расписании — выйдет сама')}>
                  <Icon name="clock" size={14} />В расписание
                </button>
              </>
            )}
            {ep.stage === 'scheduled' && (
              <span className="badge accent" style={{ alignSelf: 'center' }}>
                <Icon name="clock" size={12} />выйдет {ep.publish_at ? new Date(ep.publish_at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'по плану сезона'}
              </span>
            )}
            {ep.url && (
              <a className="btn btn-ghost btn-sm" href={ep.url} target="_blank" rel="noreferrer">
                <Icon name="link" size={14} />Видео на YouTube
              </a>
            )}
          </div>

          {ep.error && <div className="alert danger">{ep.error}</div>}

          {publishResult && (
            <div className="alert success col" style={{ gap: 6 }}>
              <b>Видео загружено: <a href={publishResult.url} target="_blank" rel="noreferrer">{publishResult.url}</a></b>
              {publishResult.playlistId && <span className="muted" style={{ fontSize: 12 }}>Плейлист: {publishResult.playlistId}{publishResult.inPlaylist ? ' · серия добавлена' : ' · добавьте вручную'}</span>}
              {(publishResult.checklist || []).map((c, i) => <span key={i} className="muted" style={{ fontSize: 12 }}>• {c}</span>)}
            </div>
          )}

          <div className="grid-4">
            <div className="score-box">
              <ScoreRing value={ep.scores?.total || 0} size={54} />
              <span>Общая</span>
            </div>
            <div className="score-box">
              <ScoreRing value={ep.scores?.hook || 0} size={54} />
              <span>Хук</span>
            </div>
            <div className="score-box">
              <ScoreRing value={ep.scores?.retention || 0} size={54} />
              <span>Удержание</span>
            </div>
            <div className="score-box">
              <ScoreRing value={ep.scores?.authenticity || 0} size={54} />
              <span>Оригинальность</span>
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'script', label: 'Сценарий' },
                { value: 'audit', label: 'Аудит' },
                { value: 'money', label: 'Деньги' },
                { value: 'cuts', label: `Нарезки${cuts?.length ? ` · ${cuts.length}` : ''}` },
              ]}
            />
            <Badge tone={VERDICT_TONE[ep.authenticity?.verdict] || 'muted'}>{ep.authenticity?.verdict || 'аудит не проводился'}</Badge>
          </div>

          {tab === 'script' && (
            <div className="col" style={{ gap: 12 }}>
              {ep.video_path && (
                <video className="series-video" src={ep.video_path} controls poster={ep.cover_paths?.A} />
              )}
              <div className="chapters">
                {ep.chapters.map((c, i) => (
                  <span className="chapter" key={i}>
                    <b>{mmss(c.at)}</b> {c.label}{c.roll ? ' · реклама' : ''}
                  </span>
                ))}
              </div>
              <div className="scenes">
                {ep.scenes.map((s) => (
                  <div className="scene" key={s.n}>
                    <div className="scene-at">{mmss(s.at)}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="scene-text">{s.text}</div>
                      <div className="scene-meta">
                        {s.beatLabel} · {s.seconds} с · {s.frame?.sceneryRu || s.visual}
                        {s.frame?.shotRu ? ` · ${s.frame.shotRu}` : ''}
                        {s.roll ? ' · мид-ролл' : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="card">
                <div className="card-head"><div className="card-title">Описание для YouTube</div></div>
                <div className="card-body">
                  <pre className="pre">{ep.description}</pre>
                </div>
              </div>
            </div>
          )}

          {tab === 'audit' && (
            <div className="col" style={{ gap: 10 }}>
              <div className="muted" style={{ fontSize: 12.5 }}>{ep.authenticity?.note}</div>
              {(ep.authenticity?.checks || []).map((c) => (
                <div className={`audit-row ${c.pass ? 'ok' : c.severity === 'block' ? 'block' : 'warn'}`} key={c.id}>
                  <Icon name={c.pass ? 'check' : 'alert'} size={14} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="audit-label">{c.label}</div>
                    <div className="audit-detail">{c.detail}</div>
                    {!c.pass && <div className="audit-fix">{c.fix}</div>}
                  </div>
                  <Badge tone={c.pass ? 'success' : c.severity === 'block' ? 'danger' : 'warn'}>{c.pass ? 'ок' : c.severity === 'block' ? 'блок' : 'внимание'}</Badge>
                </div>
              ))}
            </div>
          )}

          {tab === 'money' && (
            <div className="col" style={{ gap: 12 }}>
              <div className="grid-3">
                <Stat label="RPM жанра" value={`${ep.forecast?.rpmRub} ₽`} hint={`диапазон ${ep.forecast?.rpmRange?.[0]}–${ep.forecast?.rpmRange?.[1]} ₽`} />
                <Stat label="Мид-роллы" value={ep.mid_rolls} hint={ep.rolls_at?.map((r) => mmss(r.at)).join(' · ') || 'нет'} />
                <Stat label="Себестоимость" value={money((ep.cost_cents || 0) / 100)} hint="озвучка + рендер" />
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Просмотры</th><th>Доход</th><th>Часы просмотра</th></tr></thead>
                  <tbody>
                    {(ep.forecast?.scenarios || []).map((s) => (
                      <tr key={s.views}>
                        <td>{fmt(s.views)}</td>
                        <td><b>{money(s.revenueRub)}</b></td>
                        <td>{fmt(s.watchHours)} ч</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{ep.forecast?.note}</div>
            </div>
          )}

          {tab === 'cuts' && (
            <div className="col" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => run('cutsrender', () => api.renderSeriesCuts(ep.id), 'Нарезки собраны')}>
                  <Icon name="film" size={13} />Собрать нарезки
                </button>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run('cutsqueue', () => api.queueSeriesCuts(ep.id, { platform: 'reels', count: 2 }), 'Нарезки в очереди роликов')}>
                  <Icon name="upload" size={13} />В очередь
                </button>
                <span className="muted" style={{ fontSize: 12 }}>Вертикальные клипы 15–60 с ведут зрителя из Shorts в сериал.</span>
              </div>
              {(cuts || []).length === 0 && <Empty icon="scissors" title="Нарезок пока нет" text="Нажмите «Нарезки», чтобы выбрать самые сильные сцены серии." />}
              {(cuts || []).map((c) => (
                <div className="cut-row" key={c.index}>
                  <div className="cut-no">{c.index}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cut-title">{c.title}</div>
                    <div className="cut-meta">{c.seconds} с · с {mmss(c.startAt)} · {c.videoPath ? 'собрана' : 'только план'}</div>
                  </div>
                  {c.videoPath && <a className="btn btn-ghost btn-sm" href={c.videoPath} target="_blank" rel="noreferrer">Открыть</a>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function Series() {
  const toast = useToast();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [episodeId, setEpisodeId] = useState(null);
  const [form, setForm] = useState({ title: '', genre: 'zombie', premise: '', episodes_planned: 6, episode_min: 15 });

  const load = async (keepId = null) => {
    try {
      const res = await api.seriesOverview();
      setOverview(res);
      const id = keepId || activeId || res.series?.[0]?.id || null;
      setActiveId(id);
      if (id) {
        const d = await api.seriesOne(id);
        setDetail(d);
      } else {
        setDetail(null);
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Сериалы не загрузились', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openSeries = async (id) => {
    setActiveId(id);
    try { setDetail(await api.seriesOne(id)); } catch (err) { toast.push({ tone: 'error', title: 'Сериал не открылся', text: err.message }); }
  };

  const run = async (key, fn, okTitle) => {
    setBusy(key);
    try {
      const res = await fn();
      if (okTitle) toast.push({ tone: 'success', title: okTitle });
      await load(activeId);
      return res;
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не получилось', text: err.message });
      return null;
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    if (!form.title.trim()) {
      toast.push({ tone: 'warn', title: 'Нужно название', text: 'Название сериала держит весь сезон: придумайте его первым.' });
      return;
    }
    setBusy('create');
    try {
      const created = await api.createSeries({
        title: form.title.trim(),
        genre: form.genre,
        premise: form.premise,
        episodes_planned: form.episodes_planned,
        episode_sec: Math.round(form.episode_min * 60),
      });
      setCreateOpen(false);
      toast.push({ tone: 'success', title: 'Сериал создан', text: 'Библия и арка сезона уже готовы — можно писать первую серию.' });
      await load(created.id);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Сериал не создан', text: err.message });
    } finally {
      setBusy('');
    }
  };

  const composeNext = async () => {
    if (!detail) return;
    const next = (detail.episode_list?.length || 0) + 1;
    await run('compose', () => api.createSeriesEpisode(detail.id, { episodeNo: next }), `Сценарий серии ${next} готов`);
  };

  const totals = overview?.totals || {};
  const episodes = detail?.episode_list || [];
  const econ = detail?.economics;
  const genres = overview?.genres || [];

  const nextStep = useMemo(() => {
    if (!detail) return null;
    if (!episodes.length) return { label: 'Написать серию 1', action: composeNext };
    const unfinished = episodes.find((e) => !['published'].includes(e.stage));
    if (!unfinished) return { label: 'Все серии опубликованы', action: null };
    if (unfinished.stage === 'script') return { label: `Озвучить серию ${unfinished.episode_no}`, action: () => setEpisodeId(unfinished.id) };
    if (unfinished.stage === 'voice') return { label: `Собрать серию ${unfinished.episode_no}`, action: () => setEpisodeId(unfinished.id) };
    if (unfinished.stage === 'review') return { label: `Опубликовать серию ${unfinished.episode_no}`, action: () => setEpisodeId(unfinished.id) };
    return { label: `Открыть серию ${unfinished.episode_no}`, action: () => setEpisodeId(unfinished.id) };
  }, [detail, episodes]);

  if (loading) {
    return <div className="col" style={{ gap: 12 }}><Progress value={45} /><span className="muted">Считаем сериалы…</span></div>;
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid-4">
        <Kpi label="Серии собраны" value={totals.episodes || 0} sub={`${totals.minutes || 0} мин`} icon="film" />
        <Kpi label="Опубликовано" value={totals.published || 0} sub={`${totals.ready || 0} готовы`} icon="upload" />
        <Kpi label="Часы просмотра" value={fmt(totals.watchHours || 0)} sub={`до YPP ${fmt(totals.hoursToMonetization || 0)} ч`} icon="chart" />
        <Kpi label="Доход сериалов" value={money(totals.revenueRub || 0)} sub={`RPM ${totals.rpm || 0} ₽`} icon="target" />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Сериалы</div>
            <div className="card-sub">Длинные истории 8–20 минут: библия, арка сезона, фото-ряд и мид-роллы</div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={14} />Новый сериал
          </button>
        </div>
        <div className="card-body">
          {(overview?.series || []).length === 0 ? (
            <Empty
              icon="film"
              title="Сериалов пока нет"
              text="Сериал — это не набор роликов, а история с аркой. Начните с одного жанра: 4–8 серий по 10–15 минут."
              action={<button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>Создать первый сериал</button>}
            />
          ) : (
            <div className="series-list">
              {overview.series.map((s) => (
                <button key={s.id} className={`series-chip ${activeId === s.id ? 'active' : ''}`} onClick={() => openSeries(s.id)}>
                  <div className="series-chip-title">{s.title}</div>
                  <div className="series-chip-sub">{s.genre_label} · {s.minutes} мин · {s.published}/{s.episodes_planned} серий</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {detail && (
        <>
          {/* Автопилот: серии пишутся и собираются сами, человек только смотрит */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Автопилот сериала</div>
                <div className="card-sub">
                  {overview?.autopilot?.due?.planned?.length
                    ? `В плане ещё ${overview.autopilot.due.planned.length} серий — сочинятся в ближайшие 10 минут`
                    : 'Серии сочиняются заранее на несколько выпусков вперёд'}
                </div>
              </div>
              <Badge tone={overview?.frames?.enabled ? 'success' : 'muted'}>
                {overview?.frames?.enabled ? `нейро-кадры: ${overview.frames.active || 'on'}` : 'кадры процедурные'}
              </Badge>
            </div>
            <div className="card-body col" style={{ gap: 14 }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <button className={`chip ${detail.auto_compose ? 'active' : ''}`}
                  onClick={() => run('autocompose', () => api.updateSeries(detail.id, { auto_compose: !detail.auto_compose }), 'Автопилот обновлён')}>
                  <Icon name="sparkles" size={12} style={{ verticalAlign: -2 }} /> писать серии заранее
                </button>
                <button className={`chip ${detail.auto_render ? 'active' : ''}`}
                  onClick={() => run('autorender', () => api.updateSeries(detail.id, { auto_render: !detail.auto_render }), 'Автопилот обновлён')}>
                  <Icon name="film" size={12} style={{ verticalAlign: -2 }} /> собирать видео без меня
                </button>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {detail.auto_compose ? 'сервер дописывает серии сам' : 'серии только по кнопке'} ·{' '}
                  {detail.auto_render ? 'рендер идёт в очереди' : 'рендер вручную'}
                </span>
              </div>
              <div className="form-grid">
                <Field label="Ряд вперёд" hint="Сколько серий держать готовыми к публикации (1–6)">
                  <select className="select" value={detail.lookahead || 3}
                    onChange={(e) => run('lookahead', () => api.updateSeries(detail.id, { lookahead: Number(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} серии</option>)}
                  </select>
                </Field>
                <Field label="Фото-ряд" hint="Нейро-кадры дороже по времени, но выглядят как кино">
                  <select className="select" value={detail.frame_mode || 'auto'}
                    onChange={(e) => run('framemode', () => api.updateSeries(detail.id, { frame_mode: e.target.value }), 'Фото-ряд обновлён')}>
                    <option value="auto">Авто (нейро, если доступно)</option>
                    <option value="neural">Всегда нейро-кадры</option>
                    <option value="procedural">Процедурные плашки</option>
                  </select>
                </Field>
              </div>
              {!overview?.frames?.enabled && (
                <div className="notice">
                  <Icon name="info" size={14} />
                  <span>
                    Нейро-кадры выключены: провайдер не активен. В live-режиме Pulse берёт бесплатный Flux (ключ не нужен),
                    в demo нужен <code className="mono">PULSE_IMAGES=on</code>. Пока серия соберётся на процедурных плашках.
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">{detail.title}</div>
                <div className="card-sub">
                  {detail.genre_label} · сезон {detail.season} · {detail.episodes_planned} серий по {detail.minutes} мин · {detail.status === 'draft' ? 'черновик' : detail.status}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {nextStep?.action && (
                  <button className="btn btn-primary btn-sm" onClick={nextStep.action} disabled={Boolean(busy)}>
                    <Icon name="sparkles" size={14} />{nextStep.label}
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run('plan', () => api.planSeason(detail.id), 'План сезона обновлён')}>
                  <Icon name="calendar" size={14} />План
                </button>
              </div>
            </div>
          </div>

          <BibleCard series={detail} busy={busy === 'bible'} onRebuild={() => run('bible', () => api.rebuildBible(detail.id, { variant: Date.now() % 9 }), 'Библия обновлена')} />

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Серии</div>
                <div className="card-sub">Сценарий, аудит оригинальности, сборка и публикация — по шагам</div>
              </div>
              <button className="btn btn-soft btn-sm" onClick={composeNext} disabled={Boolean(busy)}>
                <Icon name="plus" size={14} />Серия {episodes.length + 1}
              </button>
            </div>
            <div className="card-body">
              {episodes.length === 0 ? (
                <Empty icon="sparkles" title="Ни одной серии" text="Сценарий строится по 12 битам: крючок, поворот, обрыв и мид-ролл на границе актов." />
              ) : (
                <div className="ep-grid">
                  {episodes.map((ep) => (
                    <EpisodeCard key={ep.id} ep={ep} onOpen={(e) => setEpisodeId(e.id)} onCompose={(e) => run('compose', () => api.createSeriesEpisode(detail.id, { episodeNo: e.episode_no }), 'Сценарий готов')} busy={Boolean(busy)} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <SeasonPlan series={detail} busy={busy === 'plan'} onPlan={() => run('plan', () => api.planSeason(detail.id), 'План сезона обновлён')} />

          {econ && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Деньги сериала</div>
                  <div className="card-sub">Путь к монетизации и окупаемость каждой серии</div>
                </div>
              </div>
              <div className="card-body col" style={{ gap: 14 }}>
                <div className="grid-4">
                  <Stat label="Доход" value={money(econ.totalRevenueRub || 0)} hint={`прибыль ${money(econ.profitRub || 0)}`} />
                  <Stat label="Расход" value={money(econ.costRub || 0)} hint={`${money(econ.perEpisodeCost || 0)} за серию`} />
                  <Stat label="Окупаемость серии" value={econ.breakevenViews ? `${fmt(econ.breakevenViews)} просм.` : '—'} hint={`RPM ${econ.rpm} ₽`} />
                  <Stat label="До YPP" value={`${fmt(econ.ypp?.hoursLeft || 0)} ч`} hint={`${fmt(econ.watchHours || 0)} ч уже есть`} />
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Просмотры</th><th>Доход</th><th>Часы</th></tr></thead>
                    <tbody>
                      {(econ.forecast?.scenarios || []).map((s) => (
                        <tr key={s.views}><td>{fmt(s.views)}</td><td><b>{money(s.revenueRub)}</b></td><td>{fmt(s.watchHours)} ч</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="advice">
                  {(econ.advice || []).map((a, i) => (
                    <div className="advice-row" key={i}><Icon name="check" size={13} /><span>{a}</span></div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div className="card-title">Как устроен сериал</div>
              <div className="card-sub">Шесть шагов, каждый со своим смыслом</div>
            </div>
            <div className="card-body pipeline-grid">
              {(overview?.pipeline || []).map((p, i) => (
                <div className="pipe" key={p.id}>
                  <div className="pipe-no">{i + 1}</div>
                  <div>
                    <div className="pipe-title">{p.label}</div>
                    <div className="pipe-hint">{p.hint}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Новый сериал"
        subtitle="Жанр задаёт мир, лексику и RPM. Всё остальное соберётся по библии."
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setCreateOpen(false)}>Отмена</button>
            <button className="btn btn-primary" onClick={create} disabled={busy === 'create'}>
              {busy === 'create' ? 'Создаём…' : 'Создать сериал'}
            </button>
          </>
        )}
      >
        <div className="form-grid">
          <Field label="Название" span>
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Мёртвая тишина" />
          </Field>
          <Field label="Жанр">
            <select className="input" value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })}>
              {genres.map((g) => (
                <option key={g.id} value={g.id}>{g.label} · {g.rpm[0]}–{g.rpm[1]} ₽</option>
              ))}
            </select>
          </Field>
          <Field label="Минут в серии" hint="8–15 минут включают мид-роллы">
            <input className="input" type="number" min={8} max={30} value={form.episode_min} onChange={(e) => setForm({ ...form, episode_min: Number(e.target.value) })} />
          </Field>
          <Field label="Серий в сезоне" hint="4–8: меньше не читается как сериал">
            <input className="input" type="number" min={3} max={8} value={form.episodes_planned} onChange={(e) => setForm({ ...form, episodes_planned: Number(e.target.value) })} />
          </Field>
          <Field label="Завязка (необязательно)" span hint="Одно предложение — остальное движок достроит в библии">
            <textarea className="input" rows={3} value={form.premise} onChange={(e) => setForm({ ...form, premise: e.target.value })} placeholder="Город держится на правиле: тишину не замечают, пока не поздно." />
          </Field>
        </div>
      </Modal>

      <EpisodeDrawer episodeId={episodeId} onClose={() => setEpisodeId(null)} onChanged={() => load(activeId)} />
    </div>
  );
}
