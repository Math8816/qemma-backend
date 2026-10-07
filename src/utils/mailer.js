// ═══════════════════════════════════════════════
//  src/utils/mailer.js
//  إرسال البريد الإلكتروني عبر Resend
// ═══════════════════════════════════════════════

const { Resend } = require('resend');

let resend = null;

// ─── Init ───
function initResend() {
  if (resend) return resend;
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️ RESEND_API_KEY not set. Email disabled.');
    return null;
  }
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('✅ Resend initialized');
  return resend;
}

// ─── Send Email ───
async function sendEmail({ to, subject, html, text }) {
  const client = initResend();

  // ─── في التطوير بدون مفتاح: اطبع في Console ───
  if (!client) {
    console.log('\n═══════════════════════════════════');
    console.log('📧 EMAIL (Console Mode)');
    console.log('═══════════════════════════════════');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Text: ${text || '(no text)'}`);
    console.log('═══════════════════════════════════\n');
    return { ok: true, dev: true };
  }

  // ─── الإنتاج: Resend ───
  try {
    const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    const fromName = process.env.EMAIL_FROM_NAME || 'Qemma';

    const { data, error } = await client.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html: html || `<p>${text || ''}</p>`,
      text: text || '',
    });

    if (error) {
      console.error('❌ Resend error:', error);
      throw new Error(error.message);
    }

    console.log(`✅ Email sent to ${to} (ID: ${data.id})`);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('❌ Email send error:', err.message);
    throw err;
  }
}

module.exports = { sendEmail, initResend };