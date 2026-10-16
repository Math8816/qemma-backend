// ═══════════════════════════════════════════════════════════
//  src/services/inventorySync.js
//  🎯 المصدر الوحيد للحقيقة: inventory_log
//  ✅ كل حركة مخزون تمر من هنا
//  ✅ stock + product_units يُزامنان تلقائياً
// ═══════════════════════════════════════════════════════════

/**
 * 🎯 تسجيل حركة مخزون + مزامنة stock + product_units
 *
 * @param {object} client - DB client (داخل transaction)
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.organizationId
 * @param {string} params.productId
 * @param {string} params.productName
 * @param {string} params.unitId
 * @param {number} params.changeAmount - موجب = إضافة، سالب = خصم
 * @param {string} params.entryType - sale | purchase | return | adjustment | void_sale
 * @param {string} params.reason
 * @param {string} [params.referenceId]
 * @param {string} [params.referenceNumber]
 * @param {number} [params.unitCost=0]
 * @param {string} [params.createdBy]
 * @param {string} [params.createdByName]
 * @param {string} [params.date]
 * @param {boolean} [params.allowNegative=false] - للسماح بالسالب (غير مستخدم حالياً)
 *
 * @returns {Promise<{ previousQty: number, newQty: number, changeAmount: number }>}
 */
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

  // ═══════════════════════════════════════════════════════════
  //  1️⃣ احسب الرصيد الحقيقي من inventory_log (المصدر الوحيد)
  // ═══════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════
  //  2️⃣ منع الرصيد السالب (لحركات البيع فقط)
  // ═══════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════
  //  3️⃣ سجّل الحركة في inventory_log (المصدر الوحيد)
  // ═══════════════════════════════════════════════════════════
  await client.query(
    `INSERT INTO inventory_log
      (tenant_id, organization_id, product_id, product_name, unit_id,
       change_amount, previous_qty, new_qty, entry_type, reason,
       reference_id, reference_number, unit_cost, total_value,
       created_by, created_by_name, date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      tenantId,
      organizationId,
      productId,
      productName,
      unitId,
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

  // ═══════════════════════════════════════════════════════════
  //  4️⃣ Sync stock (cache) — INSERT ... ON CONFLICT
  // ═══════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════
  //  5️⃣ Sync product_units (cache)
  // ═══════════════════════════════════════════════════════════
  await client.query(
    `UPDATE product_units
     SET quantity = $1, updated_at = NOW()
     WHERE tenant_id = $2
       AND product_id = $3
       AND unit_id = $4`,
    [newQty, tenantId, productId, unitId]
  );

  // ═══════════════════════════════════════════════════════════
  //  ✅ إرجاع الملخص
  // ═══════════════════════════════════════════════════════════
  return {
    previousQty,
    newQty,
    changeAmount: Number(changeAmount),
  };
}

// ═══════════════════════════════════════════════════════════
//  📤 التصدير
// ═══════════════════════════════════════════════════════════
module.exports = {
  recordMovement,
};