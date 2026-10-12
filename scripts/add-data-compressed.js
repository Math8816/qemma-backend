require('dotenv').config();
const pool = require('../src/db');

async function addColumn() {
  console.log('\n🔧 Adding data_compressed column...\n');

  try {
    // 1. Add column
    await pool.query(`
      ALTER TABLE backups
      ADD COLUMN IF NOT EXISTS data_compressed TEXT
    `);
    console.log('✅ Column added');

    // 2. Set default for existing rows
    await pool.query(`
      UPDATE backups 
      SET data_compressed = '{}'
      WHERE data_compressed IS NULL
    `);
    console.log('✅ Existing rows updated');

    // 3. Make NOT NULL
    await pool.query(`
      ALTER TABLE backups
      ALTER COLUMN data_compressed SET NOT NULL
    `);
    console.log('✅ Column set to NOT NULL');

    // 4. Verify
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'backups'
      ORDER BY ordinal_position
    `);

    console.log('\n📋 Updated columns:');
    rows.forEach((c) => {
      const marker = c.column_name === 'data_compressed' ? ' ⭐' : '';
      console.log(`   ${c.column_name.padEnd(25)} ${c.data_type.padEnd(30)} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}${marker}`);
    });

    console.log('\n✅ Done!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

addColumn();