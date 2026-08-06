const express = require('express');
const { supabase } = require('../config/supabase');
const { requireHrContact } = require('../middleware/auth');

const router = express.Router();
router.use(requireHrContact);

/**
 * Audiences an HR contact can send to.
 *
 * `resolve` returns the user_ids to notify. Every one of them filters on
 * status 'active' AND a non-null user_id: an employee who was invited but
 * never signed up has no account to receive anything, and including them
 * would inflate the recipient count with sends that silently go nowhere.
 */
const AUDIENCES = {
  all: {
    label: 'Everyone with an account',
    hint: 'All employees who have signed up.',
    async resolve(orgId) {
      const { data } = await supabase
        .from('organization_employees')
        .select('user_id')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .not('user_id', 'is', null);
      return (data || []).map((r) => r.user_id);
    },
  },

  no_sessions: {
    label: "Haven't booked a session yet",
    hint: 'People who have an account but have never booked.',
    async resolve(orgId) {
      const ids = await AUDIENCES.all.resolve(orgId);
      if (!ids.length) return [];
      const { data } = await supabase.from('sessions').select('client_id').in('client_id', ids);
      const booked = new Set((data || []).map((s) => s.client_id));
      return ids.filter((id) => !booked.has(id));
    },
  },

  inactive: {
    label: 'Not checked in for 14 days',
    hint: 'People who have gone quiet in the app.',
    async resolve(orgId) {
      const ids = await AUDIENCES.all.resolve(orgId);
      if (!ids.length) return [];
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data } = await supabase
        .from('survey_responses')
        .select('user_id')
        .in('user_id', ids)
        .gte('response_date', cutoff);
      const active = new Set((data || []).map((r) => r.user_id));
      return ids.filter((id) => !active.has(id));
    },
  },
};

/**
 * The automated rules an HR contact can turn on, with the copy they ship
 * with. rule_key must match a branch in fn_run_notification_rules() — a key
 * with no branch saves fine and then never fires, which is the confusing
 * failure to avoid.
 */
const RULES = [
  {
    key: 'session_reminder_24h',
    name: 'Session reminder — 24 hours before',
    description: 'Sent the day before a confirmed therapy session.',
    defaults: {
      title: 'Your session is tomorrow',
      body: 'You have a session with {{provider}} tomorrow at {{time}}.',
    },
    placeholders: ['provider', 'time'],
  },
  {
    key: 'session_reminder_1h',
    name: 'Session reminder — 1 hour before',
    description: 'A last nudge shortly before the session starts.',
    defaults: {
      title: 'Your session starts soon',
      body: 'Your session with {{provider}} starts at {{time}}. Find a quiet spot when you can.',
    },
    placeholders: ['provider', 'time'],
  },
  {
    key: 'checkin_nudge',
    name: 'Check-in nudge',
    description: 'Sent when someone has not done their daily mood check-in for a while.',
    defaults: {
      title: 'How have you been?',
      body: "It's been a little while since your last check-in. A minute is all it takes.",
    },
    placeholders: ['name'],
    // Named configFields, not config: the SAVED values are also called
    // config (the jsonb column), and having both under one name meant the
    // saved object overwrote this list and the fields stopped rendering.
    configFields: [{ key: 'quiet_days', label: 'Days of silence before sending', type: 'number', default: 7 }],
  },
  {
    key: 'employee_welcome',
    name: 'Welcome message',
    description: 'Sent once, the first time an employee’s account joins your organization.',
    defaults: {
      title: 'Welcome aboard',
      body: 'Your employer has given you full access to Where’s My Therapist. Everything here is private to you.',
    },
    placeholders: ['name'],
  },
  {
    key: 'wellness_report_ready',
    name: 'Wellness report published',
    description: 'Sent when a new wellness report is shared with an employee.',
    defaults: {
      title: 'Your wellness report is ready',
      body: '“{{report}}” is now available in your Wellness tab.',
    },
    placeholders: ['report'],
  },
];

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

