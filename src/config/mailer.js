const nodemailer = require('nodemailer');

// Railway blocks outbound 25/465/587, which is why a normal Resend SMTP
// config times out on CONN there. Resend publishes 2465 and 2587 as
// alternates for exactly this; 2465 is implicit TLS, 2587 is STARTTLS.
const IMPLICIT_TLS_PORTS = [465, 2465];
const port = Number(process.env.SMTP_PORT || 587);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: IMPLICIT_TLS_PORTS.includes(port),
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
  // Without these, a blocked port hangs the request for the OS default
  // (~75s) before failing. Fail fast instead — no email in this app is
  // worth holding a page load open for over a minute.
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
});

/**
 * Sends mail, and never throws.
 *
 * Every email this dashboard sends is a courtesy copy of something the UI
 * already shows (temp passwords appear in the flash message, invites can be
 * re-issued). A dead SMTP host previously took the whole process down: two
 * call sites in organizations.routes.js awaited this without a try/catch,
 * so a rejected promise became an unhandled rejection, which Node 22 exits
 * on. That is why the logs show the server restarting right after each
 * "Connection timeout".
 *
 * Returns {ok} rather than throwing so callers can report a failure without
 * every one of them needing its own guard.
 */
async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_HOST) {
    // No SMTP configured (e.g. local dev) — log instead, so the rest of the
    // flow (account creation, DB rows) can still be exercised.
    console.log(`[mailer] SMTP not configured — would have sent to ${to}: ${subject}`);
    console.log(html);
    return { ok: false, skipped: true };
  }

  try {
    const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, html });
    return { ok: true, info };
  } catch (err) {
    console.error(`[mailer] failed to send "${subject}" to ${to}: ${err.message}`);
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      console.error(
        `[mailer] port ${port} looks blocked. Railway blocks outbound 25/465/587 — ` +
          'use Resend\'s alternates: SMTP_PORT=2465 (TLS) or 2587 (STARTTLS).',
      );
    }
    return { ok: false, error: err };
  }
}

/**
 * Checks the SMTP connection once at boot and logs the result. Cheap, and
 * it turns a silently undelivered-mail problem into something visible in
 * the deploy logs instead of a support ticket a week later.
 */
function verifyMailer() {
  if (!process.env.SMTP_HOST) {
    console.warn('[mailer] SMTP_HOST is not set — all outbound email will be logged, not sent.');
    return;
  }
  transporter
    .verify()
    .then(() => console.log(`[mailer] SMTP ready (${process.env.SMTP_HOST}:${port})`))
    .catch((err) => {
      console.error(`[mailer] SMTP check failed (${process.env.SMTP_HOST}:${port}): ${err.message}`);
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
        console.error('[mailer] try SMTP_PORT=2465 or 2587 — Railway blocks the standard SMTP ports.');
      }
    });
}

module.exports = { sendMail, verifyMailer };
