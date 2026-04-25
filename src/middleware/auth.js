// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const { logger } = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * Protect route — verifies JWT, loads user from DB, attaches to req.user
 */
const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.jwt) {
      token = req.cookies.jwt;
    }

    if (!token) {
      return next(new AppError('Authentication required. Please log in.', 401));
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new AppError('Session expired. Please log in again.', 401));
      }
      return next(new AppError('Invalid token. Please log in again.', 401));
    }

    // Check token blacklist (logout)
    const blacklisted = await cache.exists(`blacklist:${token}`);
    if (blacklisted) {
      return next(new AppError('Token has been revoked. Please log in again.', 401));
    }

    // Check cache for user
    let user = await cache.get(`user:${decoded.id}`);
    if (!user) {
      const result = await query(
        `SELECT id, name, phone, email, role, is_active, emergency_contacts, created_at
         FROM users WHERE id = $1 AND is_active = true`,
        [decoded.id]
      );
      if (!result.rows[0]) {
        return next(new AppError('User no longer exists.', 401));
      }
      user = result.rows[0];
      await cache.set(`user:${decoded.id}`, user, 300); // 5 min cache
    }

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    logger.error('Auth middleware error', { error: err.message });
    next(new AppError('Authentication failed.', 401));
  }
};

/**
 * Restrict to specific roles
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403));
    }
    next();
  };
};

/**
 * Authenticate WebSocket connection
 */
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token) return next(new Error('Authentication required'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const blacklisted = await cache.exists(`blacklist:${token}`);
    if (blacklisted) return next(new Error('Token revoked'));

    let user = await cache.get(`user:${decoded.id}`);
    if (!user) {
      const { query: dbQuery } = require('../config/database');
      const result = await dbQuery(
        'SELECT id, name, phone, email, role FROM users WHERE id = $1 AND is_active = true',
        [decoded.id]
      );
      if (!result.rows[0]) return next(new Error('User not found'));
      user = result.rows[0];
    }

    socket.userId = user.id;
    socket.user = user;
    next();
  } catch (err) {
    logger.error('Socket auth error', { error: err.message });
    next(new Error('Authentication failed'));
  }
};

module.exports = { protect, restrictTo, authenticateSocket };
