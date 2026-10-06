// ═══════════════════════════════════════════════
//  scripts/generate-token.js
//  توليد JWT للاختبار
// ═══════════════════════════════════════════════

require('dotenv').config();
const jwt = require('jsonwebtoken');

// ⚠️ نفس JWT_SECRET الذي سنستخدمه في server.js
const JWT_SECRET = process.env.JWT_SECRET || 'qemma-local-dev-secret';

// ⚠️ user_id من قاعدة البيانات
const USER_ID = process.argv[2] || '00000000-0000-0000-0000-000000000001';
const TENANT_ID = process.argv[3] || null;
const ORG_ID = process.argv[4] || null;

const token = jwt.sign(
  {
    sub: USER_ID,
    role: 'authenticated',
    tenant_id: TENANT_ID,
    organization_id: ORG_ID,
  },
  JWT_SECRET,
  { expiresIn: '1h' }
);

console.log('\n═══════════════════════════════════');
console.log('JWT Token (استخدمه في Authorization header):');
console.log('═══════════════════════════════════');
console.log(token);
console.log('\n═══════════════════════════════════');
console.log('مثال curl:');
console.log(`curl http://localhost:4000/api/products/rls -H "Authorization: Bearer ${token}"`);
console.log('═══════════════════════════════════\n');