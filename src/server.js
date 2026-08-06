require('dotenv/config');
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
const onboardingRoutes = require('./routes/onboarding.routes');

const { verifyMailer } = require('./config/mailer');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'partials/adminLayout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  cookieSession({
    name: 'wmt_hr_session',
    keys: [process.env.SESSION_SECRET || 'dev-only-secret-change-me'],
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  }),
);

// Never index this in search engines, and never let it be embedded elsewhere.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Frame-Options', 'DENY');
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

app.get('/health', (req, res) => res.json({ ok: true }));

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
app.use('/onboarding', onboardingRoutes);

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
  console.error(err);
  res.status(500).render('errors/500', { layout: false, message: err.message, ...errorExit(req) });
});

const port = process.env.PORT || 3100;
app.listen(port, () => {
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
