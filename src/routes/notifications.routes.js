const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');

const router = express.Router();
router.use(requireSuperAdmin);

/**
 * Who a broadcast goes to.
 *
 * `resolve(orgId)` takes NULL for platform-wide (every client with an
 * account) or an org id to target one company's employees. Both paths
 * filter to people who can actually receive something: an employee row
 * with status 'invited' has no user_id, so including it would inflate the
 * recipient count with sends that go nowhere.
 */
async function orgMemberIds(orgId) {
  const { data } = await supabase
    .from('organization_employees')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .not('user_id', 'is', null);
  return (data || []).map((r) => r.user_id);
}

async function allClientIds() {
  // client_profiles rather than users: a row here means they finished
  // onboarding, which is the point at which the app is usable to them.
  const { data } = await supabase.from('client_profiles').select('user_id');
  return (data || []).map((r) => r.user_id);
}

const AUDIENCES = {
  all: {
    label: 'Everyone',
    hint: 'All clients with a completed profile.',
    async resolve(orgId) {
      return orgId ? orgMemberIds(orgId) : allClientIds();
    },
  },

  no_sessions: {
    label: "Haven't booked a session yet",
    hint: 'People with an account who have never booked.',
    async resolve(orgId) {
      const ids = await AUDIENCES.all.resolve(orgId);
      if (!ids.length) return [];
      const booked = new Set();
      // Chunked: `.in()` builds a URL query string, and a few thousand
      // uuids in one call exceeds what PostgREST will accept.
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase
          .from('sessions')
          .select('client_id')
          .in('client_id', ids.slice(i, i + 300));
        (data || []).forEach((s) => booked.add(s.client_id));
      }
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
      const active = new Set();
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase
          .from('survey_responses')
          .select('user_id')
          .in('user_id', ids.slice(i, i + 300))
          .gte('response_date', cutoff);
        (data || []).forEach((r) => active.add(r.user_id));
      }
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
    key: 'daily_checkin_reminder',
    name: 'Daily mood check-in reminder',
    description:
      "Sent once a day at the hour you choose, in each person's own timezone. Skipped automatically for anyone who has already checked in that day.",
    defaults: {
      title: 'Time for your check-in',
      body: 'A quick mood check-in takes under a minute. How are you doing today?',
    },
    placeholders: ['name'],
    configFields: [
      { key: 'send_hour', label: 'Hour to send (0–23, local to each person)', type: 'number', default: 9 },
    ],
  },
  {
    key: 'checkin_nudge',
    name: 'Lapsed check-in nudge',
    description:
      'A stronger nudge for people who have stopped checking in entirely. Use alongside the daily reminder, or instead of it.',
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
    // Scope comes from the query string so the audience counts below can be
    // recalculated when an operator picks a different organisation.
    const orgId = req.query.org_id || null;

    const { data: organizations } = await supabase
      .from('organizations')
      .select('id, company_name')
      .order('company_name');

    let query = supabase.from('broadcasts').select('*').order('created_at', { ascending: false }).limit(40);
    const { data: broadcasts } = await query;

    const orgNames = Object.fromEntries((organizations || []).map((o) => [o.id, o.company_name]));

    // Read counts, one query for all rows rather than one per row.
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

    res.render('notifications/broadcasts', {
      broadcasts: broadcasts || [],
      readCounts,
      organizations: organizations || [],
      orgNames,
      selectedOrgId: orgId,
      audiences: Object.entries(AUDIENCES).map(([key, a]) => ({ key, label: a.label, hint: a.hint })),
      audienceSizes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts', async (req, res, next) => {
  try {
    // Empty string from the "All clients" option means platform-wide.
    const orgId = req.body.org_id ? req.body.org_id : null;
    const title = (req.body.title || '').trim();
    const body = (req.body.body || '').trim();
    const audienceKey = req.body.audience || 'all';
    const backTo = orgId ? `/notifications/broadcasts?org_id=${orgId}` : '/notifications/broadcasts';

    if (!title || !body) {
      req.setFlash({ type: 'error', message: 'A title and a message are both required.' });
      return res.redirect(backTo);
    }
    const audience = AUDIENCES[audienceKey];
    if (!audience) {
      req.setFlash({ type: 'error', message: 'Unknown audience.' });
      return res.redirect(backTo);
    }

    const recipients = await audience.resolve(orgId);
    if (!recipients.length) {
      req.setFlash({ type: 'error', message: 'Nobody matches that audience right now, so nothing was sent.' });
      return res.redirect(backTo);
    }

    // The broadcast row is written FIRST so the fan-out can reference it.
    // If the fan-out then fails we delete it again — a broadcast row with
    // no notifications would show in the history as if it had been sent.
    const { data: broadcast, error: broadcastErr } = await supabase
      .from('broadcasts')
      .insert({
        org_id: orgId,
        sent_by_admin_id: req.session.superAdmin.id,
        title,
        body,
        audience: audienceKey,
        recipient_count: recipients.length,
      })
      .select()
      .single();

    if (broadcastErr || !broadcast) {
      req.setFlash({ type: 'error', message: `Could not save the broadcast: ${broadcastErr?.message}` });
      return res.redirect(backTo);
    }

    const rows = recipients.map((userId) => ({
      recipient_id: userId,
      type: 'announcement',
      title,
      body,
      sent_via: 'in_app',
      broadcast_id: broadcast.id,
    }));

    // Chunked: a platform-wide send is one insert per 500 people rather
    // than a single request PostgREST would reject outright.
    const CHUNK = 500;
    let delivered = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from('notifications').insert(slice);
      if (error) {
        console.error('[notifications] broadcast fan-out failed', error);
        break;
      }
      delivered += slice.length;
    }

    if (!delivered) {
      await supabase.from('broadcasts').delete().eq('id', broadcast.id);
      req.setFlash({ type: 'error', message: 'The message could not be delivered — nothing was sent.' });
      return res.redirect(backTo);
    }

    if (delivered !== recipients.length) {
      await supabase.from('broadcasts').update({ recipient_count: delivered }).eq('id', broadcast.id);
    }

    await logAction({
      adminId: req.session.superAdmin.id,
      action: 'broadcast.sent',
      targetTable: 'broadcasts',
      targetId: broadcast.id,
      details: { org_id: orgId, audience: audienceKey, recipients: delivered, title },
    });

    req.setFlash({
      type: 'success',
      message:
        delivered === recipients.length
          ? `Sent to ${delivered} ${delivered === 1 ? 'person' : 'people'}.`
          : `Partially sent — reached ${delivered} of ${recipients.length}. Check the logs.`,
    });
    res.redirect(backTo);
  } catch (err) {
    next(err);
  }
});

