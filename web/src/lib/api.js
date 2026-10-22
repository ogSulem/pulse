const TOKEN_KEY = 'pulse.token';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
export const setToken = (token) => {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
};

class HttpError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    setToken(null);
    if (!path.startsWith('/auth/login')) {
      window.dispatchEvent(new CustomEvent('pulse:unauthorized'));
    }
    const data = await res.json().catch(() => ({}));
    throw new HttpError(data.message || 'Требуется вход', 401, data);
  }
  if (raw) {
    if (!res.ok) throw new HttpError('Ошибка запроса', res.status);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(data.message || `Ошибка ${res.status}`, res.status, data);
  return data;
}

export const api = {
  login: (password) => request('/auth/login', { method: 'POST', body: { password } }),
  me: () => request('/auth/me'),
  bootstrap: () => request('/bootstrap'),

  projects: () => request('/projects'),
  createProject: (payload) => request('/projects', { method: 'POST', body: payload }),
  updateProject: (id, payload) => request(`/projects/${id}`, { method: 'PATCH', body: payload }),
  archiveProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  ideas: (params = {}) => request(`/ideas?${new URLSearchParams(params)}`),
  generateIdeas: (projectId, count) => request('/ideas/generate', { method: 'POST', body: { projectId, count } }),
  updateIdea: (id, payload) => request(`/ideas/${id}`, { method: 'PATCH', body: payload }),
  ideaToPipeline: (id) => request(`/ideas/${id}/episodes`, { method: 'POST', body: {} }),
  rejectIdea: (id) => request(`/ideas/${id}`, { method: 'DELETE' }),

  episodes: (params = {}) => request(`/episodes?${new URLSearchParams(params)}`),
  episode: (id) => request(`/episodes/${id}`),
  createEpisode: (payload) => request('/episodes', { method: 'POST', body: payload }),
  updateEpisode: (id, payload) => request(`/episodes/${id}`, { method: 'PATCH', body: payload }),
  episodeAction: (id, action, extra = {}) => request(`/episodes/${id}/action`, { method: 'POST', body: { action, ...extra } }),
  deleteEpisode: (id) => request(`/episodes/${id}`, { method: 'DELETE' }),

  pipelineStatus: () => request('/pipeline/status'),
  runPipeline: (payload) => request('/pipeline/run', { method: 'POST', body: payload }),
  drain: () => request('/pipeline/drain', { method: 'POST', body: {} }),
  requeue: () => request('/pipeline/requeue', { method: 'POST', body: {} }),

  accounts: () => request('/accounts'),
  createAccount: (payload) => request('/accounts', { method: 'POST', body: payload }),
  updateAccount: (id, payload) => request(`/accounts/${id}`, { method: 'PATCH', body: payload }),
  connectAccount: (id, payload) => request(`/accounts/${id}/connect`, { method: 'POST', body: payload }),
  disconnectAccount: (id) => request(`/accounts/${id}/connect`, { method: 'DELETE' }),
  accountLimit: (id) => request(`/accounts/${id}/limit`),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),

  products: () => request('/products'),
  createProduct: (payload) => request('/products', { method: 'POST', body: payload }),
  updateProduct: (id, payload) => request(`/products/${id}`, { method: 'PATCH', body: payload }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),

  growthOverview: (params = {}) => request(`/growth/overview?${new URLSearchParams(params)}`),
  growthTrends: (params = {}) => request(`/growth/trends?${new URLSearchParams(params)}`),
  growthHooks: (params = {}) => request(`/growth/hooks?${new URLSearchParams(params)}`),
  growthRetention: (payload) => request('/growth/retention', { method: 'POST', body: payload }),
  growthMonetization: () => request('/growth/monetization'),
  growthPlaybook: (accountId) => request(`/growth/playbook/${accountId}`),
  growthPlan: (params = {}) => request(`/growth/plan?${new URLSearchParams(params)}`),
  growthKnowledge: () => request('/growth/knowledge'),
  growthAudit: () => request('/growth/audit'),
  episodeGate: (id) => request(`/episodes/${id}/gate`),

  adsOverview: () => request('/ads/overview'),
  brands: () => request('/brands'),
  createBrand: (payload) => request('/brands', { method: 'POST', body: payload }),
  campaigns: () => request('/campaigns'),
  campaign: (id) => request(`/campaigns/${id}`),
  createCampaign: (payload) => request('/campaigns', { method: 'POST', body: payload }),
  updateCampaign: (id, payload) => request(`/campaigns/${id}`, { method: 'PATCH', body: payload }),
  deleteCampaign: (id) => request(`/campaigns/${id}`, { method: 'DELETE' }),
  payCampaign: (id, amount) => request(`/campaigns/${id}/pay`, { method: 'POST', body: { amount } }),
  attachCampaign: (id, episodeId) => request(`/campaigns/${id}/attach`, { method: 'POST', body: { episodeId } }),
  autofillCampaigns: (limit = 5) => request('/ads/autofill', { method: 'POST', body: { limit } }),
  episodeCampaign: (id) => request(`/episodes/${id}/campaign`),
  detachCampaign: (id) => request(`/episodes/${id}/campaign`, { method: 'DELETE' }),

  analytics: (params = {}) => request(`/analytics/overview?${new URLSearchParams(params)}`),
  scheduleInsights: (params = {}) => request(`/insights/schedule?${new URLSearchParams(params)}`),
  forecast: (episodeId) => request(`/insights/forecast?episodeId=${encodeURIComponent(episodeId)}`),
  growth: (params = {}) => request(`/insights/growth?${new URLSearchParams(params)}`),
  applyPolicy: () => request('/insights/apply-policy', { method: 'POST', body: {} }),
  abSummary: (params = {}) => request(`/abtest/summary?${new URLSearchParams(params)}`),
  evaluateAB: () => request('/abtest/evaluate', { method: 'POST', body: {} }),
  money: (params = {}) => request(`/money?${new URLSearchParams(params)}`),
  transparency: () => request('/transparency'),
  checkEpisode: (id, payload = {}) => request(`/episodes/${id}/check`, { method: 'POST', body: payload }),
  patchCaption: (id, payload) => request(`/episodes/${id}/caption`, { method: 'PATCH', body: payload }),
  publications: (params = {}) => request(`/analytics/publications?${new URLSearchParams(params)}`),

  logs: (params = {}) => request(`/logs?${new URLSearchParams(params)}`),
  settings: () => request('/settings'),
  updateSettings: (payload) => request('/settings', { method: 'PATCH', body: payload }),
  reseed: () => request('/demo/reseed', { method: 'POST', body: {} }),
  exportUrl: (type) => `/api/export/${type}?token=${encodeURIComponent(getToken() || '')}`,
  backupUrl: () => `/api/backup?token=${encodeURIComponent(getToken() || '')}`,
  coverUrl: (seed, title, sub, extra = '') =>
    `/api/covers/${encodeURIComponent(seed)}.svg?title=${encodeURIComponent(title || 'Pulse')}&sub=${encodeURIComponent(sub || 'reel')}${extra}`,
  health: () => fetch('/api/health').then((r) => r.json()),
};

export { HttpError };
