// ═══════════════════════════════════════════════
//  09-rate-limit.cy.js
//  اختبار Rate Limiting
// ═══════════════════════════════════════════════

describe('⏱️ Rate Limiting', () => {
  it('⏱️ Auth: يُعيد 429 بعد محاولات كثيرة', () => {
    // ─── 11 محاولة فاشلة ───
    Cypress._.times(11, (i) => {
      cy.request({
        method: 'POST',
        url: '/auth/v1/token?grant_type=password',
        body: { email: 'admin@qemma.local', password: `Wrong${i}` },
        failOnStatusCode: false,
      });
    });

    // ─── المحاولة 12 يجب أن تُرفض ───
    cy.request({
      method: 'POST',
      url: '/auth/v1/token?grant_type=password',
      body: { email: 'admin@qemma.local', password: 'Wrong' },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(429);
    });
  });
});