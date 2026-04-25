// src/routes/crime.js
const express = require('express');
const { param, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { generalRateLimit } = require('../middleware/rateLimiter');
const { getRiskScore } = require('../services/crimeService');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const AppError = require('../utils/AppError');

const router = express.Router();
router.use(protect, generalRateLimit);

// ── GET /api/crime/risk/:lat/:lng ───────────────────────────
router.get(
  '/risk/:lat/:lng',
  [
    param('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    param('lng').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { lat, lng } = req.params;
      const result = await getRiskScore(parseFloat(lat), parseFloat(lng));

      res.status(200).json({
        status: 'success',
        data: {
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          ...result,
          assessed_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/crime/hotspots — top 20 high-risk clusters ─────
router.get('/hotspots', async (req, res, next) => {
  try {
    const cacheKey = 'crime:hotspots';
    const cached = await cache.get(cacheKey);
    if (cached) return res.status(200).json({ status: 'success', data: cached });

    const result = await query(`
      SELECT
        ST_X(ST_Centroid(ST_Collect(location::geometry))) AS lng,
        ST_Y(ST_Centroid(ST_Collect(location::geometry))) AS lat,
        COUNT(*) AS incident_count,
        AVG(severity) AS avg_severity,
        ARRAY_AGG(DISTINCT crime_type) AS crime_types,
        MAX(timestamp) AS latest_incident
      FROM crime_history
      WHERE timestamp > NOW() - INTERVAL '6 months'
      GROUP BY ST_SnapToGrid(location::geometry, 0.005)
      HAVING COUNT(*) >= 3
      ORDER BY incident_count DESC LIMIT 20
    `);

    const hotspots = result.rows.map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
      incident_count: parseInt(r.incident_count),
      avg_severity: parseFloat(r.avg_severity).toFixed(1),
      crime_types: r.crime_types,
      latest_incident: r.latest_incident,
    }));

    await cache.set(cacheKey, hotspots, 1800); // 30 min
    res.status(200).json({ status: 'success', data: { hotspots } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/crime/trends — time-based patterns ─────────────
router.get('/trends', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        EXTRACT(HOUR FROM timestamp) AS hour,
        EXTRACT(DOW FROM timestamp) AS day_of_week,
        crime_type,
        COUNT(*) AS count,
        AVG(severity) AS avg_severity
      FROM crime_history
      WHERE timestamp > NOW() - INTERVAL '1 year'
      GROUP BY hour, day_of_week, crime_type
      ORDER BY count DESC
    `);

    res.status(200).json({ status: 'success', data: { trends: result.rows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
