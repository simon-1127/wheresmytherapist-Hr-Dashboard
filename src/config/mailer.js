const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_HOST) {
    // No SMTP configured (e.g. local dev) — log instead of throwing, so the
    // rest of the flow (account creation, DB rows) can still be exercised.
    console.log(`[mailer] SMTP not configured — would have sent to ${to}: ${subject}`);
    console.log(html);
    return { skipped: true };
  }
  return transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, html });
}

module.exports = { sendMail };
