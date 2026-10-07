// ═══════════════════════════════════════════════
//  03-products.cy.js
//  اختبار Products API
// ═══════════════════════════════════════════════

describe('📦 Products API', () => {
  beforeEach(() => cy.loginViaApi());

  it('✅ GET /api/products', () => {
    cy.authRequest({ method: 'GET', url: '/api/products' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.ok).to.eq(true);
      expect(response.body.data).to.be.an('array');
    });
  });

  it('✅ GET /api/products/rls/list', () => {
    cy.authRequest({ method: 'GET', url: '/api/products/rls/list' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.user).to.not.eq('anonymous');
    });
  });

  it('✅ GET /api/products/rls/list بدون توكن', () => {
    cy.request({
      method: 'GET',
      url: '/api/products/rls/list',
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.user).to.eq('anonymous');
      expect(response.body.count).to.eq(0);
    });
  });
});