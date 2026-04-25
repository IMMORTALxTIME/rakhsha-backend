// src/config/upload.js
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const AppError = require('../utils/AppError');
const { logger } = require('../utils/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Memory storage — stream directly to Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    'image/jpeg': true,
    'image/jpg': true,
    'image/png': true,
    'image/webp': true,
    'audio/mpeg': true,
    'audio/mp4': true,
    'audio/wav': true,
    'audio/webm': true,
    'video/mp4': true,
    'video/webm': true,
  };

  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new AppError(`File type ${file.mimetype} not allowed.`, 400), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 3,
  },
});

/**
 * Upload a buffer to Cloudinary with folder organization
 */
const uploadToCloudinary = (buffer, folder, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `rakhsha/${folder}`,
        resource_type: 'auto',
        transformation: folder === 'reports' ? [{ quality: 'auto:good' }, { fetch_format: 'auto' }] : [],
        ...options,
      },
      (error, result) => {
        if (error) {
          logger.error('Cloudinary upload error', { error: error.message });
          return reject(new AppError('Media upload failed.', 500));
        }
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
};

/**
 * Delete a resource from Cloudinary
 */
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    logger.warn('Cloudinary delete failed', { publicId, error: err.message });
  }
};

module.exports = { upload, uploadToCloudinary, deleteFromCloudinary, cloudinary };
