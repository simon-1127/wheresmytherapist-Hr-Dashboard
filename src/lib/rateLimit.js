// Minimal in-memory limiter for the three login forms. There was no limit
// at all, so a password could be guessed as fast as the network allowed.
// In-memory is fine for a single Railway instance; it resets on deploy,
// which only ever errs toward letting someone back in.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const hits = new Map();

function key(req) {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  return `${req.ip}|${req.path}|${email}`;
}

function sweep(now) {
  if (hits.size < 5000) return;
  for (const [k, v] of hits) if (now - v.first > WINDOW_MS) hits.delete(k);
}

/**
 * Express middleware. `view` is the login template to re-render with an
 * error when the limit is hit.
 */
function loginLimiter(view) {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);
    const k = key(req);
    const entry = hits.get(k);
    if (entry && now - entry.first < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
      const mins = Math.ceil((WINDOW_MS - (now - entry.first)) / 60000);
      return res.status(429).render(view, {
        error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        layout: false,
      });
    }
    if (!entry || now - entry.first >= WINDOW_MS) hits.set(k, { first: now, count: 1 });
    else entry.count += 1;
    next();
  };
}

// Call after a successful login so a typo or two doesn't count against them.
function clearLimit(req) {
  hits.delete(key(req));
}

module.exports = { loginLimiter, clearLimit };
