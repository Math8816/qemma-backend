// ═══════════════════════════════════════════════
//  src/utils/mailer.js
//  إرسال البريد الإلكتروني
// ═══════════════════════════════════════════════

const nodemailer = require('nodemailer');

let transporter = null;

// ─── Init ───
function initMailer() {
  if (transporter) return transporter;

  // ─── في التطوير: نستخدم Ethereal (وهمي) ───
  if (process.env.NODE_ENV !== 'production') {
    console.log('📧 Mailer: Development mode (Ethereal)');
    return null; // سنطبع الرابط في console بدلاً من الإرسال
  }

  // ─── في الإنتاج: SMTP حقيقي ───
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

// ─── Send Email ───
async function sendEmail({ to, subject, html, text }) {
  // ─── في التطوير: نطبع في console ───
  if (process.env.NODE_ENV !== 'production') {
    console.log('\n═══════════════════════════════════');
    console.log('📧 EMAIL (Development Mode)');
    console.log('═══════════════════════════════════');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Text: ${text || '(no text)'}`);
    console.log('═══════════════════════════════════\n');
    return { ok: true, dev: true };
  }

  // ─── الإنتاج ───
  const t = initMailer();
  if (!t) throw new Error('Mailer not initialized');

  const info = await t.sendMail({
    from: process.env.SMTP_FROM || 'noreply@qemma.com',
    to,
    subject,
    html,
    text,
  });

  return { ok: true, messageId: info.messageId };
}

module.exports = { sendEmail, initMailer };