// src/services/notificationService.js
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const { getMessaging } = require('../config/firebase');
const { logger } = require('../utils/logger');

let twilioClient = null;
let emailTransporter = null;

const getTwilio = () => {
  if (!twilioClient) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
};

const getTransporter = () => {
  if (!emailTransporter) {
    emailTransporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return emailTransporter;
};

// ── FCM Push Notification ───────────────────────────────────
const sendPushNotification = async ({ token, title, body, data = {} }) => {
  if (!token) return { success: false, reason: 'No FCM token' };
  try {
    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { sound: 'sos_alert', channelId: 'safety_alerts' } },
      apns: { payload: { aps: { sound: 'sos_alert.caf', badge: 1 } } },
    };
    const response = await getMessaging().send(message);
    logger.info('FCM push sent', { token: token.slice(0, 10), response });
    return { success: true, messageId: response };
  } catch (err) {
    logger.error('FCM push failed', { error: err.message });
    return { success: false, reason: err.message };
  }
};

const sendPushToMultiple = async (tokens, payload) => {
  if (!tokens?.length) return [];
  const results = await Promise.allSettled(
    tokens.map((token) => sendPushNotification({ token, ...payload }))
  );
  return results.map((r, i) => ({ token: tokens[i], ...r.value }));
};

// ── SMS via Twilio ──────────────────────────────────────────
const sendSMS = async ({ to, message }) => {
  try {
    const msg = await getTwilio().messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    logger.info('SMS sent', { to, sid: msg.sid });
    return { success: true, sid: msg.sid };
  } catch (err) {
    logger.error('SMS failed', { to, error: err.message });
    return { success: false, reason: err.message };
  }
};

// ── Email ───────────────────────────────────────────────────
const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const info = await getTransporter().sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM}>`,
      to,
      subject,
      html,
      text,
    });
    logger.info('Email sent', { to, messageId: info.messageId });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error('Email failed', { to, error: err.message });
    return { success: false, reason: err.message };
  }
};

// ── SOS Blast — push + SMS + email to all emergency contacts ─
const sendSOSBlast = async ({ user, location, audioUrl, imageUrl, contacts }) => {
  const mapsLink = `https://maps.google.com/?q=${location.lat},${location.lng}`;
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const sosMessage = `🆘 SOS ALERT from ${user.name}!\nTime: ${timestamp}\nLocation: ${mapsLink}\nThis is an automated emergency alert from Rakhsha Safety App.`;

  const sosHTML = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:2px solid #e53e3e;border-radius:8px;padding:20px;">
      <h2 style="color:#e53e3e;">🆘 EMERGENCY SOS ALERT</h2>
      <p><strong>${user.name}</strong> has triggered an SOS alert.</p>
      <p><strong>Time:</strong> ${timestamp}</p>
      <p><strong>Location:</strong> <a href="${mapsLink}">${mapsLink}</a></p>
      ${audioUrl ? `<p><strong>Audio Clip:</strong> <a href="${audioUrl}">Listen (5s)</a></p>` : ''}
      ${imageUrl ? `<p><strong>Camera Image:</strong> <a href="${imageUrl}">View Image</a></p>` : ''}
      <p style="color:#666;font-size:12px;">This alert was sent automatically by the Rakhsha Safety App.</p>
    </div>`;

  const results = await Promise.allSettled(
    contacts.map(async (contact) => {
      const tasks = [];
      if (contact.phone) tasks.push(sendSMS({ to: contact.phone, message: sosMessage }));
      if (contact.email) tasks.push(sendEmail({ to: contact.email, subject: `🆘 SOS Alert: ${user.name} needs help!`, html: sosHTML, text: sosMessage }));
      if (contact.fcm_token) tasks.push(sendPushNotification({ token: contact.fcm_token, title: `🆘 SOS: ${user.name}`, body: 'Emergency alert triggered. Tap to see location.', data: { type: 'SOS', lat: String(location.lat), lng: String(location.lng) } }));
      return Promise.allSettled(tasks);
    })
  );

  logger.info('SOS blast sent', { userId: user.id, contacts: contacts.length });
  return results;
};

module.exports = { sendPushNotification, sendPushToMultiple, sendSMS, sendEmail, sendSOSBlast };
