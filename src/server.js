// src/server.js
'use strict';
require('dotenv').config();
require('express-async-errors');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const path = require('path');

const { testConnection } = require('./config/database');
const { createRedisClient } = require('./config/redis');
const { initFirebase } = require('./config/firebase');
const { initSocketManager } = require('./websocket/socketManager');
const { globalErrorHandler } = require('./middleware/errorHandler');
const { generalRateLimit } = require('./middleware/rateLimiter');
const { swaggerSpec } = require('./config/swagger');
const { logger } = require('./utils/logger');

// ── Routes ─────────────────────────────────────────────────
const authRoutes     = require('./routes/auth');
const routeRoutes    = require('./routes/route');
const crimeRoutes    = require('./routes/crime');
const reportRoutes   = require('./routes/reports');
const sosRoutes      = require('./routes/sos');
const guardianRoutes = require('./routes/guardian');
const safetyRoutes   = require('./routes/safety');

const app = express();
const server = http.createServer(app);

// ── Socket.io ──────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000,
});
app.set('io', io);
initSocketManager(io);

// ── Security Middleware ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Swagger UI needs inline scripts
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// ── Body Parsing ───────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// ── Logging ────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.url === '/health',
  }));
}

// ── Health Check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'rakhsha-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

// ── API Docs ───────────────────────────────────────────────
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Rakhsha API',
  customCss: '.swagger-ui .topbar { background: #7B2D8B; }',
}));
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));

// ── API Routes ─────────────────────────────────────────────
const API = '/api/v1';

app.use(`${API}/auth`,     authRoutes);
app.use(`${API}/route`,    routeRoutes);
app.use(`${API}/crime`,    crimeRoutes);
app.use(`${API}/report`,   reportRoutes);
app.use(`${API}/sos`,      sosRoutes);
app.use(`${API}/guardian`, guardianRoutes);
app.use(`${API}/safety`,   safetyRoutes);

// Legacy route aliases (no /v1 prefix for mobile compatibility)
app.use('/api/auth',     authRoutes);
app.use('/api/route',    routeRoutes);
app.use('/api/crime',    crimeRoutes);
app.use('/api/report',   reportRoutes);
app.use('/api/sos',      sosRoutes);
app.use('/api/guardian', guardianRoutes);
app.use('/api/checkin',  safetyRoutes);
app.use('/api/health-mode', safetyRoutes);
app.use('/api/watch',    safetyRoutes);

// ── 404 Handler ────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'fail',
    message: `Route ${req.originalUrl} not found`,
  });
});

// ── Global Error Handler ───────────────────────────────────
app.use(globalErrorHandler);

// ── Server Start ───────────────────────────────────────────
const PORT = process.env.PORT || 8001;

const startServer = async () => {
  try {
    await testConnection();
    createRedisClient();
    initFirebase();

    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Rakhsha backend running on port ${PORT}`);
      logger.info(`📚 API Docs: http://localhost:${PORT}/api/docs`);
      logger.info(`🏥 Health:   http://localhost:${PORT}/health`);
      logger.info(`🌍 ENV: ${process.env.NODE_ENV}`);
    });
  } catch (err) {
    logger.error('Server startup failed', { error: err.message });
    process.exit(1);
  }
};

// ── Graceful Shutdown ──────────────────────────────────────
const shutdown = (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000); // Force exit after 10s
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

startServer();

module.exports = { app, server };
