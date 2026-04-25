// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../config/database');
const { cache } = require('../config/redis');
const { protect } = require('../middleware/auth');
const { authRateLimit } = require('../middleware/rateLimiter');
const { encrypt, decrypt } = require('../utils/encryption');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });

const sendAuthResponse = (res, statusCode, user, message = 'Success') => {
  const token = signToken(user.id);
  const refreshToken = signRefreshToken(user.id);
  const { password_hash, ...safeUser } = user;
  if (safeUser.phone) safeUser.phone = decrypt(safeUser.phone);
  res.status(statusCode).json({ status: 'success', message, token, refreshToken, data: { user: safeUser } });
};

// ── POST /api/auth/register ─────────────────────────────────
router.post(
  '/register',
  authRateLimit,
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('phone').matches(/^\+?[1-9]\d{7,14}$/).withMessage('Valid phone number required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { name, email, phone, password, fcm_token } = req.body;

      const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows[0]) return next(new AppError('Email already registered.', 409));

      const password_hash = await bcrypt.hash(password, 12);
      const encryptedPhone = encrypt(phone);
      const id = uuidv4();

      const result = await query(
        `INSERT INTO users (id, name, email, phone, password_hash, fcm_token, role, is_active, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'user',true,NOW()) RETURNING *`,
        [id, name, email, encryptedPhone, password_hash, fcm_token || null]
      );

      logger.info('New user registered', { userId: id, email });
      sendAuthResponse(res, 201, result.rows[0], 'Registration successful');
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ────────────────────────────────────
router.post(
  '/login',
  authRateLimit,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError('Invalid credentials.', 401));

      const { email, password, fcm_token } = req.body;

      const result = await query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return next(new AppError('Incorrect email or password.', 401));
      }

      // Update FCM token and last_login
      if (fcm_token) {
        await query('UPDATE users SET fcm_token=$1, last_login=NOW() WHERE id=$2', [fcm_token, user.id]);
      } else {
        await query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
      }

      await cache.del(`user:${user.id}`); // Invalidate cache
      logger.info('User logged in', { userId: user.id });
      sendAuthResponse(res, 200, user, 'Login successful');
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/logout ───────────────────────────────────
router.post('/logout', protect, async (req, res, next) => {
  try {
    const decoded = jwt.decode(req.token);
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await cache.set(`blacklist:${req.token}`, 1, ttl);
    await cache.del(`user:${req.user.id}`);
    res.status(200).json({ status: 'success', message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ──────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return next(new AppError('Refresh token required.', 400));

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const result = await query('SELECT id, email FROM users WHERE id=$1 AND is_active=true', [decoded.id]);
    if (!result.rows[0]) return next(new AppError('User not found.', 401));

    const newToken = signToken(decoded.id);
    res.status(200).json({ status: 'success', token: newToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(new AppError('Invalid or expired refresh token.', 401));
    }
    next(err);
  }
});

// ── POST /api/auth/emergency-contacts ──────────────────────
router.post(
  '/emergency-contacts',
  protect,
  [
    body('contacts').isArray({ min: 1, max: 5 }).withMessage('1-5 contacts required'),
    body('contacts.*.name').trim().notEmpty(),
    body('contacts.*.phone').matches(/^\+?[1-9]\d{7,14}$/),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { contacts } = req.body;
      const sanitized = contacts.map((c) => ({
        name: c.name,
        phone: c.phone,
        email: c.email || null,
        relation: c.relation || 'contact',
      }));

      await query('UPDATE users SET emergency_contacts=$1 WHERE id=$2', [
        JSON.stringify(sanitized),
        req.user.id,
      ]);
      await cache.del(`user:${req.user.id}`);

      res.status(200).json({
        status: 'success',
        message: 'Emergency contacts updated',
        data: { contacts: sanitized },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/auth/me ────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  const { password_hash, ...user } = req.user;
  if (user.phone) user.phone = decrypt(user.phone);
  res.status(200).json({ status: 'success', data: { user } });
});

// ── PATCH /api/auth/update-profile ─────────────────────────
router.patch('/update-profile', protect, async (req, res, next) => {
  try {
    const { name, fcm_token } = req.body;
    await query('UPDATE users SET name=COALESCE($1,name), fcm_token=COALESCE($2,fcm_token) WHERE id=$3',
      [name, fcm_token, req.user.id]);
    await cache.del(`user:${req.user.id}`);
    res.status(200).json({ status: 'success', message: 'Profile updated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
