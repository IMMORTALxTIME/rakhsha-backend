// src/utils/encryption.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').slice(0, 32));
const IV_LENGTH = 16;

/**
 * Encrypt a string value (for PII, phone numbers, locations)
 */
const encrypt = (text) => {
  if (!text) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(String(text));
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

/**
 * Decrypt an encrypted string
 */
const decrypt = (encryptedText) => {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText;
  const [ivHex, encHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

/**
 * Hash sensitive data for comparison (e.g. phone numbers for lookup)
 */
const hash = (value) => {
  return crypto.createHmac('sha256', KEY).update(String(value)).digest('hex');
};

/**
 * Generate a cryptographically secure random token
 */
const generateToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString('hex');
};

/**
 * Mask a phone number for display
 */
const maskPhone = (phone) => {
  if (!phone || phone.length < 4) return '****';
  return `****${phone.slice(-4)}`;
};

module.exports = { encrypt, decrypt, hash, generateToken, maskPhone };
