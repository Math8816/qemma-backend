// ═══════════════════════════════════════════════
//  src/middleware/validation.js
//  Input Validation باستخدام Joi
// ═══════════════════════════════════════════════

const Joi = require('joi');

// ─── Schemas ───

const signupSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required().max(255).lowercase().trim(),
  password: Joi.string().min(6).max(128).required(),
  full_name: Joi.string().max(255).optional().allow(null, ''),
  invite_token: Joi.string().max(255).optional().allow(null, ''),
  role: Joi.string().valid('developer', 'owner', 'org_admin', 'store_admin', 'employee').optional(),
  tenant_id: Joi.string().uuid().optional().allow(null),
  organization_id: Joi.string().uuid().optional().allow(null),
});

const loginSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required().max(255).lowercase().trim(),
  password: Joi.string().min(1).max(128).required(),
});

const recoverSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required().max(255).lowercase().trim(),
});

const verifySchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required().max(255).lowercase().trim(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const updatePasswordSchema = Joi.object({
  password: Joi.string().min(6).max(128).required(),
});

const createUserSchema = Joi.object({
  id: Joi.string().uuid().required(),
  email: Joi.string().email({ tlds: { allow: false } }).required().max(255).lowercase().trim(),
  full_name: Joi.string().max(255).optional().allow(null, ''),
  role: Joi.string().valid('developer', 'owner', 'org_admin', 'store_admin', 'employee').required(),
  password: Joi.string().min(6).max(128).optional().allow(null, ''),
  tenant_id: Joi.string().uuid().optional().allow(null),
  organization_id: Joi.string().uuid().optional().allow(null),
  is_active: Joi.boolean().optional(),
});

const updateUserSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required().max(255).lowercase().trim(),
  full_name: Joi.string().max(255).optional().allow(null, ''),
  role: Joi.string().valid('developer', 'owner', 'org_admin', 'store_admin', 'employee').optional(),
  password: Joi.string().min(6).max(128).optional().allow(null, ''),
  is_active: Joi.boolean().optional(),
}).min(1); // يجب أن يحتوي على حقل واحد على الأقل

// ─── Middleware ───
function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));

      return res.status(400).json({
        error: 'validation_error',
        error_description: 'Invalid input',
        details,
      });
    }

    req.body = value; // البيانات النظيفة
    next();
  };
}

module.exports = {
  validate,
  signupSchema,
  loginSchema,
  recoverSchema,
  verifySchema,
  updatePasswordSchema,
  createUserSchema,
  updateUserSchema,
};