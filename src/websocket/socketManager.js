// src/websocket/socketManager.js
const { authenticateSocket } = require('../middleware/auth');
const { cache } = require('../config/redis');
const { query } = require('../config/database');
const { haversineDistance, isDeviatedFromRoute } = require('../utils/geoUtils');
const { sendSOSBlast } = require('../services/notificationService');
const { logger } = require('../utils/logger');

const DEVIATION_THRESHOLD = parseInt(process.env.DEVIATION_THRESHOLD_METERS) || 50;
const STOP_ALERT_MS = (parseInt(process.env.STOP_ALERT_MINUTES) || 2) * 60 * 1000;

const initSocketManager = (io) => {
  // Middleware: authenticate all socket connections
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const userId = socket.userId;
    logger.info('Socket connected', { userId, socketId: socket.id });

    // Join user's personal room
    socket.join(`user:${userId}`);

    // ── LOCATION UPDATE ────────────────────────────────────
    socket.on('location-update', async (data) => {
      try {
        const { lat, lng, accuracy, heading, speed, route_id } = data;

        if (typeof lat !== 'number' || typeof lng !== 'number') return;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

        const now = Date.now();
        const locationData = { lat, lng, accuracy, heading, speed, timestamp: now, userId };

        // Store current location in cache
        const prevLocation = await cache.get(`location:${userId}`);
        await cache.set(`location:${userId}`, locationData, 300);

        // Persist to DB (location_history table)
        await query(
          `INSERT INTO location_history (user_id, location, accuracy, heading, speed, recorded_at)
           VALUES ($1, ST_SetSRID(ST_MakePoint($3,$2),4326), $4, $5, $6, NOW())`,
          [userId, lat, lng, accuracy || null, heading || null, speed || null]
        ).catch(() => {}); // Non-blocking, best-effort

        // ── Deviation Detection ──
        if (route_id) {
          const routeData = await cache.get(`route:${route_id}`);
          if (routeData?.waypoints) {
            const deviated = isDeviatedFromRoute(lat, lng, routeData.waypoints, DEVIATION_THRESHOLD);
            if (deviated) {
              socket.emit('safety-alert', {
                type: 'ROUTE_DEVIATION',
                message: `You have deviated ${DEVIATION_THRESHOLD}m+ from your planned route.`,
                lat, lng,
                timestamp: new Date().toISOString(),
                action: 'REROUTE_SUGGESTED',
              });
              logger.info('Route deviation detected', { userId, lat, lng });
            }
          }
        }

        // ── Stop Detection (no movement >2 min) ──
        if (prevLocation) {
          const dist = haversineDistance(prevLocation.lat, prevLocation.lng, lat, lng);
          const timeDiff = now - prevLocation.timestamp;

          if (dist < 10 && timeDiff >= STOP_ALERT_MS) {
            const stopKey = `stop_alerted:${userId}`;
            const alreadyAlerted = await cache.exists(stopKey);
            if (!alreadyAlerted) {
              socket.emit('safety-alert', {
                type: 'STOPPED_MOVING',
                message: `You have not moved for ${process.env.STOP_ALERT_MINUTES || 2} minutes. Are you safe?`,
                lat, lng,
                timestamp: new Date().toISOString(),
                action: 'CHECK_IN_REQUIRED',
              });
              await cache.set(stopKey, 1, 300); // Don't re-alert for 5 min
            }
          }
        }

        // ── Broadcast to guardians ──
        const guardians = await cache.get(`guardians:${userId}`);
        if (guardians?.length) {
          for (const guardianId of guardians) {
            io.to(`guardian:${guardianId}`).emit('user-location', {
              userId,
              lat, lng,
              accuracy,
              timestamp: now,
            });
          }
        }

        socket.emit('location-acknowledged', { timestamp: now });
      } catch (err) {
        logger.error('location-update handler error', { userId, error: err.message });
      }
    });

    // ── GUARDIAN TRACKING ──────────────────────────────────
    socket.on('watch-user', async ({ targetUserId }) => {
      try {
        // Verify guardian relationship
        const rel = await query(
          `SELECT id FROM guardian_relationships WHERE guardian_id=$1 AND user_id=$2 AND status='active'`,
          [userId, targetUserId]
        );
        if (!rel.rows[0]) {
          return socket.emit('error', { message: 'Not authorized to watch this user' });
        }

        socket.join(`guardian:${userId}`);
        const targetGuardians = await cache.get(`guardians:${targetUserId}`) || [];
        if (!targetGuardians.includes(userId)) {
          targetGuardians.push(userId);
          await cache.set(`guardians:${targetUserId}`, targetGuardians, 86400);
        }

        // Send last known location immediately
        const lastLoc = await cache.get(`location:${targetUserId}`);
        if (lastLoc) socket.emit('user-location', lastLoc);

        logger.info('Guardian tracking started', { guardianId: userId, targetUserId });
      } catch (err) {
        logger.error('watch-user error', { error: err.message });
      }
    });

    socket.on('unwatch-user', async ({ targetUserId }) => {
      const targetGuardians = (await cache.get(`guardians:${targetUserId}`)) || [];
      const updated = targetGuardians.filter((id) => id !== userId);
      await cache.set(`guardians:${targetUserId}`, updated, 86400);
      socket.leave(`guardian:${userId}`);
    });

    // ── WEARABLE EVENTS ────────────────────────────────────
    socket.on('watch-connect', async ({ device_type }) => {
      socket.join(`watch:${userId}`);
      await cache.set(`watch:${userId}:connected`, { device_type, connectedAt: Date.now() }, 3600);
      socket.emit('watch-connected', { message: 'Wearable connected to Rakhsha', haptic: 'confirmation' });
    });

    socket.on('watch-sos', async (data) => {
      // SOS triggered from wearable
      logger.info('Watch SOS received', { userId });
      socket.emit('sos-confirmed', { message: 'SOS received from wearable. Alerting contacts.' });
      // Trigger full SOS flow
      const user = socket.user;
      if (user?.emergency_contacts?.length) {
        sendSOSBlast({
          user: { id: user.id, name: user.name },
          location: data.location || { lat: 0, lng: 0 },
          contacts: user.emergency_contacts,
        }).catch(() => {});
      }
    });

    // ── PEER ESCORT ────────────────────────────────────────
    socket.on('start-escort', async ({ peerId }) => {
      socket.join(`escort:${userId}:${peerId}`);
      io.to(`user:${peerId}`).emit('escort-request', { from: userId, name: socket.user?.name });
    });

    socket.on('escort-location', async ({ peerId, lat, lng }) => {
      io.to(`escort:${userId}:${peerId}`).emit('escort-update', { from: userId, lat, lng, timestamp: Date.now() });
    });

    // ── DISCONNECT ────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info('Socket disconnected', { userId, reason });
      await cache.del(`watch:${userId}:connected`);
      // Don't delete location cache — keep for stop detection
    });

    // ── ERROR ─────────────────────────────────────────────
    socket.on('error', (err) => {
      logger.error('Socket error', { userId, error: err.message });
    });
  });

  logger.info('✅ Socket.io initialized');
};

module.exports = { initSocketManager };
