// ═══════════════════════════════════════════════
//  01-auth.cy.js
//  اختبار Auth
// ═══════════════════════════════════════════════

describe('🔐 Auth API', () => {
  before(() => {
    cy.request('GET', '/health').should('have.property', 'status', 200);
  });

  it('✅ Login ناجح', () => {
    cy.request({
      method: 'POST',
      url: '/auth/v1/token?grant_type=password',
      body: { email: 'admin@qemma.local', password: 'Admin123' },
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body).to.have.property('access_token');
      expect(response.body).to.have.property('refresh_token');
      expect(response.body.user.email).to.eq('admin@qemma.local');
    });
  });

  it('❌ Login فاشل بكلمة مرور خاطئة', () => {
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

  it('❌ Login فاشل ببريد غير موجود', () => {
    cy.request({
      method: 'POST',
      url: '/auth/v1/token?grant_type=password',
      body: { email: 'noone@qemma.local', password: 'Admin123' },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(400);
    });
  });

  it('✅ GET /auth/v1/user', () => {
    cy.loginViaApi().then(() => {
      cy.authRequest({ method: 'GET', url: '/auth/v1/user' }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.email).to.eq('admin@qemma.local');
      });
    });
  });

  it('❌ GET /auth/v1/user بدون توكن', () => {
    cy.request({
      method: 'GET',
      url: '/auth/v1/user',
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(401);
    });
  });

  it('✅ Signup — مستخدم جديد', () => {
    const email = `test-${Date.now()}@qemma.local`;
    cy.request({
      method: 'POST',
      url: '/auth/v1/signup',
      body: {
        email,
        password: 'TestPassword123',
        full_name: 'Test User',
      },
    }).then((response) => {
      expect(response.status).to.eq(201);
      expect(response.body).to.have.property('access_token');
      expect(response.body.user.email).to.eq(email);
    });
  });

  it('❌ Signup — بريد مكرر', () => {
    cy.request({
      method: 'POST',
      url: '/auth/v1/signup',
      body: {
        email: 'admin@qemma.local',
        password: 'TestPassword123',
      },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(409);
    });
  });

  it('❌ Signup — كلمة مرور قصيرة', () => {
    cy.request({
      method: 'POST',
      url: '/auth/v1/signup',
      body: {
        email: `test-${Date.now()}@qemma.local`,
        password: '123',
      },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(400);
    });
  });
});