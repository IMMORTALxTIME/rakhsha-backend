// src/middleware/errorHandler.js
const { logger } = require('../utils/logger');

const sendError = (err, res) => {
  const statusCode = err.statusCode || 500;
  const status = err.status || 'error';

  // Operational errors (safe to share with client)
  if (err.isOperational) {
    return res.status(statusCode).json({
      status,
      message: err.message,
    });
  }

  // Programming/unknown errors — don't leak details
  logger.error('Unexpected error', {
    message: err.message,
    stack: err.stack,
    url: res.req?.url,
    method: res.req?.method,
  });

  return res.status(500).json({
    status: 'error',
    message: 'Something went wrong. Please try again later.',
  });
};

const handlePGError = (err) => {
  // Unique constraint violation
  if (err.code === '23505') {
    const field = err.detail?.match(/\(([^)]+)\)/)?.[1] || 'field';
    return { message: `A record with this ${field} already exists.`, statusCode: 409 };
  }
  // Foreign key violation
  if (err.code === '23503') {
    return { message: 'Referenced record does not exist.', statusCode: 400 };
  }
  // Not null violation
  if (err.code === '23502') {
    return { message: `${err.column} is required.`, statusCode: 400 };
  }
  return null;
};

const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    err.message = 'Invalid token.';
    err.statusCode = 401;
    err.isOperational = true;
  }
  if (err.name === 'TokenExpiredError') {
    err.message = 'Session expired. Please log in again.';
    err.statusCode = 401;
    err.isOperational = true;
  }

  // PostgreSQL errors
  if (err.code && err.code.startsWith('2')) {
    const pgErr = handlePGError(err);
    if (pgErr) {
      err.message = pgErr.message;
      err.statusCode = pgErr.statusCode;
      err.isOperational = true;
    }
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    err.message = 'File size too large. Maximum 10MB allowed.';
    err.statusCode = 400;
    err.isOperational = true;
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    err.message = 'Unexpected file field.';
    err.statusCode = 400;
    err.isOperational = true;
  }

  sendError(err, res);
};

module.exports = { globalErrorHandler };
