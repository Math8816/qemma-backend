const { authenticator } = require('otplib');
authenticator.options = { window: 1, step: 30, digits: 6 };
const secret = process.argv[2];
if (!secret) { console.error('Usage: node gen-totp.js <SECRET>'); process.exit(1); }
const code = authenticator.generate(secret);
console.log(code);
