const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');
const { normalizeEmail, escapeLike } = require('../lib/validate');
const { loginLimiter, clearLimit } = require('../lib/rateLimit');

const router = express.Router();

// ---------- Super admin ----------

router.get('/login', (req, res) => {
  if (req.session.superAdmin) return res.redirect('/');
  res.render('auth/login', { error: null, layout: false });
});
const { createClient } = require('@supabase/supabase-js');

// Default session (set in server.js) is 12 hours — that's the whole "logs
// out too often" complaint. cookie-session supports overriding maxAge for
// the current request/response via req.sessionOptions; setting it here
// after a successful "remember me" login extends just that cookie without
// touching the app-wide default for everyone else.
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

router.post('/login', loginLimiter('auth/login'), async (req, res) => {
  const { password, rememberMe } = req.body;
  const email = normalizeEmail(req.body.email);
  try {
    // Use a throwaway client just for sign-in — never the shared `supabase`
    // singleton. Calling signInWithPassword on that shared instance would
    // overwrite its session, making every later query on it (including the
    // admin_roles check below) silently run as this user under RLS instead
    // of as service_role.
    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      return res.render('auth/login', { error: 'Invalid email or password.', layout: false });
    }

    const { data: roleRow, error: roleErr } = await supabase
      .from('admin_roles')
      .select('role_type')
      .eq('user_id', data.user.id)
      .eq('role_type', 'super_admin')
      .maybeSingle();
    if (roleErr) {
      console.error('[auth] admin_roles query failed:', roleErr);
    }
    if (roleErr || !roleRow) {
      console.log('[auth] no matching super_admin row for user_id:', data.user.id);
      return res.render('auth/login', {
        error: 'This account does not have super admin access.',
        layout: false,
      });
    }
    clearLimit(req);
    req.session.superAdmin = { id: data.user.id, email: data.user.email, checkedAt: Date.now() };
    // Persisted in the session (not just set once on this response) so that
    // every later re-issue of the cookie — a flash message, a periodic role
    // re-check — keeps the 30-day lifetime instead of silently falling back
    // to the 12-hour default. That fallback was a second cause of "it keeps
    // logging me out".
    req.session.remember = rememberMe === 'on';
    if (req.session.remember) req.sessionOptions.maxAge = REMEMBER_ME_MAX_AGE;
    res.redirect('/');
  } catch (err) {
    console.error('[auth] super admin login failed:', err);
    res.render('auth/login', { error: 'Something went wrong. Try again.', layout: false });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ---------- HR contact ----------

router.get('/hr/login', (req, res) => {
  if (req.session.hrContact) return res.redirect('/hr');
  res.render('auth/hrLogin', { error: null, layout: false });
});

router.post('/hr/login', loginLimiter('auth/hrLogin'), async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  try {
    // Case-insensitive: contacts created before emails were normalized may
    // be stored with capitals, and people type their email however they like.
    const { data: contact, error } = await supabase
      .from('organization_hr_contacts')
      .select('id, org_id, email, password_hash, must_reset_password, status')
      .ilike('email', escapeLike(email))
      .maybeSingle();

    if (error || !contact || contact.status !== 'active' || !password) {
      return res.render('auth/hrLogin', { error: 'Invalid email or password.', layout: false });
    }

    const ok = await bcrypt.compare(password, contact.password_hash);
    if (!ok) {
      return res.render('auth/hrLogin', { error: 'Invalid email or password.', layout: false });
    }

    clearLimit(req);
    req.session.hrContact = {
      id: contact.id,
      orgId: contact.org_id,
      email: contact.email,
      mustResetPassword: contact.must_reset_password,
      checkedAt: Date.now(),
    };

    await supabase
      .from('organization_hr_contacts')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', contact.id);

    res.redirect(contact.must_reset_password ? '/hr/reset-password' : '/hr');
  } catch (err) {
    console.error('[auth] HR contact login failed:', err);
    res.render('auth/hrLogin', { error: 'Something went wrong. Try again.', layout: false });
  }
});

router.post('/hr/logout', (req, res) => {
  req.session = null;
  res.redirect('/hr/login');
});

router.get('/hr/reset-password', (req, res) => {
  if (!req.session.hrContact) return res.redirect('/hr/login');
  res.render('auth/hrResetPassword', { error: null, layout: false });
});

router.post('/hr/reset-password', async (req, res) => {
  if (!req.session.hrContact) return res.redirect('/hr/login');
  const { password, confirmPassword } = req.body;

  if (!password || password.length < 8) {
    return res.render('auth/hrResetPassword', {
      error: 'Password must be at least 8 characters.',
      layout: false,
    });
  }
  if (password !== confirmPassword) {
    return res.render('auth/hrResetPassword', { error: 'Passwords do not match.', layout: false });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { error } = await supabase
    .from('organization_hr_contacts')
    .update({ password_hash: passwordHash, must_reset_password: false })
    .eq('id', req.session.hrContact.id);
  if (error) {
    return res.render('auth/hrResetPassword', {
      error: 'Could not save your new password — please try again.',
      layout: false,
    });
  }

  req.session.hrContact.mustResetPassword = false;
  res.redirect('/hr');
});

// ---------- Support agent ----------
// Same underlying mechanism as super admin (real Supabase Auth user +
// admin_roles row), kept as a fully separate route/session key so this
// never touches the super admin login above.

router.get('/support/login', (req, res) => {
  if (req.session.superAdmin) return res.redirect('/support');
  if (req.session.supportAgent) {
    return res.redirect(req.session.supportAgent.roleType === 'finance' ? '/sessions/refunds' : '/support');
  }
  res.render('auth/supportLogin', { error: null, layout: false });
});

router.post('/support/login', loginLimiter('auth/supportLogin'), async (req, res) => {
  const { password, rememberMe } = req.body;
  const email = normalizeEmail(req.body.email);
  try {
    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      return res.render('auth/supportLogin', { error: 'Invalid email or password.', layout: false });
    }

    // Support agents and finance share this login. Finance lands on
    // Sessions & Refunds; support agents on the crisis console.
    const { data: roleRow, error: roleErr } = await supabase
      .from('admin_roles')
      .select('role_type')
      .eq('user_id', data.user.id)
      .in('role_type', ['support_agent', 'finance'])
      .maybeSingle();

    if (roleErr || !roleRow) {
      return res.render('auth/supportLogin', {
        error: 'This account does not have support or finance access.',
        layout: false,
      });
    }

    clearLimit(req);
    req.session.supportAgent = { id: data.user.id, email: data.user.email, roleType: roleRow.role_type, checkedAt: Date.now() };
    // Support agents live in this dashboard for a whole shift — same 30-day
    // opt-in as the super admin login, for the same reason.
    req.session.remember = rememberMe === 'on';
    if (req.session.remember) req.sessionOptions.maxAge = REMEMBER_ME_MAX_AGE;
    res.redirect(roleRow.role_type === 'finance' ? '/sessions/refunds' : '/support');
  } catch (err) {
    console.error('[auth] support agent login failed:', err);
    res.render('auth/supportLogin', { error: 'Something went wrong. Try again.', layout: false });
  }
});

router.post('/support/logout', (req, res) => {
  const wasSuperAdmin = Boolean(req.session && req.session.superAdmin);
  req.session = null;
  res.redirect(wasSuperAdmin ? '/login' : '/support/login');
});

module.exports = router;