/**
 * Deletes a broadcast and every copy of it. Deliberately removes the
 * notifications too: "unsend" that leaves the message sitting in everyone's
 * inbox isn't unsending. Already-read copies go as well — there's no way to
 * un-read them, but leaving them would make the history lie about what
 * still exists.
 */
router.post('/broadcasts/:id/delete', async (req, res, next) => {
  try {
    const { data: broadcast } = await supabase
      .from('broadcasts')
      .select('id, title')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!broadcast) {
      req.setFlash({ type: 'error', message: 'That broadcast no longer exists.' });
      return res.redirect('/notifications/broadcasts');
    }

    await supabase.from('notifications').delete().eq('broadcast_id', broadcast.id);
    await supabase.from('broadcasts').delete().eq('id', broadcast.id);

    await logAction({
      adminId: req.session.superAdmin.id,
      action: 'broadcast.deleted',
      targetTable: 'broadcasts',
      targetId: broadcast.id,
      details: { title: broadcast.title },
    });

    req.setFlash({ type: 'success', message: 'Broadcast deleted and removed from every inbox.' });
    res.redirect('/notifications/broadcasts');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

router.get('/automations', async (req, res, next) => {
  try {
    // No org_id means the platform-wide rule set — the normal case. Picking
    // an organisation edits an override that applies to that company's
    // employees only.
    const orgId = req.query.org_id || null;

    const { data: organizations } = await supabase
      .from('organizations')
      .select('id, company_name')
      .order('company_name');

    let rulesQuery = supabase.from('notification_rules').select('*');
    rulesQuery = orgId ? rulesQuery.eq('org_id', orgId) : rulesQuery.is('org_id', null);
    const { data: saved } = await rulesQuery;
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

    res.render('notifications/automations', {
      rules,
      recent: recent || [],
      organizations: organizations || [],
      selectedOrgId: orgId,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/automations/:key', async (req, res, next) => {
  try {
    const orgId = req.body.org_id ? req.body.org_id : null;
    const backTo = orgId ? `/notifications/automations?org_id=${orgId}` : '/notifications/automations';

    const rule = RULES.find((r) => r.key === req.params.key);
    if (!rule) {
      req.setFlash({ type: 'error', message: 'Unknown automation.' });
      return res.redirect(backTo);
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

    // Two upsert paths because the uniqueness is enforced by two PARTIAL
    // indexes (org_id,rule_key where org_id is not null; rule_key where it
    // is null) — onConflict on 'org_id,rule_key' can't match a NULL org.
    let error;
    if (orgId) {
      ({ error } = await supabase.from('notification_rules').upsert(
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
      ));
    } else {
      const { data: existing } = await supabase
        .from('notification_rules')
        .select('id')
        .is('org_id', null)
        .eq('rule_key', rule.key)
        .maybeSingle();

      const payload = {
        org_id: null,
        rule_key: rule.key,
        is_enabled: isEnabled,
        title,
        body,
        config,
        updated_at: new Date().toISOString(),
      };

      ({ error } = existing
        ? await supabase.from('notification_rules').update(payload).eq('id', existing.id)
        : await supabase.from('notification_rules').insert(payload));
    }

    if (error) {
      req.setFlash({ type: 'error', message: `Could not save: ${error.message}` });
    } else {
      await logAction({
        adminId: req.session.superAdmin.id,
        action: isEnabled ? 'automation.enabled' : 'automation.disabled',
        targetTable: 'notification_rules',
        targetId: null,
        details: { rule_key: rule.key, org_id: orgId },
      });
      req.setFlash({
        type: 'success',
        message: isEnabled ? `${rule.name} is on.` : `${rule.name} is off.`,
      });
    }
    res.redirect(backTo);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
