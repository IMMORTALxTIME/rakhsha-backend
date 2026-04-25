// src/config/firebase.js
const admin = require('firebase-admin');
const { logger } = require('../utils/logger');

let firebaseApp = null;

const initFirebase = () => {
  if (firebaseApp) return firebaseApp;
  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    logger.info('✅ Firebase Admin initialized');
  } catch (err) {
    logger.error('❌ Firebase init failed', { error: err.message });
  }
  return firebaseApp;
};

const getMessaging = () => {
  if (!firebaseApp) initFirebase();
  return admin.messaging();
};

module.exports = { initFirebase, getMessaging };
