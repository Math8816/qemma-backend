describe('🔧 Generic CRUD', () => {
  beforeEach(() => cy.loginViaApi());

  it('✅ GET /api/generic — قائمة الجداول', () => {
    cy.authRequest({ method: 'GET', url: '/api/generic' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.allowed_tables).to.be.an('array');
      expect(response.body.count).to.be.greaterThan(0);
    });
  });

  it('✅ GET /api/generic/customers', () => {
    cy.authRequest({ method: 'GET', url: '/api/generic/customers' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.data).to.be.an('array');
    });
  });

  it('❌ GET /api/generic/users — مرفوض', () => {
    cy.authRequest({
      method: 'GET',
      url: '/api/generic/users',
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(403);
    });
  });

  it('✅ POST /api/generic/customers — إنشاء', () => {
    const name = `Test-${Date.now()}`;
    cy.authRequest({
      method: 'POST',
      url: '/api/generic/customers',
      body: { full_name: name, phone: '999' },
    }).then((response) => {
      expect(response.status).to.eq(201);
      expect(response.body.data.full_name).to.eq(name);
    });
  });
});