// ═══════════════════════════════════════════════
//  cypress/support/e2e.js
//  Support File — Cypress Global Setup
// ═══════════════════════════════════════════════

import './commands';

// ─── تجاهل الأخطاء غير الحرجة ───
Cypress.on('uncaught:exception', (err) => {
  if (err.message.includes('ResizeObserver')) return false;
  if (err.message.includes('AbortError')) return false;
  return true;
});