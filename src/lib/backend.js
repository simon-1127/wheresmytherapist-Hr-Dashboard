// Server-side client for the NestJS backend's admin API.
//
// Never called from the browser: the internal API key lives only in this
// process. Every call carries the logged-in admin's user id so the backend
// can re-check their role against admin_roles and audit the action under
// their name.
//
// Every function resolves to { ok, status, data } or { ok:false, status,
// message } — it never throws for HTTP or network failures, so a route can
// always show the backend's `message` to the admin instead of a 500 page.

const TIMEOUT_MS = 20000;

function config() {
  const base = (process.env.WMT_BACKEND_URL || '').replace(/\/+$/, '');
  const key = process.env.ADMIN_INTERNAL_API_KEY || '';
  return { base, key, ready: Boolean(base && key) };
}

async function call(method, path, { adminId, body, query } = {}) {
  const { base, key, ready } = config();
  if (!ready) {
    return {
      ok: false,
      status: 0,
      message: 'Backend not configured — set WMT_BACKEND_URL and ADMIN_INTERNAL_API_KEY in Railway.',
    };
  }
  if (!adminId) return { ok: false, status: 0, message: 'No admin identity on this session — log in again.' };

  const url = new URL(base + path);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Internal-Api-Key': key,
        'X-Admin-User-Id': adminId,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message =
      err.name === 'AbortError'
        ? `Backend did not answer within ${TIMEOUT_MS / 1000}s. Nothing is confirmed — check the refunds list before retrying.`
        : `Could not reach the backend (${err.cause ? err.cause.code || err.cause.message : err.message}).`;
    console.error(`[backend] ${method} ${path} failed:`, message);
    return { ok: false, status: 0, message };
  }
  clearTimeout(timer);

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    // Backend errors are { message, statusCode }. Nest's validation pipe
    // sends message as an array — join it so the admin sees every problem.
    let message = data && data.message;
    if (Array.isArray(message)) message = message.join('; ');
    if (!message) message = `Backend returned ${res.status}${text && !data ? `: ${text.slice(0, 200)}` : ''}`;
    if (res.status >= 500) console.error(`[backend] ${method} ${path} -> ${res.status}: ${message}`);
    return { ok: false, status: res.status, message };
  }
  return { ok: true, status: res.status, data };
}

const enc = encodeURIComponent;

module.exports = {
  config,
  evidence: (adminId, sessionId) => call('GET', `/admin/sessions/${enc(sessionId)}/evidence`, { adminId }),
  reviewQueue: (adminId, limit) => call('GET', '/admin/review-queue', { adminId, query: { limit } }),
  refund: (adminId, sessionId, body) => call('POST', `/admin/sessions/${enc(sessionId)}/refund`, { adminId, body }),
  outcome: (adminId, sessionId, body) => call('POST', `/admin/sessions/${enc(sessionId)}/outcome`, { adminId, body }),
  settlement: (adminId, sessionId, body) => call('POST', `/admin/sessions/${enc(sessionId)}/settlement`, { adminId, body }),
  refunds: (adminId, status, limit) => call('GET', '/admin/refunds', { adminId, query: { status, limit } }),
  retryRefund: (adminId, refundId) => call('POST', `/admin/refunds/${enc(refundId)}/retry`, { adminId }),
  snapshot: (adminId, snapshotId) => call('GET', `/admin/evidence-snapshots/${enc(snapshotId)}`, { adminId }),
};
