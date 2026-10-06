// ═══════════════════════════════════════════════
//  02-auth.cy.js
//  اختبار Auth
// ═══════════════════════════════════════════════

describe('Auth', () => {
  it('Login ناجح', () => {
    cy.loginViaApi();
  });

  it('Login فاشل بكلمة مرور خاطئة', () => {
    cy.request({
      method: 'POST',
      url: '/auth/v1/token?grant_type=password',
      body: { email: 'admin@qemma.local', password: 'WrongPassword' },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(400);
      expect(response.body.error).to.eq('invalid_grant');
    });
  });

  it('GET /auth/v1/user — بوجود توكن', () => {
    cy.loginViaApi().then(() => {
      cy.authRequest({ method: 'GET', url: '/auth/v1/user' }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.email).to.eq('admin@qemma.local');
      });
    });
  });
});