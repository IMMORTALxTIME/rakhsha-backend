// src/middleware/rateLimiter.js
const { RateLimiterRedis } = require('rate-limiter-flexible');
const { getRedis } = require('../config/redis');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

let redisLimiter, sosLimiter, authLimiter;

const initRateLimiters = () => {
  const redis = getRedis();

  // General API — 100 req/min per user (by IP + userId)
  redisLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl_general',
    points: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    duration: 60,
    blockDuration: 60,
  });

  // SOS endpoints — stricter (prevent abuse, allow genuine emergencies)
  sosLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl_sos',
    points: parseInt(process.env.SOS_RATE_LIMIT_MAX) || 10,
    duration: 60,
    blockDuration: 120,
  });

  // Auth endpoints — prevent brute force
  authLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl_auth',
    points: 10,
    duration: 900, // 15 min window
    blockDuration: 900,
  });
};

const createLimitMiddleware = (limiter, errorMessage = 'Too many requests. Please try again later.') => {
  return async (req, res, next) => {
    try {
      const key = req.user?.id || req.ip;
      await limiter.consume(key);
      next();
    } catch (rejRes) {
      if (rejRes instanceof Error) {
        logger.error('Rate limiter error', { error: rejRes.message });
        return next(); // Don't block on limiter failure
      }
      const secs = Math.ceil(rejRes.msBeforeNext / 1000);
      res.set('Retry-After', secs);
      res.set('X-RateLimit-Reset', new Date(Date.now() + rejRes.msBeforeNext).toISOString());
      next(new AppError(errorMessage, 429));
    }
  };
};

// Lazy init getters
const generalRateLimit = (req, res, next) => {
  if (!redisLimiter) initRateLimiters();
  return createLimitMiddleware(redisLimiter)(req, res, next);
};

const sosRateLimit = (req, res, next) => {
  if (!sosLimiter) initRateLimiters();
  return createLimitMiddleware(sosLimiter, 'SOS rate limit exceeded.')(req, res, next);
};

const authRateLimit = (req, res, next) => {
  if (!authLimiter) initRateLimiters();
  return createLimitMiddleware(authLimiter, 'Too many auth attempts. Try again in 15 minutes.')(req, res, next);
};

module.exports = { generalRateLimit, sosRateLimit, authRateLimit, initRateLimiters };
