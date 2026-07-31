const { supabase } = require('../config/supabase');

/**
 * Records an admin action against the existing admin_audit_log table
 * (admin_id, action, target_table, target_id, details jsonb, created_at).
 * Fire-and-forget by design: an audit-log failure should never block the
 * action it's describing, just get logged to stderr for follow-up.
 */
async function logAction({ adminId, action, targetTable, targetId, details }) {
  const { error } = await supabase.from('admin_audit_log').insert({
    admin_id: adminId,
    action,
    target_table: targetTable,
    target_id: targetId,
    details: details || {},
  });
  if (error) {
    console.error('[audit] failed to write admin_audit_log:', error.message);
  }
}

module.exports = { logAction };
