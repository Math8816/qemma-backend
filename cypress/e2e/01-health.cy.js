// ═══════════════════════════════════════════════
//  01-health.cy.js
//  فحص السيرفر
// ═══════════════════════════════════════════════

describe('Health Check', () => {
  it('GET /health — السيرفر يعمل', () => {
    cy.request('/health').then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.ok).to.eq(true);
      expect(response.body.service).to.eq('qemma-backend');
    });
  });

  it('GET /db-check — قاعدة البيانات متصلة', () => {
    cy.request('/db-check').then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.ok).to.eq(true);
      expect(response.body.database).to.eq('qemma_services');
    });
  });
});