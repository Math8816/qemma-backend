// ═══════════════════════════════════════════════
//  06-storage.cy.js
//  اختبار Storage API
// ═══════════════════════════════════════════════

describe('📁 Storage API', () => {
  let accessToken = null;

  beforeEach(() => {
    cy.loginViaApi().then((auth) => {
      accessToken = auth.access_token;
    });
  });

  it('✅ GET /storage/v1/buckets — قائمة Buckets', () => {
    cy.request({
      method: 'GET',
      url: '/storage/v1/buckets',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.ok).to.eq(true);
      expect(response.body.data).to.be.an('array');

      const bucketIds = response.body.data.map((b) => b.id);
      expect(bucketIds).to.include('store-logos');
      expect(bucketIds).to.include('backups');
      expect(bucketIds).to.include('attachments');
    });
  });

  it('✅ GET /storage/v1/list/attachments', () => {
    cy.request({
      method: 'GET',
      url: '/storage/v1/list/attachments',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.bucket).to.eq('attachments');
    });
  });

  it('✅ رفع ملف + تنزيل + حذف', () => {
    cy.fixture('test-upload.txt').then((fileContent) => {
      cy.window().then(async (win) => {
        const fileName = `test-upload-${Date.now()}.txt`;

        const formData = new FormData();
        const blob = new Blob([fileContent], { type: 'text/plain' });
        formData.append('file', blob, fileName);

        // ─── رفع ───
        const uploadRes = await win.fetch(
          'http://localhost:4000/storage/v1/object/attachments',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            body: formData,
          }
        );

        expect(uploadRes.status).to.eq(201);
        const uploadData = await uploadRes.json();
        expect(uploadData.ok).to.eq(true);

        const uploadedName = uploadData.data.name;
        expect(uploadedName).to.include('test-upload');

        // ─── تنزيل ───
        const downloadRes = await win.fetch(
          `http://localhost:4000/storage/v1/object/attachments/${uploadedName}`
        );
        expect(downloadRes.status).to.eq(200);
        const text = await downloadRes.text();
        expect(text).to.include('Hello');

        // ─── حذف ───
        const deleteRes = await win.fetch(
          `http://localhost:4000/storage/v1/object/attachments/${uploadedName}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        expect(deleteRes.status).to.eq(200);
      });
    });
  });

  it('❌ رفع بدون توكن — 401', () => {
    cy.fixture('test-upload.txt').then((fileContent) => {
      cy.window().then(async (win) => {
        const formData = new FormData();
        const blob = new Blob([fileContent], { type: 'text/plain' });
        formData.append('file', blob, 'no-auth.txt');

        const res = await win.fetch(
          'http://localhost:4000/storage/v1/object/attachments',
          { method: 'POST', body: formData }
        );
        expect(res.status).to.eq(401);
      });
    });
  });

  it('❌ تنزيل ملف غير موجود — 404', () => {
    cy.request({
      method: 'GET',
      url: '/storage/v1/object/attachments/nonexistent.txt',
      headers: { Authorization: `Bearer ${accessToken}` },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(404);
    });
  });
});