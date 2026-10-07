describe('📋 Audit Log', () => {
  beforeEach(() => cy.loginViaApi());

  it('✅ GET /api/audit', () => {
    cy.authRequest({ method: 'GET', url: '/api/audit' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.data).to.be.an('array');
    });
  });

  it('✅ GET /api/audit/stats', () => {
    cy.authRequest({ method: 'GET', url: '/api/audit/stats' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.by_action).to.be.an('array');
    });
  });
});