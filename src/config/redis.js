// src/config/redis.js
const Redis = require('ioredis');
const { logger } = require('../utils/logger');

let redisClient = null;

const createRedisClient = () => {
  if (redisClient) return redisClient;

  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10000,
    lazyConnect: false,
    retryStrategy: (times) => {
      if (times > 10) {
        logger.error('Redis: too many retries, giving up');
        return null;
      }
      return Math.min(times * 100, 3000);
    },
  });

  redisClient.on('connect', () => logger.info('✅ Redis connected'));
  redisClient.on('error', (err) => logger.error('Redis error', { error: err.message }));
  redisClient.on('reconnecting', () => logger.warn('Redis reconnecting...'));

  return redisClient;
};

const getRedis = () => {
  if (!redisClient) return createRedisClient();
  return redisClient;
};

// Cache helper methods
const cache = {
  get: async (key) => {
    const val = await getRedis().get(key);
    return val ? JSON.parse(val) : null;
  },
  set: async (key, value, ttlSeconds = parseInt(process.env.REDIS_TTL_DEFAULT) || 3600) => {
    return getRedis().setex(key, ttlSeconds, JSON.stringify(value));
  },
  del: async (key) => getRedis().del(key),
  exists: async (key) => getRedis().exists(key),
  expire: async (key, ttl) => getRedis().expire(key, ttl),
  incr: async (key) => getRedis().incr(key),
  hset: async (hash, field, value) => getRedis().hset(hash, field, JSON.stringify(value)),
  hget: async (hash, field) => {
    const val = await getRedis().hget(hash, field);
    return val ? JSON.parse(val) : null;
  },
  hgetall: async (hash) => {
    const data = await getRedis().hgetall(hash);
    if (!data) return null;
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON.parse(v)]));
  },
  hdel: async (hash, field) => getRedis().hdel(hash, field),
  publish: async (channel, message) => getRedis().publish(channel, JSON.stringify(message)),
  lpush: async (key, value) => getRedis().lpush(key, JSON.stringify(value)),
  lrange: async (key, start, stop) => {
    const items = await getRedis().lrange(key, start, stop);
    return items.map((i) => JSON.parse(i));
  },
};

module.exports = { createRedisClient, getRedis, cache };
