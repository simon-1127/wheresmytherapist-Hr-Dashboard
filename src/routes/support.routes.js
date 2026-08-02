const express = require('express');
const { pool } = require('../config/db');
const { requireSupportAccess } = require('../middleware/auth');

const router = express.Router();
router.use(requireSupportAccess);

router.get('/', (req, res) => res.redirect('/settings'));

router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const messageId = req.query.message;

  // Table/column names below match wmt-database (users, client_profiles,
  // ai_messages) — confirm against your actual schema if anything's moved.
  const { rows: profileRows } = await pool.query(
    `SELECT u.id, u.email, u.phone, cp.full_name, cp.subscription_tier
     FROM users u JOIN client_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const profile = profileRows[0];
  if (!profile) return res.status(404).render('errors/404', { layout: false });

  let messages = [];
  if (messageId) {
    // ai_messages has no user_id column directly — ownership is verified
    // through ai_conversations. Also: the column is `sender` (enum: 'user'
    // | 'ai'), not `role`.
    const { rows: msgRows } = await pool.query(
      `SELECT m.conversation_id FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND c.user_id = $2`,
      [messageId, userId],
    );
    // Deliberately empty, not the user's other conversations, if this
    // doesn't resolve — "only the crisis chat" is the whole point here.
    if (msgRows[0]) {
      const { rows } = await pool.query(
        `SELECT id, sender, content, created_at FROM ai_messages
         WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [msgRows[0].conversation_id],
      );
      messages = rows;
    }
  }

  res.render('support/user', {
    profile,
    messages,
    flaggedMessageId: messageId || null,
    layout: 'partials/supportLayout',
  });
});

module.exports = router;
