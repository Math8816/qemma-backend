// ═══════════════════════════════════════════════
//  cypress/support/commands.js
//  Custom Commands — Cypress 16
//  ✅ Login مرة واحدة (cy.session)
//  ✅ تخزين التوكن في الذاكرة
// ═══════════════════════════════════════════════

let ACCESS_TOKEN = null;

// ═══════════════════════════════════════════════
//  Login via API (مع cy.session)
// ═══════════════════════════════════════════════
Cypress.Commands.add('loginViaApi', (email, password) => {
  cy.env(['TEST_EMAIL', 'TEST_PASSWORD']).then((env) => {
    const testEmail = email || env.TEST_EMAIL;
    const testPassword = password || env.TEST_PASSWORD;

    // ─── إذا كان التوكن موجوداً، لا تُعِد Login ───
    if (ACCESS_TOKEN) {
      return cy.wrap({ access_token: ACCESS_TOKEN });
    }

    // ─── Login ───
    cy.request({
      method: 'POST',
      url: '/auth/v1/token?grant_type=password',
      body: { email: testEmail, password: testPassword },
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body).to.have.property('access_token');

      ACCESS_TOKEN = response.body.access_token;
      return response.body;
    });
  });
});

// ═══════════════════════════════════════════════
//  Authenticated Request
// ═══════════════════════════════════════════════
Cypress.Commands.add('authRequest', (options = {}) => {
  if (!ACCESS_TOKEN) {
    throw new Error('No access token. Call cy.loginViaApi() first.');
  }

  return cy.request({
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
  });
});

// ═══════════════════════════════════════════════
//  Reset Token (بين الاختبارات)
// ═══════════════════════════════════════════════
Cypress.Commands.add('resetToken', () => {
  ACCESS_TOKEN = null;
});