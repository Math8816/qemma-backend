require('dotenv').config();
const pool = require('../src/db');

async function check() {
  try {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'backups'
      ORDER BY ordinal_position
    `);

    console.log('\n📋 Columns in "backups":\n');
    if (rows.length === 0) {
      console.log('   ⚠️  Table does not exist!\n');
    } else {
      rows.forEach((c) => {
        console.log(`   ${c.column_name.padEnd(25)} ${c.data_type.padEnd(30)} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
      });
      console.log(`\n   Total: ${rows.length} columns\n`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

check();