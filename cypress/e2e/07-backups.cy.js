// ═══════════════════════════════════════════════
//  07-backups.cy.js
//  اختبار Backups API
// ═══════════════════════════════════════════════

describe('💾 Backups API', () => {
  beforeEach(() => cy.loginViaApi());

  it('✅ GET /storage/v1/list/backups', () => {
    cy.authRequest({
      method: 'GET',
      url: '/storage/v1/list/backups',
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.ok).to.eq(true);
      expect(response.body.bucket).to.eq('backups');
      expect(response.body.data).to.be.an('array');
    });
  });

  it('✅ POST /storage/v1/backup/create — إنشاء', () => {
    cy.authRequest({
      method: 'POST',
      url: '/storage/v1/backup/create',
      timeout: 30000, // pg_dump يستغرق وقتاً
    }).then((response) => {
      expect(response.status).to.eq(201);
      expect(response.body.ok).to.eq(true);
      expect(response.body.data.name).to.match(/^qemma-.*\.sql$/);
      expect(Number(response.body.data.size)).to.be.greaterThan(0);
    });
  });

  it('❌ POST /storage/v1/backup/create بدون توكن', () => {
    cy.request({
      method: 'POST',
      url: '/storage/v1/backup/create',
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(401);
    });
  });
});