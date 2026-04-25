// src/routes/sos.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { sosRateLimit } = require('../middleware/rateLimiter');
const { upload, uploadToCloudinary } = require('../config/upload');
const { query } = require('../config/database');
const { sendSOSBlast } = require('../services/notificationService');
const { decrypt } = require('../utils/encryption');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(protect);

// ── POST /api/sos/trigger ───────────────────────────────────
router.post(
  '/trigger',
  sosRateLimit,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'image_front', maxCount: 1 }, { name: 'image_back', maxCount: 1 }]),
  [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { lat, lng, message } = req.body;
      const user = req.user;

      if (!user.emergency_contacts?.length) {
        return next(new AppError('No emergency contacts configured. Please add contacts first.', 400));
      }

      // Upload media concurrently
      const mediaUploads = await Promise.allSettled([
        req.files?.audio?.[0]
          ? uploadToCloudinary(req.files.audio[0].buffer, 'sos/audio', { resource_type: 'video' })
          : Promise.resolve(null),
        req.files?.image_front?.[0]
          ? uploadToCloudinary(req.files.image_front[0].buffer, 'sos/images')
          : Promise.resolve(null),
        req.files?.image_back?.[0]
          ? uploadToCloudinary(req.files.image_back[0].buffer, 'sos/images')
          : Promise.resolve(null),
      ]);

      const [audioResult, imageFrontResult, imageBackResult] = mediaUploads.map((r) =>
        r.status === 'fulfilled' ? r.value : null
      );

      const audioUrl = audioResult?.secure_url || null;
      const imageUrl = imageFrontResult?.secure_url || imageBackResult?.secure_url || null;

      // Store SOS event in DB
      const sosRecord = await query(
        `INSERT INTO sos_events (user_id, location, audio_url, image_url, message, status, created_at)
         VALUES ($1, ST_SetSRID(ST_MakePoint($3,$2),4326), $4, $5, $6, 'active', NOW())
         RETURNING id, created_at`,
        [user.id, lat, lng, audioUrl, imageUrl, message || null]
      );

      const sosId = sosRecord.rows[0].id;

      // Decrypt phone numbers for SMS
      const contacts = (user.emergency_contacts || []).map((c) => ({
        ...c,
        phone: c.phone?.startsWith('+') ? c.phone : decrypt(c.phone),
      }));

      // Send SOS blast (non-blocking)
      sendSOSBlast({
        user: { id: user.id, name: user.name },
        location: { lat: parseFloat(lat), lng: parseFloat(lng) },
        audioUrl,
        imageUrl,
        contacts,
      }).catch((err) => logger.error('SOS blast error', { sosId, error: err.message }));

      // Emit real-time alert via Socket.io (handled in websocket manager)
      req.app.get('io')?.to(`user:${user.id}`).emit('sos-confirmed', {
        sosId,
        message: 'SOS triggered. Alerting emergency contacts.',
        contacts_alerted: contacts.length,
      });

      logger.info('SOS triggered', { userId: user.id, sosId, lat, lng });

      res.status(200).json({
        status: 'success',
        message: 'SOS triggered. Emergency contacts are being alerted.',
        data: {
          sos_id: sosId,
          contacts_alerted: contacts.length,
          triggered_at: sosRecord.rows[0].created_at,
          audio_captured: !!audioUrl,
          image_captured: !!imageUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/sos/cancel ────────────────────────────────────
router.post('/cancel', async (req, res, next) => {
  try {
    const { sos_id } = req.body;
    await query(
      `UPDATE sos_events SET status='cancelled', resolved_at=NOW() WHERE id=$1 AND user_id=$2`,
      [sos_id, req.user.id]
    );
    res.status(200).json({ status: 'success', message: 'SOS cancelled' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sos/fake-call ─────────────────────────────────
router.post('/fake-call', async (req, res, next) => {
  try {
    // Return a random fake caller from DB
    const result = await query(
      `SELECT caller_name, caller_number, ringtone_url, caller_image_url, call_script
       FROM fake_callers ORDER BY RANDOM() LIMIT 1`
    );

    // Fallback if DB is empty
    const fakeCallers = [
      { caller_name: 'Mom', caller_number: '+91 98765 00001', ringtone_url: null, caller_image_url: null, call_script: 'I am on my way, where are you?' },
      { caller_name: 'Priya (Sister)', caller_number: '+91 98765 00002', ringtone_url: null, caller_image_url: null, call_script: 'Please pick up. I need you home now.' },
      { caller_name: 'Office - HR', caller_number: '+91 11 4567 0000', ringtone_url: null, caller_image_url: null, call_script: 'This is a reminder about tomorrow\'s meeting.' },
    ];

    const caller = result.rows[0] || fakeCallers[Math.floor(Math.random() * fakeCallers.length)];
    const delay = req.body.delay_seconds || 3;

    res.status(200).json({
      status: 'success',
      data: {
        ...caller,
        delay_seconds: delay,
        duration_seconds: req.body.duration_seconds || 60,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/sos/history ────────────────────────────────────
router.get('/history', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, status, audio_url, image_url, message, created_at, resolved_at,
              ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
       FROM sos_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.status(200).json({ status: 'success', data: { events: result.rows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
