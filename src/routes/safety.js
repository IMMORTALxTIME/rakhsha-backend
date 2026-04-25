// src/routes/safety.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { generalRateLimit } = require('../middleware/rateLimiter');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(protect, generalRateLimit);

// ── POST /api/health-mode/activate ─────────────────────────
// Backend continues tracking — only the UI changes (weather/news disguise)
router.post('/health-mode/activate', async (req, res, next) => {
  try {
    const { active } = req.body;
    const userId = req.user.id;

    // Store state in cache (fast access) + DB (persistence)
    await cache.set(`health_mode:${userId}`, { active: !!active, since: new Date().toISOString() }, 86400);
    await query(
      `INSERT INTO user_states (user_id, state_key, state_value, updated_at)
       VALUES ($1,'health_mode',$2,NOW())
       ON CONFLICT (user_id, state_key) DO UPDATE SET state_value=$2, updated_at=NOW()`,
      [userId, JSON.stringify({ active: !!active })]
    );

    logger.info('Health mode toggled', { userId, active });
    res.status(200).json({
      status: 'success',
      message: active ? 'Health mode activated. Tracking continues normally.' : 'Health mode deactivated.',
      data: { active: !!active },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/health-mode/status ─────────────────────────────
router.get('/health-mode/status', async (req, res, next) => {
  try {
    const state = await cache.get(`health_mode:${req.user.id}`);
    res.status(200).json({ status: 'success', data: state || { active: false } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/checkin ───────────────────────────────────────
router.post(
  '/checkin',
  [
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
    body('note').optional().trim().isLength({ max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return next(new AppError(errors.array()[0].msg, 400));

      const { lat, lng, note, battery_level } = req.body;
      const userId = req.user.id;

      const result = await query(
        `INSERT INTO checkins (user_id, location, note, battery_level, created_at)
         VALUES ($1, ST_SetSRID(ST_MakePoint($3,$2),4326), $4, $5, NOW())
         RETURNING id, note, battery_level, created_at`,
        [userId, lat, lng, note || null, battery_level || null]
      );

      // Update active session in cache
      await cache.set(`checkin:${userId}:last`, {
        lat, lng, note, timestamp: new Date().toISOString(),
      }, 3600);

      // Reset check-in timer (2 min no-stop alert)
      await cache.set(`checkin:${userId}:timer`, Date.now(), parseInt(process.env.STOP_ALERT_MINUTES) * 60 || 120);

      res.status(201).json({
        status: 'success',
        message: 'Check-in recorded',
        data: { checkin: result.rows[0] },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/checkin/history ────────────────────────────────
router.get('/checkin/history', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, note, battery_level,
              ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat,
              created_at
       FROM checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.status(200).json({ status: 'success', data: { checkins: result.rows } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/watch/sync ────────────────────────────────────
router.post('/watch/sync', async (req, res, next) => {
  try {
    const { route, alerts, device_type } = req.body; // device_type: 'wear_os' | 'apple_watch'
    const userId = req.user.id;

    // Store watch sync data in cache for WebSocket pickup
    const syncData = {
      route: route || null,
      alerts: alerts || [],
      device_type: device_type || 'unknown',
      synced_at: new Date().toISOString(),
    };

    await cache.set(`watch:${userId}:sync`, syncData, 1800);

    // Emit to wearable socket room if connected
    req.app.get('io')?.to(`watch:${userId}`).emit('watch-sync', syncData);

    res.status(200).json({
      status: 'success',
      message: 'Watch synced successfully',
      data: {
        haptic_pattern: computeHapticPattern(syncData),
        route_preview: route ? summarizeRoute(route) : null,
        pending_alerts: alerts?.length || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/watch/status ───────────────────────────────────
router.get('/watch/status', async (req, res, next) => {
  try {
    const syncData = await cache.get(`watch:${req.user.id}:sync`);
    res.status(200).json({ status: 'success', data: syncData || { connected: false } });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ────────────────────────────────────────────────
const computeHapticPattern = (syncData) => {
  const alerts = syncData.alerts || [];
  const hasHighPriority = alerts.some((a) => a.priority === 'high');
  return hasHighPriority ? 'sos_pulse' : 'gentle_nudge';
};

const summarizeRoute = (route) => {
  if (!route) return null;
  return {
    total_steps: route.steps?.length || 0,
    distance: route.distance?.text || 'Unknown',
    duration: route.duration?.text || 'Unknown',
    next_turn: route.steps?.[0]?.html_instructions?.replace(/<[^>]*>/g, '') || null,
  };
};

module.exports = router;
