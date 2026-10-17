// ═══════════════════════════════════════════════════════════
//  src/services/inventorySync.js
// ═══════════════════════════════════════════════════════════

async function recordMovement(client, params) {
  const {
    tenantId,
    organizationId = null,
    productId,
    productName = null,
    unitId,
    changeAmount,
    entryType,
    reason = null,
    referenceId = null,
    referenceNumber = null,
    unitCost = 0,
    createdBy = null,
    createdByName = null,
    date = new Date().toISOString().split('T')[0],
    allowNegative = false,
  } = params;

  // ═══ شبكة أمان: جلب unitName تلقائياً إن لم يُمرر ═══
  let unitName = params.unitName || null;
  if (!unitName && unitId) {
    const uRes = await client.query(
      `SELECT name FROM units WHERE id = $1`,
      [unitId]
    );
    unitName = uRes.rows[0]?.name || null;
  }

  // 1️⃣ احسب الرصيد الحقيقي من inventory_log (المصدر الوحيد)
  const balanceRes = await client.query(
    `SELECT COALESCE(SUM(change_amount), 0)::numeric AS balance
     FROM inventory_log
     WHERE tenant_id = $1
       AND product_id = $2
       AND unit_id = $3`,
    [tenantId, productId, unitId]
  );

  const previousQty = Number(balanceRes.rows[0]?.balance) || 0;
  const newQty = previousQty + Number(changeAmount);

  // 2️⃣ منع الرصيد السالب (لحركات البيع فقط)
  if (newQty < 0 && entryType === 'sale' && !allowNegative) {
    const err = new Error(
      `الكمية غير كافية للـ "${productName}" — المتوفر: ${previousQty}, المطلوب: ${Math.abs(changeAmount)}`
    );
    err.statusCode = 409;
    err.code = 'INSUFFICIENT_STOCK';
    err.details = {
      product_id: productId,
      product_name: productName,
      available: previousQty,
      requested: Math.abs(changeAmount),
    };
    throw err;
  }

  // 3️⃣ سجّل الحركة في inventory_log (المصدر الوحيد)
  await client.query(
    `INSERT INTO inventory_log
      (tenant_id, organization_id, product_id, product_name, unit_id, unit_name,
       change_amount, previous_qty, new_qty, entry_type, reason,
       reference_id, reference_number, unit_cost, total_value,
       created_by, created_by_name, date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      tenantId,
      organizationId,
      productId,
      productName,
      unitId,
      unitName,
      Number(changeAmount),
      previousQty,
      newQty,
      entryType,
      reason,
      referenceId,
      referenceNumber,
      Number(unitCost) || 0,
      Number(changeAmount) * (Number(unitCost) || 0),
      createdBy,
      createdByName,
      date,
    ]
  );

  // 4️⃣ Sync stock (cache)
  await client.query(
    `INSERT INTO stock
      (tenant_id, organization_id, product_id, unit_id, quantity, min_quantity)
     VALUES ($1, $2, $3, $4, $5, 0)
     ON CONFLICT (tenant_id, product_id, unit_id)
     DO UPDATE SET
       quantity = EXCLUDED.quantity,
       updated_at = NOW()`,
    [tenantId, organizationId, productId, unitId, newQty]
  );

  // 5️⃣ Sync product_units (cache)
  await client.query(
    `UPDATE product_units
     SET quantity = $1, updated_at = NOW()
     WHERE tenant_id = $2
       AND product_id = $3
       AND unit_id = $4`,
    [newQty, tenantId, productId, unitId]
  );

  return {
    previousQty,
    newQty,
    changeAmount: Number(changeAmount),
  };
}

module.exports = {
  recordMovement,
};