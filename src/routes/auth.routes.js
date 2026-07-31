const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');

const router = express.Router();

// ---------- Super admin ----------

router.get('/login', (req, res) => {
  if (req.session.superAdmin) return res.redirect('/');
  res.render('auth/login', { error: null, layout: false });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      return res.render('auth/login', { error: 'Invalid email or password.', layout: false });
    }

    const { data: roleRow, error: roleErr } = await supabase
      .from('admin_roles')
      .select('role_type')
      .eq('user_id', data.user.id)
      .eq('role_type', 'super_admin')
      .maybeSingle();

    if (roleErr || !roleRow) {
      return res.render('auth/login', {
        error: 'This account does not have super admin access.',
        layout: false,
      });
    }

    req.session.superAdmin = { id: data.user.id, email: data.user.email };
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

router.post('/hr/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data: contact, error } = await supabase
      .from('organization_hr_contacts')
      .select('id, org_id, email, password_hash, must_reset_password, status')
      .eq('email', email)
      .maybeSingle();

    if (error || !contact || contact.status !== 'active') {
      return res.render('auth/hrLogin', { error: 'Invalid email or password.', layout: false });
    }

    const ok = await bcrypt.compare(password, contact.password_hash);
    if (!ok) {
      return res.render('auth/hrLogin', { error: 'Invalid email or password.', layout: false });
    }

    req.session.hrContact = {
      id: contact.id,
      orgId: contact.org_id,
      email: contact.email,
      mustResetPassword: contact.must_reset_password,
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
  await supabase
    .from('organization_hr_contacts')
    .update({ password_hash: passwordHash, must_reset_password: false })
    .eq('id', req.session.hrContact.id);

  req.session.hrContact.mustResetPassword = false;
  res.redirect('/hr');
});

module.exports = router;
