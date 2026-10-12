# ═══════════════════════════════════════════════════════════
#  Test 2FA System
# ═══════════════════════════════════════════════════════════

$ErrorActionPreference = 'Continue'

Write-Host "`n=== 1. Health Check ===" -ForegroundColor Cyan
curl.exe -s http://localhost:4000/health
Write-Host "`n"

Write-Host "=== 2. Login Test ===" -ForegroundColor Cyan
'{"email":"developer@qemma.com","password":"Admin123"}' | Out-File -Encoding utf8 login.json

$response = curl.exe -s -X POST "http://localhost:4000/auth/v1/token?grant_type=password" -H "Content-Type: application/json" -d "@login.json"
Write-Host $response
Write-Host "`n"

Write-Host "=== 3. Check User ===" -ForegroundColor Cyan
node -e "require('dotenv').config(); const p=require('./src/db'); p.query('SELECT id, email, role, is_active FROM users WHERE email=$1',['developer@qemma.com']).then(r=>{console.log(JSON.stringify(r.rows,null,2)); process.exit(0)}).catch(e=>{console.error(e.message); process.exit(1)})"
Write-Host ""

Write-Host "=== 4. Check 2FA ===" -ForegroundColor Cyan
node -e "require('dotenv').config(); const p=require('./src/db'); p.query('SELECT u.email, tfa.enabled FROM users u LEFT JOIN two_factor_auth tfa ON tfa.user_id=u.id').then(r=>{console.log(JSON.stringify(r.rows,null,2)); process.exit(0)}).catch(e=>{console.error(e.message); process.exit(1)})"
Write-Host ""

Write-Host "=== DONE ===" -ForegroundColor Green