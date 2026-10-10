// test-api.js — اختبار تلقائي لـ stock + ledger
// ⚠️ للتطوير فقط — احذفه بعد الاختبار

const API = 'http://localhost:4000';

// ⚠️ عدّل هذه القيم ببيانات مستخدم حقيقي
const LOGIN_EMAIL = 'user@qemma.com';
const LOGIN_PASSWORD = 'Admin123';

let TOKEN = '';
let stats = { passed: 0, failed: 0, results: [] };

async function call(method, path, body = null) {
  const url = `${API}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  try {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}

function log(name, result, expected = 'ok:true') {
  const ok = result.data?.ok === true || result.status === 200 || result.status === 201;
  const icon = ok ? '✅' : '❌';
  stats[ok ? 'passed' : 'failed']++;
  stats.results.push({ name, ok, status: result.status });
  console.log(`${icon} ${name} [${result.status}]`);
  if (!ok) {
    console.log(`   ⚠️  ${JSON.stringify(result.data).slice(0, 200)}`);
  }
  return ok;
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('🧪 اختبار stock + ledger');
  console.log('═══════════════════════════════════════\n');

  // ═══ 1. Health ═══
  console.log('📋 1. Health Checks');
  log('GET /health', await call('GET', '/health'));
  log('GET /db-check', await call('GET', '/db-check'));

  // ═══ 2. Login ═══
  console.log('\n📋 2. تسجيل الدخول');
  const login = await call('POST', '/auth/v1/token?grant_type=password', {
    email: LOGIN_EMAIL,
    password: LOGIN_PASSWORD,
  });

  if (!login.data?.access_token) {
    console.log('❌ فشل تسجيل الدخول!');
    console.log('   استجابة:', JSON.stringify(login.data).slice(0, 300));
    console.log('\n⚠️  عدّل LOGIN_EMAIL و LOGIN_PASSWORD في الملف');
    process.exit(1);
  }
  TOKEN = login.data.access_token;
  console.log(`✅ Token: ${TOKEN.slice(0, 30)}...`);
  console.log(`   User: ${login.data.user?.email} | Role: ${login.data.user?.role}`);

  // ═══ 3. Stock — قراءة ═══
  console.log('\n📋 3. Stock — قراءة');
  log('GET /api/stock/rls/list', await call('GET', '/api/stock/rls/list'));
  log('GET /api/stock/rls/detailed', await call('GET', '/api/stock/rls/detailed'));
  log('GET /api/stock/rls/low-stock', await call('GET', '/api/stock/rls/low-stock'));
  log('GET /api/stock/rls/log', await call('GET', '/api/stock/rls/log?limit=5'));

  // ═══ 4. Stock — كتابة ═══
  console.log('\n📋 4. Stock — كتابة (verify-balance)');
  log('POST /api/stock/rls/verify-balance', await call('POST', '/api/stock/rls/verify-balance'));

  // ═══ 5. Ledger — قراءة ═══
  console.log('\n📋 5. Ledger — قراءة');
  log('GET /api/ledger/rls/list', await call('GET', '/api/ledger/rls/list?limit=5'));
  log('GET /api/ledger/rls/accounts', await call('GET', '/api/ledger/rls/accounts'));

  // ═══ 6. Ledger — recalc ═══
  console.log('\n📋 6. Ledger — صيانة');
  log('POST /api/ledger/rls/recalc-all', await call('POST', '/api/ledger/rls/recalc-all'));

  // ═══ 7. Auth guards ═══
  console.log('\n📋 7. حماية بدون Token');
  const savedToken = TOKEN;
  TOKEN = '';
  const noToken = await call('POST', '/api/stock/rls/adjust', { product_id: 'x' });
  const guarded = noToken.status === 401 || noToken.data?.error === 'Authentication required';
  console.log(`${guarded ? '✅' : '❌'} POST /stock/rls/adjust بدون Token → [${noToken.status}]`);
  stats[guarded ? 'passed' : 'failed']++;
  TOKEN = savedToken;

  // ═══ النتيجة ═══
  console.log('\n═══════════════════════════════════════');
  console.log(`📊 النتيجة: ${stats.passed} ✅ / ${stats.failed} ❌`);
  console.log('═══════════════════════════════════════\n');

  if (stats.failed > 0) {
    console.log('⚠️  الاختبارات الفاشلة:');
    stats.results.filter(r => !r.ok).forEach(r => {
      console.log(`   ❌ ${r.name} [${r.status}]`);
    });
  }
}

main().catch(console.error);