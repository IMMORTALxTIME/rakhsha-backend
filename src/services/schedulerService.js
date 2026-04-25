// src/services/schedulerService.js
const cron = require('node-cron');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const { sendPushNotification, sendSMS } = require('./notificationService');
const { decrypt } = require('../utils/encryption');
const { logger } = require('../utils/logger');

/**
 * Monitor users with active SOS events — escalate if unresolved >10 min
 */
const monitorActiveSOS = async () => {
  try {
    const result = await query(`
      SELECT se.id, se.user_id, se.created_at,
             u.name, u.fcm_token, u.emergency_contacts,
             ST_X(se.location::geometry) AS lng,
             ST_Y(se.location::geometry) AS lat
      FROM sos_events se
      JOIN users u ON u.id = se.user_id
      WHERE se.status = 'active'
      AND se.created_at < NOW() - INTERVAL '10 minutes'
      AND (se.escalated_at IS NULL OR se.escalated_at < NOW() - INTERVAL '10 minutes')
    `);

    for (const event of result.rows) {
      logger.warn('Escalating unresolved SOS', { sosId: event.id, userId: event.user_id });

      const contacts = event.emergency_contacts || [];
      for (const contact of contacts) {
        if (contact.phone) {
          const phone = contact.phone.startsWith('+') ? contact.phone : decrypt(contact.phone);
          await sendSMS({
            to: phone,
            message: `🆘 URGENT: ${event.name}'s SOS alert from ${new Date(event.created_at).toLocaleTimeString()} is still ACTIVE. Please check on them immediately! Location: https://maps.google.com/?q=${event.lat},${event.lng}`,
          }).catch(() => {});
        }
      }

      await query(
        'UPDATE sos_events SET escalated_at=NOW() WHERE id=$1',
        [event.id]
      );
    }
  } catch (err) {
    logger.error('SOS monitor error', { error: err.message });
  }
};

/**
 * Detect users who missed check-in timers
 */
const monitorCheckins = async () => {
  try {
    // Find users with active routes who haven't checked in recently
    const result = await query(`
      SELECT DISTINCT r.user_id, u.name, u.fcm_token, u.emergency_contacts,
             MAX(c.created_at) AS last_checkin
      FROM routes r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN checkins c ON c.user_id = r.user_id AND c.created_at > NOW() - INTERVAL '30 minutes'
      WHERE r.created_at > NOW() - INTERVAL '4 hours'
      GROUP BY r.user_id, u.name, u.fcm_token, u.emergency_contacts
      HAVING MAX(c.created_at) IS NULL
      OR MAX(c.created_at) < NOW() - INTERVAL '15 minutes'
    `);

    for (const user of result.rows) {
      const alertKey = `checkin_alert:${user.user_id}`;
      const alreadyAlerted = await cache.exists(alertKey);
      if (alreadyAlerted) continue;

      // Notify user with push
      if (user.fcm_token) {
        await sendPushNotification({
          token: user.fcm_token,
          title: '🔔 Check-in Reminder',
          body: 'You haven\'t checked in for a while. Tap to confirm you\'re safe.',
          data: { type: 'CHECKIN_REMINDER' },
        }).catch(() => {});
      }

      await cache.set(alertKey, 1, 900); // Don't re-alert for 15 min
      logger.info('Check-in reminder sent', { userId: user.user_id });
    }
  } catch (err) {
    logger.error('Check-in monitor error', { error: err.message });
  }
};

/**
 * Clean up old location history (>30 days) and expired ML predictions
 */
const cleanupOldData = async () => {
  try {
    const locResult = await query(
      'DELETE FROM location_history WHERE recorded_at < NOW() - INTERVAL $1',
      ['30 days']
    );
    const mlResult = await query(
      'DELETE FROM ml_predictions WHERE predicted_at < NOW() - INTERVAL $1',
      ['7 days']
    );
    logger.info('Cleanup complete', {
      locations_deleted: locResult.rowCount,
      ml_predictions_deleted: mlResult.rowCount,
    });
  } catch (err) {
    logger.error('Cleanup error', { error: err.message });
  }
};

/**
 * Refresh crime heatmap cache
 */
const refreshHeatmapCache = async () => {
  try {
    await cache.del('report:heatmap');
    await cache.del('crime:hotspots');
    logger.info('Heatmap cache invalidated — will refresh on next request');
  } catch (err) {
    logger.error('Heatmap cache refresh error', { error: err.message });
  }
};

/**
 * Initialize all cron jobs
 */
const initScheduler = () => {
  // Every 5 min — monitor active SOS
  cron.schedule('*/5 * * * *', monitorActiveSOS, { name: 'sos-monitor' });

  // Every 10 min — check-in monitoring
  cron.schedule('*/10 * * * *', monitorCheckins, { name: 'checkin-monitor' });

  // Daily at 2 AM — cleanup old data
  cron.schedule('0 2 * * *', cleanupOldData, { name: 'data-cleanup' });

  // Every 30 min — refresh heatmap
  cron.schedule('*/30 * * * *', refreshHeatmapCache, { name: 'heatmap-refresh' });

  logger.info('✅ Scheduler initialized — 4 cron jobs active');
};

module.exports = { initScheduler, monitorActiveSOS, monitorCheckins, cleanupOldData };
