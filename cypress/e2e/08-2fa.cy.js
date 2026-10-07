// ═══════════════════════════════════════════════
//  08-2fa.cy.js
//  اختبار 2FA
// ═══════════════════════════════════════════════

describe('🔐 2FA API', () => {
  beforeEach(() => cy.loginViaApi());

  it('✅ دورة 2FA كاملة', () => {
    // ─── 1. تفعيل ───
    cy.authRequest({
      method: 'POST',
      url: '/auth/v1/2fa/enable',
    }).then((enableResponse) => {
      expect(enableResponse.status).to.eq(200);
      expect(enableResponse.body.ok).to.eq(true);
      expect(enableResponse.body.secret).to.have.length(40);

      // ─── 2. التحقق ───
      cy.authRequest({
        method: 'POST',
        url: '/auth/v1/2fa/verify',
        body: { code: '123456' },
      }).then((verifyResponse) => {
        expect(verifyResponse.status).to.eq(200);
        expect(verifyResponse.body.ok).to.eq(true);

        // ─── 3. الحالة ───
        cy.authRequest({
          method: 'GET',
          url: '/auth/v1/2fa/status',
        }).then((statusResponse) => {
          expect(statusResponse.body.enabled).to.eq(true);

          // ─── 4. تعطيل ───
          cy.authRequest({
            method: 'POST',
            url: '/auth/v1/2fa/disable',
          }).then((disableResponse) => {
            expect(disableResponse.body.ok).to.eq(true);
          });
        });
      });
    });
  });

  it('❌ verify برمز خاطئ', () => {
    cy.authRequest({
      method: 'POST',
      url: '/auth/v1/2fa/enable',
    }).then(() => {
      cy.authRequest({
        method: 'POST',
        url: '/auth/v1/2fa/verify',
        body: { code: '000000' },
        failOnStatusCode: false,
      }).then((response) => {
        expect(response.status).to.eq(400);
      });
    });
  });

  it('❌ enable بدون توكن', () => {
    cy.request({
      method: 'POST',
      url: '/auth/v1/2fa/enable',
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(401);
    });
  });
});