router.get('/broadcasts', async (req, res, next) => {
  try {
    const orgId = req.session.hrContact.orgId;

    const { data: broadcasts } = await supabase
      .from('broadcasts')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(30);

    // Read counts, one query for all of them rather than one per row.
    const ids = (broadcasts || []).map((b) => b.id);
    const readCounts = {};
    if (ids.length) {
      const { data: reads } = await supabase
        .from('notifications')
        .select('broadcast_id, is_read')
        .in('broadcast_id', ids);
      (reads || []).forEach((n) => {
        if (!n.is_read) return;
        readCounts[n.broadcast_id] = (readCounts[n.broadcast_id] || 0) + 1;
      });
    }

    const audienceSizes = {};
    for (const [key, audience] of Object.entries(AUDIENCES)) {
      audienceSizes[key] = (await audience.resolve(orgId)).length;
    }

    res.render('hrPortal/broadcasts', {
      layout: 'partials/hrLayout',
      broadcasts: broadcasts || [],
      readCounts,
      audiences: Object.entries(AUDIENCES).map(([key, a]) => ({ key, label: a.label, hint: a.hint })),
      audienceSizes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts', async (req, res, next) => {
  try {
    const orgId = req.session.hrContact.orgId;
    const title = (req.body.title || '').trim();
    const body = (req.body.body || '').trim();
    const audienceKey = req.body.audience || 'all';

    if (!title || !body) {
      req.setFlash({ type: 'error', message: 'A title and a message are both required.' });
      return res.redirect('/hr/broadcasts');
    }
    const audience = AUDIENCES[audienceKey];
    if (!audience) {
      req.setFlash({ type: 'error', message: 'Unknown audience.' });
      return res.redirect('/hr/broadcasts');
    }

    const recipients = await audience.resolve(orgId);
    if (!recipients.length) {
      req.setFlash({
        type: 'error',
        message: 'Nobody matches that audience right now, so nothing was sent.',
      });
      return res.redirect('/hr/broadcasts');
    }

    // The broadcast row is written FIRST so the fan-out can reference it.
    // If the fan-out then fails we delete it again — a broadcast row with
    // no notifications would show in the history as if it had been sent.
    const { data: broadcast, error: broadcastErr } = await supabase
      .from('broadcasts')
      .insert({
        org_id: orgId,
        sent_by_hr_contact_id: req.session.hrContact.id,
        title,
        body,
        audience: audienceKey,
        recipient_count: recipients.length,
      })
      .select()
      .single();

    if (broadcastErr || !broadcast) {
      req.setFlash({ type: 'error', message: `Could not save the broadcast: ${broadcastErr?.message}` });
      return res.redirect('/hr/broadcasts');
    }

    // Chunked: a 5,000-employee org would otherwise be a single insert far
    // past what PostgREST will accept in one request.
    const rows = recipients.map((userId) => ({
      recipient_id: userId,
      type: 'announcement',
      title,
      body,
      sent_via: 'in_app',
      broadcast_id: broadcast.id,
    }));

    const CHUNK = 500;
    let delivered = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('notifications').insert(rows.slice(i, i + CHUNK));
      if (error) {
        console.error('[hr-portal] broadcast fan-out failed', error);
        break;
      }
      delivered += rows.slice(i, i + CHUNK).length;
    }

    if (!delivered) {
      await supabase.from('broadcasts').delete().eq('id', broadcast.id);
      req.setFlash({ type: 'error', message: 'The message could not be delivered — nothing was sent.' });
      return res.redirect('/hr/broadcasts');
    }

    if (delivered !== recipients.length) {
      await supabase.from('broadcasts').update({ recipient_count: delivered }).eq('id', broadcast.id);
    }

    req.setFlash({
      type: 'success',
      message:
        delivered === recipients.length
          ? `Sent to ${delivered} ${delivered === 1 ? 'person' : 'people'}.`
          : `Partially sent — reached ${delivered} of ${recipients.length}. Check the logs.`,
    });
    res.redirect('/hr/broadcasts');
  } catch (err) {
    next(err);
  }
});

/**
 * Deletes a broadcast and every copy of it. Deliberately removes the
 * notifications too: "unsend" that leaves the message sitting in everyone's
 * inbox isn't unsending. Already-read copies go as well — there's no way to
 * un-read them, but leaving them would make the history lie about what
 * exists.
 */
router.post('/broadcasts/:id/delete', async (req, res, next) => {
  try {
    const orgId = req.session.hrContact.orgId;

    // Scoped to the caller's org so an id from another org can't be deleted.
    const { data: broadcast } = await supabase
      .from('broadcasts')
      .select('id')
      .eq('id', req.params.id)
      .eq('org_id', orgId)
      .maybeSingle();

    if (!broadcast) {
      req.setFlash({ type: 'error', message: 'That broadcast no longer exists.' });
      return res.redirect('/hr/broadcasts');
    }

    await supabase.from('notifications').delete().eq('broadcast_id', broadcast.id);
    await supabase.from('broadcasts').delete().eq('id', broadcast.id);

    req.setFlash({ type: 'success', message: 'Broadcast deleted and removed from everyone’s inbox.' });
    res.redirect('/hr/broadcasts');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

router.get('/automations', async (req, res, next) => {
  try {
    const orgId = req.session.hrContact.orgId;

    const { data: saved } = await supabase.from('notification_rules').select('*').eq('org_id', orgId);
    const byKey = Object.fromEntries((saved || []).map((r) => [r.rule_key, r]));

    // Rules with no row yet render from their defaults, switched off. That
    // way the page shows every available automation rather than only the
    // ones someone has already touched.
    const rules = RULES.map((rule) => ({
      ...rule,
      saved: byKey[rule.key] || null,
      isEnabled: byKey[rule.key] ? byKey[rule.key].is_enabled : false,
      title: byKey[rule.key] ? byKey[rule.key].title : rule.defaults.title,
      body: byKey[rule.key] ? byKey[rule.key].body : rule.defaults.body,
      configValues: byKey[rule.key] ? byKey[rule.key].config || {} : {},
    }));

    // Last 20 automated sends, so HR can see the rules are actually running.
    const { data: recent } = await supabase
      .from('notification_log')
      .select('rule_key, created_at')
      .order('created_at', { ascending: false })
      .limit(20);

    res.render('hrPortal/automations', {
      layout: 'partials/hrLayout',
      rules,
      recent: recent || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/automations/:key', async (req, res, next) => {
  try {
    const orgId = req.session.hrContact.orgId;
    const rule = RULES.find((r) => r.key === req.params.key);
    if (!rule) {
      req.setFlash({ type: 'error', message: 'Unknown automation.' });
      return res.redirect('/hr/automations');
    }

    const title = (req.body.title || '').trim() || rule.defaults.title;
    const body = (req.body.body || '').trim() || rule.defaults.body;

    // Unchecked checkboxes aren't submitted at all, so absence means off.
    const isEnabled = req.body.is_enabled === 'on' || req.body.is_enabled === 'true';

    const config = {};
    for (const field of rule.configFields || []) {
      const raw = req.body[`config_${field.key}`];
      if (raw === undefined || raw === '') {
        config[field.key] = field.default;
      } else {
        config[field.key] = field.type === 'number' ? Number(raw) : raw;
      }
    }

    const { error } = await supabase.from('notification_rules').upsert(
      {
        org_id: orgId,
        rule_key: rule.key,
        is_enabled: isEnabled,
        title,
        body,
        config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,rule_key' },
    );

    if (error) {
      req.setFlash({ type: 'error', message: `Could not save: ${error.message}` });
    } else {
      req.setFlash({
        type: 'success',
        message: isEnabled ? `${rule.name} is on.` : `${rule.name} is off.`,
      });
    }
    res.redirect('/hr/automations');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
