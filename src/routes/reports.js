// src/routes/reports.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { generalRateLimit } = require('../middleware/rateLimiter');
const { upload, uploadToCloudinary } = require('../config/upload');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(protect, generalRateLimit);

const VALID_TYPES = ['harassment', 'theft', 'assault', 'suspicious_activity', 'unsafe_area', 'other'];

// ── POST /api/report ────────────────────────────────────────
router.post(
  '/',
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]),
  [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
    body('type').isIn(VALID_TYPES).withMessage(`Type must be one of: ${VALID_TYPES.join(', ')}`),
    body('description').optional().trim().isLength({ max: 1000 }),
    body('severity').optional().isInt({ min: 1, max: 5 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { lat, lng, type, description, severity = 3 } = req.body;

      // Upload media concurrently
      const uploads = {};
      if (req.files?.image?.[0]) {
        const result = await uploadToCloudinary(req.files.image[0].buffer, 'reports/images');
        uploads.image_url = result.secure_url;
        uploads.image_public_id = result.public_id;
      }
      if (req.files?.audio?.[0]) {
        const result = await uploadToCloudinary(req.files.audio[0].buffer, 'reports/audio', { resource_type: 'video' });
        uploads.audio_url = result.secure_url;
        uploads.audio_public_id = result.public_id;
      }

      const result = await query(
        `INSERT INTO reports (user_id, location, type, description, severity, image_url, audio_url, created_at)
         VALUES ($1, ST_SetSRID(ST_MakePoint($3,$2),4326), $4, $5, $6, $7, $8, NOW())
         RETURNING id, type, description, severity, created_at`,
        [req.user.id, lat, lng, type, description || null, severity, uploads.image_url || null, uploads.audio_url || null]
      );

      // Invalidate heatmap cache
      await cache.del('report:heatmap');

      logger.info('Report submitted', { userId: req.user.id, type, lat, lng });
      res.status(201).json({
        status: 'success',
        message: 'Report submitted. Thank you for keeping the community safe.',
        data: { report: result.rows[0] },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/report/heatmap ─────────────────────────────────
router.get('/heatmap', async (req, res, next) => {
  try {
    const cached = await cache.get('report:heatmap');
    if (cached) return res.status(200).json({ status: 'success', data: cached });

    const result = await query(`
      SELECT
        ST_X(location::geometry) AS lng,
        ST_Y(location::geometry) AS lat,
        type,
        COUNT(*) AS count,
        AVG(severity) AS avg_severity,
        MAX(created_at) AS latest
      FROM reports
      WHERE created_at > NOW() - INTERVAL '90 days'
      GROUP BY ST_SnapToGrid(location::geometry, 0.001), type
      ORDER BY count DESC LIMIT 500
    `);

    const points = result.rows.map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
      type: r.type,
      count: parseInt(r.count),
      weight: Math.min(1, parseInt(r.count) / 10), // 0-1 for heatmap intensity
      avg_severity: parseFloat(r.avg_severity),
      latest: r.latest,
    }));

    const data = { points, generated_at: new Date().toISOString() };
    await cache.set('report:heatmap', data, 1800);
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/report/nearby ──────────────────────────────────
router.get('/nearby', async (req, res, next) => {
  try {
    const { lat, lng, radius = 500 } = req.query;
    if (!lat || !lng) return next(new AppError('lat and lng required', 400));

    const result = await query(
      `SELECT id, type, description, severity,
              ST_X(location::geometry) AS lng,
              ST_Y(location::geometry) AS lat,
              ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS distance_meters,
              created_at
       FROM reports
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
       AND created_at > NOW() - INTERVAL '30 days'
       ORDER BY created_at DESC LIMIT 50`,
      [parseFloat(lat), parseFloat(lng), parseFloat(radius)]
    );

    res.status(200).json({ status: 'success', results: result.rows.length, data: { reports: result.rows } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/report/my ──────────────────────────────────────
router.get('/my', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, type, description, severity, image_url, audio_url,
              ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat, created_at
       FROM reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.status(200).json({ status: 'success', data: { reports: result.rows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
