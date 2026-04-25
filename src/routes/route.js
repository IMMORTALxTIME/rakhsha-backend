// src/routes/route.js
const express = require('express');
const { body, query: qv, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { generalRateLimit } = require('../middleware/rateLimiter');
const { getShortestRoute, getLitStreetRoute, getSafeRefuges, getReroute } = require('../services/routingService');
const { query } = require('../config/database');
const { coordsToLineString } = require('../utils/geoUtils');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(protect, generalRateLimit);

const coordsValidation = [
  body('origin.lat').isFloat({ min: -90, max: 90 }).withMessage('Valid origin latitude required'),
  body('origin.lng').isFloat({ min: -180, max: 180 }).withMessage('Valid origin longitude required'),
  body('destination.lat').isFloat({ min: -90, max: 90 }).withMessage('Valid destination latitude required'),
  body('destination.lng').isFloat({ min: -180, max: 180 }).withMessage('Valid destination longitude required'),
];

// ── POST /api/route/shortest ────────────────────────────────
router.post('/shortest', coordsValidation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { origin, destination } = req.body;
    const result = await getShortestRoute(origin, destination);

    // Save route to DB
    if (result.route?.waypoints?.length) {
      const coords = result.route.waypoints.map(({ lat, lng }) => [lng, lat]);
      const wkt = `LINESTRING(${coords.map(([lng, lat]) => `${lng} ${lat}`).join(', ')})`;
      await query(
        `INSERT INTO routes (user_id, path, risk_score, route_type, created_at)
         VALUES ($1, ST_GeomFromText($2,4326), $3, 'shortest', NOW())`,
        [req.user.id, wkt, result.route.risk?.average_risk || 0]
      ).catch((e) => logger.warn('Route save failed', { error: e.message }));
    }

    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/route/lit-street ──────────────────────────────
router.post('/lit-street', coordsValidation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

    const { origin, destination } = req.body;
    const result = await getLitStreetRoute(origin, destination);
    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/route/safe-refuges ────────────────────────────
router.post(
  '/safe-refuges',
  [
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
    body('radius').optional().isInt({ min: 100, max: 5000 }),
    body('types').optional().isArray(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { lat, lng, radius = 1000, types } = req.body;
      const refuges = await getSafeRefuges(lat, lng, radius, types);
      res.status(200).json({ status: 'success', results: refuges.length, data: { refuges } });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/route/reroute ─────────────────────────────────
router.post(
  '/reroute',
  [
    body('current_lat').isFloat({ min: -90, max: 90 }),
    body('current_lng').isFloat({ min: -180, max: 180 }),
    body('destination.lat').isFloat({ min: -90, max: 90 }),
    body('destination.lng').isFloat({ min: -180, max: 180 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { current_lat, current_lng, destination } = req.body;
      const result = await getReroute(current_lat, current_lng, destination);
      res.status(200).json({ status: 'success', data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/route/history ──────────────────────────────────
router.get('/history', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, route_type, risk_score, created_at,
              ST_AsGeoJSON(path) as geojson
       FROM routes WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.status(200).json({ status: 'success', data: { routes: result.rows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
