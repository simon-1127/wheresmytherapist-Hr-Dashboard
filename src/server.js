require('dotenv/config');
// Railway containers run in UTC, so every date on every page rendered in
// UTC — a session at 10:00 IST showed as 04:30. Must be set before any Date
// is constructed.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
// Must load before any router is created — see the file for why.
require('./lib/asyncErrors');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const expressLayouts = require('express-ejs-layouts');

const authRoutes = require('./routes/auth.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const organizationsRoutes = require('./routes/organizations.routes');
const usersRoutes = require('./routes/users.routes');
const providersRoutes = require('./routes/providers.routes');
const gendocsRoutes = require('./routes/gendocs.routes');
const settingsRoutes = require('./routes/settings.routes');
const hrPortalRoutes = require('./routes/hrPortal.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const supportRoutes = require('./routes/support.routes');
const teamRoutes = require('./routes/team.routes');

const { verifyMailer } = require('./config/mailer');
const { safeUrl } = require('./lib/validate');
const { pool } = require('./config/db');
const { supabase } = require('./config/supabase');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'partials/adminLayout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// The cookie signing key is what stops anyone from minting their own super
// admin session. A missing SESSION_SECRET used to fall back to a string
// that is printed right here in the source. In production we now derive a
// key from the service role key instead (already secret, already set) so a
// forgotten variable can't silently mean "anyone can log in as admin".
function sessionKeys() {
  if (process.env.SESSION_SECRET) return [process.env.SESSION_SECRET];
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    console.error('[session] SESSION_SECRET is not set — deriving one from SUPABASE_SERVICE_ROLE_KEY. Set SESSION_SECRET in Railway.');
    const seed = process.env.SUPABASE_SERVICE_ROLE_KEY || crypto.randomBytes(32).toString('hex');
    return [crypto.createHmac('sha256', seed).update('wmt-hr-session').digest('hex')];
  }
  return ['dev-only-secret-change-me'];
}

app.use(
  cookieSession({
    name: 'wmt_hr_session',
    keys: sessionKeys(),
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  }),
);

// Keep "remember me" sessions at 30 days on every cookie re-issue (flash
// messages and role re-checks both re-issue it). See auth.routes.js.
app.use((req, res, next) => {
  if (req.session && req.session.remember) req.sessionOptions.maxAge = 30 * 24 * 60 * 60 * 1000;
  next();
});

// Never index this in search engines, and never let it be embedded elsewhere.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Tiny one-read flash message helper, backed by the signed session cookie.
// Used for things like "here is the HR contact's one-time temp password" —
// shown once, then gone.
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  if (req.session) req.session.flash = null;
  next();
});

function setFlash(req, flash) {
  req.session.flash = flash;
}
app.use((req, res, next) => {
  req.setFlash = (flash) => setFlash(req, flash);
  next();
});

app.use((req, res, next) => {
  res.locals.path = req.path;
  next();
});
app.locals.safeUrl = safeUrl;

// EJS reinterprets a fixed set of render locals as *compiler options* rather
// than template data (see _OPTS_PASSABLE_WITH_DATA in ejs/lib/ejs.js). The
// dangerous one is `client`: a local by that name compiles the template in
// client mode, where EJS does not supply the `include` function — which
// surfaces as a baffling "include is not a function" in a different file,
// and, because `view cache` is on in production, sticks in the compiled
// template cache until the process restarts.
//
// This wrapper runs before express-ejs-layouts' own render override, so the
// collision is reported at the offending route instead of days later.
const EJS_RESERVED_LOCALS = [
  'client', 'cache', 'context', 'scope', 'debug', 'compileDebug',
  'delimiter', 'filename', 'async', 'strict', 'rmWhitespace', '_with',
];

app.use((req, res, next) => {
  const render = res.render.bind(res);
  res.render = function (view, options, cb) {
    if (options && typeof options === 'object') {
      const clashes = EJS_RESERVED_LOCALS.filter((k) => options[k] !== undefined);
      if (clashes.length) {
        return next(
          new Error(
            `Render local(s) [${clashes.join(', ')}] collide with EJS compiler options ` +
              `while rendering "${view}" — rename them (e.g. client -> clientProfile).`,
          ),
        );
      }
    }
    return render(view, options, cb);
  };
  next();
});

// Plain /health stays dependency-free so Railway's healthcheck never flaps
// on a Supabase hiccup. /health?deep=1 actually touches both databases —
// point an uptime monitor (e.g. UptimeRobot) at that one.
app.get('/health', async (req, res) => {
  if (!req.query.deep) return res.json({ ok: true });
  const out = { ok: true, supabase: null, postgres: null };
  try {
    const { error } = await supabase.from('subscription_tiers').select('id', { head: true, count: 'exact' });
    out.supabase = error ? `error: ${error.message}` : 'ok';
  } catch (err) {
    out.supabase = `error: ${err.message}`;
  }
  try {
    await pool.query('select 1');
    out.postgres = 'ok';
  } catch (err) {
    out.postgres = `error: ${err.message || err.code}`;
  }
  out.ok = out.supabase === 'ok' && out.postgres === 'ok';
  res.status(out.ok ? 200 : 503).json(out);
});

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/organizations', organizationsRoutes);
app.use('/users', usersRoutes);
app.use('/providers', providersRoutes);
app.use('/gendocs', gendocsRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/settings', settingsRoutes);
app.use('/hr', hrPortalRoutes);
app.use('/support', supportRoutes);
app.use('/team', teamRoutes);
// The old Onboarding tab. Provider creation/upgrade lived here and is gone;
// team members moved to /team.
app.use('/onboarding', (req, res) => res.redirect(301, '/team'));

// Which "back" link an error page offers depends on which portal the request
// came from — a support agent bounced to /, or an HR contact bounced to the
// admin dashboard, just hits another login wall.
function errorExit(req) {
  if (req.path.startsWith('/support')) return { backHref: '/support/alerts', backLabel: 'Back to alerts' };
  if (req.path.startsWith('/hr')) return { backHref: '/hr', backLabel: 'Back to HR portal' };
  return { backHref: '/', backLabel: 'Back to dashboard' };
}

app.use((req, res) => {
  res.status(404).render('errors/404', { layout: false, ...errorExit(req) });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  // A handler that already started responding can't be given an error page.
  if (res.headersSent) return next(err);
  res.status(500).render('errors/500', { layout: false, message: err.message, ...errorExit(req) });
});

const port = process.env.PORT || 3100;
const server = app.listen(port, () => {
  console.log(`WMT HR dashboard listening on :${port}`);
  // Surfaces a broken SMTP config in the deploy logs rather than in a
  // "the SPOC never got their password" report days later.
  verifyMailer();
});

// Last-resort net. Nothing should reach here now that sendMail swallows its
// own failures, but an unhandled rejection silently exiting the process is
// how a mail timeout took the whole dashboard down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection — staying up:', reason);
});

// Railway sends SIGTERM on every redeploy. Finish in-flight requests and
// close the Postgres pool instead of dropping them mid-write.
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM — shutting down');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
});
