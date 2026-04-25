// src/routes/guardian.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { generalRateLimit } = require('../middleware/rateLimiter');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const { sendPushNotification } = require('../services/notificationService');
const AppError = require('../utils/AppError');

const router = express.Router();
router.use(protect, generalRateLimit);

// ── POST /api/guardian/invite ───────────────────────────────
router.post(
  '/invite',
  [body('guardian_email').isEmail().normalizeEmail()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError('Valid guardian email required', 400));

      const { guardian_email, permissions = ['view_location'] } = req.body;

      // Find guardian user
      const guardianRes = await query('SELECT id, name, fcm_token FROM users WHERE email=$1', [guardian_email]);
      if (!guardianRes.rows[0]) return next(new AppError('No user found with this email.', 404));

      const guardian = guardianRes.rows[0];
      if (guardian.id === req.user.id) return next(new AppError('You cannot add yourself as a guardian.', 400));

      // Upsert relationship
      const result = await query(
        `INSERT INTO guardian_relationships (user_id, guardian_id, permissions, status, created_at)
         VALUES ($1,$2,$3,'pending',NOW())
         ON CONFLICT (user_id, guardian_id) DO UPDATE SET status='pending', permissions=$3
         RETURNING id`,
        [req.user.id, guardian.id, JSON.stringify(permissions)]
      );

      // Notify guardian
      if (guardian.fcm_token) {
        sendPushNotification({
          token: guardian.fcm_token,
          title: '🛡️ Guardian Invite',
          body: `${req.user.name} wants you to be their safety guardian on Rakhsha.`,
          data: { type: 'GUARDIAN_INVITE', from_user_id: req.user.id },
        }).catch(() => {});
      }

      res.status(201).json({ status: 'success', message: 'Guardian invitation sent', data: { relationship_id: result.rows[0].id } });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/guardian/respond ──────────────────────────────
router.post(
  '/respond',
  [
    body('relationship_id').isInt(),
    body('action').isIn(['accept', 'decline']),
  ],
  async (req, res, next) => {
    try {
      const { relationship_id, action } = req.body;
      const status = action === 'accept' ? 'active' : 'declined';

      const result = await query(
        `UPDATE guardian_relationships
         SET status=$1, responded_at=NOW()
         WHERE id=$2 AND guardian_id=$3
         RETURNING user_id`,
        [status, relationship_id, req.user.id]
      );

      if (!result.rows[0]) return next(new AppError('Relationship not found.', 404));

      res.status(200).json({ status: 'success', message: `Guardian request ${action}ed.` });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/guardian/my-guardians ─────────────────────────
router.get('/my-guardians', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT gr.id, gr.status, gr.permissions, gr.created_at,
              u.name AS guardian_name, u.email AS guardian_email
       FROM guardian_relationships gr
       JOIN users u ON u.id = gr.guardian_id
       WHERE gr.user_id=$1 ORDER BY gr.created_at DESC`,
      [req.user.id]
    );
    res.status(200).json({ status: 'success', data: { guardians: result.rows } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/guardian/i-am-guardian-for ─────────────────────
router.get('/i-am-guardian-for', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT gr.id, gr.status, gr.permissions,
              u.name, u.email,
              (SELECT ST_AsGeoJSON(location) FROM location_history
               WHERE user_id=gr.user_id ORDER BY recorded_at DESC LIMIT 1) AS last_location_geojson
       FROM guardian_relationships gr
       JOIN users u ON u.id = gr.user_id
       WHERE gr.guardian_id=$1 AND gr.status='active'`,
      [req.user.id]
    );

    const users = result.rows.map((r) => {
      const geo = r.last_location_geojson ? JSON.parse(r.last_location_geojson) : null;
      return {
        ...r,
        last_location: geo ? { lat: geo.coordinates[1], lng: geo.coordinates[0] } : null,
        last_location_geojson: undefined,
      };
    });

    res.status(200).json({ status: 'success', data: { users } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/guardian/:id ────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await query(
      `DELETE FROM guardian_relationships
       WHERE id=$1 AND (user_id=$2 OR guardian_id=$2)`,
      [req.params.id, req.user.id]
    );
    await cache.del(`guardians:${req.user.id}`);
    res.status(200).json({ status: 'success', message: 'Guardian relationship removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
