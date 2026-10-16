// src/db-config.js
const { types } = require('pg');

// ═══════════════════════════════════════════════════════════
//  🔢 Type Parsers — تحويل NUMERIC/BIGINT إلى Number
// ═══════════════════════════════════════════════════════════
types.setTypeParser(20,   (v) => v === null ? null : parseInt(v, 10));    // BIGINT / INT8
types.setTypeParser(21,   (v) => v === null ? null : parseInt(v, 10));    // SMALLINT / INT2
types.setTypeParser(23,   (v) => v === null ? null : parseInt(v, 10));    // INTEGER / INT4
types.setTypeParser(700,  (v) => v === null ? null : parseFloat(v));      // FLOAT4 / REAL
types.setTypeParser(701,  (v) => v === null ? null : parseFloat(v));      // FLOAT8 / DOUBLE
types.setTypeParser(1700, (v) => v === null ? null : parseFloat(v));      // NUMERIC / DECIMAL

// ═══════════════════════════════════════════════════════════
//  📅 Date/Time — الإبقاء كما هي (string ISO)
// ═══════════════════════════════════════════════════════════
// (لا تعديل — الافتراضي جيد)

console.log('✅ pg type parsers configured');