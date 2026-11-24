'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { createPostgresPool, initializePostgres, PostgresSessionStore, createDatabase } = require('./postgres');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');
const { renderEmail, previewEmail, templateNames } = require('./email-templates');

const envPath = path.join(__dirname, '.env');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envPath)) process.loadEnvFile(envPath);

const app = express();
const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const root = __dirname;
const port = Number(process.env.PORT || 3000);
const paymentEmail = 'marvelwilsononit@gmail.com';
const ORDER_LIFETIME_MS = 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const CODE_LIFETIME_MS = 10 * 60 * 1000;

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
}

const pool = createPostgresPool(process.env.DATABASE_URL);
const db = createDatabase(pool);

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const newTrackingCode = () => `TX-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
const shipmentLabels = {
  preparing: 'Preparing',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered'
};
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validNewPassword = value => value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72;
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const jsonSetting = async (key, fallback) => {
  const row = (await db.prepare('SELECT value FROM settings WHERE key = ?').get(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch (error) {
    console.error(`Invalid JSON in setting "${key}":`, error);
    throw new Error('The saved store settings are invalid.');
  }
};
async function seedCars() {
  if ((await db.prepare('SELECT COUNT(*) AS count FROM cars').get()).count) return;
  const seeds = [
    ['Porsche', '911 Carrera', 2023, 124900, 8100, 'Automatic', 'Coupe', 'A precision-built sports car with a responsive flat-six engine, premium interior and a clean service history.', '/assets/img/deal/2.jpg'],
    ['BMW', 'M4 Competition', 2024, 89900, 4200, 'Automatic', 'Coupe', 'High-performance coupe with M xDrive, carbon-fiber details and a driver-focused cockpit.', '/assets/img/deal/4.jpg'],
    ['Mercedes-Benz', 'AMG GT 63', 2023, 138500, 9300, 'Automatic', 'Coupe', 'A refined grand tourer blending confident AMG performance with everyday comfort.', '/assets/img/deal/5.jpg'],
    ['Audi', 'RS 6 Avant', 2024, 126000, 3100, 'Automatic', 'Wagon', 'A versatile performance wagon with quattro traction, generous cargo space and premium technology.', '/assets/img/deal/8.jpg'],
    ['Ford', 'Mustang Dark Horse', 2024, 61900, 1200, 'Manual', 'Coupe', 'A track-ready V8 coupe with a six-speed manual transmission and upgraded handling.', '/assets/img/project/3.jpg'],
    ['Land Rover', 'Defender 110 X', 2023, 94500, 15400, 'Automatic', 'SUV', 'An all-terrain luxury SUV with a spacious cabin, advanced driver assistance and towing capability.', '/assets/img/project/6.jpg']
  ];
  const insert = db.prepare(`INSERT INTO cars
    (id, make, model, year, price_usd, mileage, transmission, body_type, description, image_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seed = db.transaction(async () => {
    for (const car of seeds) (await insert.run(newId(), ...car, nowIso()));
  });
  (await seed());
}

async function seedAdmin() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  if (process.env.ADMIN_PASSWORD.length < 12) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
  }
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const existing = (await db.prepare('SELECT id, email_verified FROM users WHERE email = ?').get(email));
  if (existing) {
    if (!existing.email_verified) throw new Error('Configured administrator email belongs to an unverified account.');
    (await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id));
    return;
  }
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  (await db.prepare('INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId(), 'Administrator', email, passwordHash, 'admin', nowIso()));
}


async function refreshCarStatus(carId) {
  (await db.prepare(`UPDATE cars SET status = CASE
    WHEN available_stock > 0 THEN 'available'
    WHEN EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.car_id = cars.id AND o.status IN ('awaiting_bank_assignment', 'awaiting_payment', 'payment_received', 'payment_claimed', 'proof_submitted'))
      THEN 'reserved'
    WHEN EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.car_id = cars.id AND o.status = 'paid') THEN 'sold'
    ELSE 'out_of_stock' END, reserved_order = NULL, reserved_until = NULL WHERE id = ?`).run(carId));
}

async function finishInventory(orderId, release) {
  const items = (await db.prepare('SELECT car_id, quantity FROM order_items WHERE order_id = ?').all(orderId));
  for (const item of items) {
    if (release) (await db.prepare('UPDATE cars SET available_stock = available_stock + ? WHERE id = ?').run(item.quantity, item.car_id));
    (await refreshCarStatus(item.car_id));
  }
}

async function releaseExpiredOrders() {
  (await db.transaction(async () => {
    const now = nowIso();
    const expired = (await db.prepare("SELECT id FROM orders WHERE status = 'awaiting_payment' AND expires_at <= ?").all(now));
    const updateOrder = db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'awaiting_payment' AND expires_at <= ?");
    for (const { id } of expired) {
      if ((await updateOrder.run(id, now)).changes) (await finishInventory(id, true));
    }
  })());
}

const publicCar = row => ({
  id: row.id,
  make: row.make,
  model: row.model,
  year: row.year,
  priceUsd: row.price_usd,
  mileage: row.mileage,
  transmission: row.transmission,
  bodyType: row.body_type,
  description: row.description,
  imageUrl: row.image_url,
  status: row.status,
  availableStock: row.available_stock
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required.' });
  }
  next();
}

function requireCsrf(req, res, next) {
  if (req.originalUrl.split('?')[0] === '/api/gourl/ipn') return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const token = req.get('x-csrf-token');
  if (!token || !req.session.csrfToken || !safeEqual(token, req.session.csrfToken)) {
    return res.status(403).json({ error: 'Your session token has expired. Refresh the page and try again.' });
  }
  next();
}

function mailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM) {
    throw new Error('Email notifications are unavailable until SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM are configured.');
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
  });
}

async function sendTemplate(to, type, data) {
  const message = renderEmail(type, data);
  const result = await mailTransport().sendMail({ from: process.env.SMTP_FROM, to, ...message });
  if (!Array.isArray(result.accepted) || !result.accepted.some(address => normalizeEmail(typeof address === 'string' ? address : address.address) === normalizeEmail(to))) {
    throw new Error('The email recipient was not accepted by the mail server.');
  }
}

function trackingEmailLink(code) {
  const configured = process.env.PUBLIC_BASE_URL || '';
  let base;
  try {
    base = new URL(configured);
  } catch (error) {
    throw new Error('Set PUBLIC_BASE_URL to the public site origin before sending tracking emails.');
  }
  if (!['http:', 'https:'].includes(base.protocol) || (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('PUBLIC_BASE_URL must be a site origin without credentials, path, query or fragment; production requires HTTPS.');
  }
  return `${base.origin}/track#${code}`;
}

async function queueTrackingEmail(orderId, kind, shipmentStatus = null, eventAt = null) {
  return (await db.prepare(`INSERT INTO tracking_emails (order_id, kind, shipment_status, event_at, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id`).run(orderId, kind, shipmentStatus, eventAt, nowIso())).insertedId;
}

async function deliverTrackingEmail(emailId) {
  const notification = (await db.prepare(`SELECT e.*, t.code, o.buyer_details
    FROM tracking_emails e JOIN order_tracking t ON t.order_id = e.order_id
    JOIN orders o ON o.id = e.order_id WHERE e.id = ?`).get(emailId));
  if (!notification) throw new Error('Tracking email notification not found.');
  try {
    const recipient = normalizeEmail(JSON.parse(notification.buyer_details).email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('The order has no valid contact email address.');
    const link = trackingEmailLink(notification.code);
    await sendTemplate(recipient, notification.kind === 'shipment' ? 'shipment_update' : 'tracking_created', {
      code: notification.code, link, stage: shipmentLabels[notification.shipment_status], eventAt: notification.event_at
    });
    (await db.prepare("UPDATE tracking_emails SET status = 'sent' WHERE id = ?").run(emailId));
    return 'sent';
  } catch (error) {
    (await db.prepare("UPDATE tracking_emails SET status = 'failed' WHERE id = ?").run(emailId));
    console.error('Tracking email notification failed:', error);
    return 'failed';
  }
}

function getCryptoConfig(order, user) {
  const publicKey = process.env.GOURL_PUBLIC_KEY || '';
  const privateKey = process.env.GOURL_PRIVATE_KEY || '';
  const coinName = String(process.env.GOURL_COIN || 'bitcoin').toLowerCase();
  const supportedCoins = ['bitcoin', 'bitcoincash', 'bitcoinsv', 'litecoin', 'dash', 'dogecoin', 'speedcoin', 'reddcoin', 'potcoin', 'feathercoin', 'vertcoin', 'peercoin', 'monetaryunit', 'universalcurrency'];
  if (!publicKey || !privateKey || !supportedCoins.includes(coinName)) {
    throw new Error('GoUrl crypto checkout is not configured. Set valid GoUrl public/private keys and a GoUrl-supported coin in the server environment.');
  }
  const boxId = publicKey.split('AA')[0];
  const publicPrefix = publicKey.split('PUB')[0];
  const privatePrefix = privateKey.split('PRV')[0];
  if (!/^\d+$/.test(boxId) || !/^[A-Za-z0-9]{50}$/.test(publicKey) ||
    !/^[A-Za-z0-9]{50}$/.test(privateKey) || !publicKey.includes('PUB') ||
    !privateKey.includes('PRV') || publicPrefix !== privatePrefix) {
    throw new Error('GoUrl public/private keys do not appear to be a valid payment-box key pair.');
  }
  const actualCoinName = publicKey.split('AA')[1]?.split('77')[0]?.slice(5);
  if (actualCoinName?.toLowerCase() !== coinName) {
    throw new Error(`GOURL_COIN must match the configured GoUrl public key (${actualCoinName || 'unknown'}).`);
  }
  const period = '1 HOUR';
  const language = 'en';
  const iframeId = `gourl_${order.id.replaceAll('-', '')}`;
  const userId = `u${user.id.replaceAll('-', '')}`;
  const userFormat = 'MANUAL';
  const version = 'version | turquex-node 1.0.0';
  const orderId = order.id;
  const cookieName = '';
  const webdevKey = '';
  const amount = '0';
  const amountUsd = Number(order.total_usd).toString();
  const width = '530';
  const height = '300';
  const hashData = [
    boxId, actualCoinName, publicKey, privateKey, webdevKey, amount, amountUsd, period,
    language, orderId, userId, userFormat, version, iframeId, width, height
  ].join('|');
  return {
    boxId: Number(boxId),
    coinName: actualCoinName,
    publicKey,
    amount: 0,
    amountUsd,
    period,
    language,
    iframeId,
    userId,
    userFormat,
    orderId,
    cookieName,
    webdevKey,
    version: Buffer.from(version, 'utf8').toString('base64'),
    hash: crypto.createHash('md5').update(hashData, 'utf8').digest('hex'),
    width: Number(width),
    height: Number(height)
  };
}

async function orderResult(order, items, includePayment = false) {
  const proof = order.payment_method === 'bank'
    ? (await db.prepare('SELECT available_at, uploaded_at FROM payment_proofs WHERE order_id = ?').get(order.id))
    : null;
  const tracking = (await db.prepare('SELECT code, shipment_status FROM order_tracking WHERE order_id = ?').get(order.id));
  const trackingEmail = (await db.prepare('SELECT status, kind FROM tracking_emails WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(order.id));
  const applied = (await db.prepare('SELECT code, discount_usd AS "discountUsd" FROM order_promos WHERE order_id = ? ORDER BY position').all(order.id));
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.payment_method,
    currency: order.currency,
    subtotalUsd: order.subtotal_usd,
    discountUsd: order.discount_usd,
    totalUsd: order.total_usd,
    promoCode: order.promo_code,
    promoCodes: applied.length ? applied : order.promo_code ? [{ code: order.promo_code, discountUsd: order.discount_usd }] : [],
    createdAt: order.created_at,
    expiresAt: order.expires_at,
    ...(proof ? { proofAvailableAt: proof.available_at, proofUploadedAt: proof.uploaded_at } : {}),
    ...(tracking ? { tracking: { code: tracking.code, shipmentStatus: tracking.shipment_status, emailStatus: trackingEmail?.status || null } } : {}),
    items: items.map(item => ({
      carId: item.car_id,
      make: item.make,
      model: item.model,
      year: item.year,
      priceUsd: item.price_usd,
      quantity: item.quantity
    })),
    ...(includePayment ? { paymentDetails: JSON.parse(order.payment_details || '{}') } : {})
  };
}

app.disable('x-powered-by');
app.get('/health', (req, res) => res.status(200).send('OK'));
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", 'https://coins.gourl.io', 'https://cdn.jsdelivr.net', 'https://cdn.gtranslate.net'],
      frameSrc: ["'self'", 'https://coins.gourl.io', 'https://gourl.io'],
      connectSrc: ["'self'", 'https://open.er-api.com', 'https://coins.gourl.io', 'https://translate-pa.googleapis.com'],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(session({
  store: new PostgresSessionStore(pool),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use('/api', asyncHandler(async (req, res, next) => {
  (await releaseExpiredOrders());
  next();
}));
app.use('/api', asyncHandler(async (req, res, next) => {
  if (req.session.user) {
    const user = (await db.prepare('SELECT id, name, email, role, auth_version, email_verified FROM users WHERE id = ?').get(req.session.user.id));
    if (!user || !user.email_verified || user.auth_version !== (req.session.user.authVersion ?? 0)) {
      delete req.session.user;
    } else {
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, authVersion: user.auth_version };
    }
  }
  next();
}));
app.use('/api', requireCsrf);
app.use('/api', (req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.set('Cache-Control', 'no-store');
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const inquiryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const inquiryStatusLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const trackingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const trackingMailLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
app.get('/api/site-config', (req, res) => {
  res.json({ gtranslateEnabled: process.env.GTRANSLATE_ENABLED === 'true' });
});

app.get('/api/csrf', (req, res) => {
  res.json({ token: req.session.csrfToken });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get('/api/contact-details', asyncHandler(async (req, res) => {
  res.json({ contact: (await jsonSetting('contact_details', {})) });
}));

function inquiryContact(body) {
  const name = String(body.name || '').trim();
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  if (name.length < 2 || name.length > 100 || email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !/^[+\d\s().-]{7,30}$/.test(phone) || phone.replace(/\D/g, '').length < 7) {
    throw Object.assign(new Error('Enter your name, a valid email address and phone number.'), { status: 400 });
  }
  return { name, email, phone };
}

app.post('/api/contact-messages', inquiryLimiter, asyncHandler(async (req, res, next) => {
  try {
    const contact = inquiryContact(req.body);
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();
    if (!['Vehicle inquiry', 'Order inquiry', 'General question'].includes(subject) || message.length < 5 || message.length > 4000) {
      return res.status(400).json({ error: 'Choose an inquiry type and enter a message between 5 and 4000 characters.' });
    }
    const id = newId();
    (await db.prepare(`INSERT INTO contact_messages (id, name, email, phone, subject, message, confirmation_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, contact.name, contact.email, contact.phone, subject, message, nowIso()));
    let confirmationStatus = 'sent';
    try {
      await sendTemplate(contact.email, 'contact_received', { name: contact.name, inquiry: subject });
    } catch (error) {
      confirmationStatus = 'failed';
      console.error('Contact confirmation email failed:', error);
    }
    (await db.prepare('UPDATE contact_messages SET confirmation_status = ? WHERE id = ?').run(confirmationStatus, id));
    res.status(201).json({ message: 'Your message has been received by the sales team.', confirmationStatus });
  } catch (error) {
    next(error);
  }
}));

const callTimeZone = 'America/New_York';
const callHours = [9, 10, 11, 14, 15];
const callDateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: callTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function callTimeParts(date) {
  return Object.fromEntries(callDateTime.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function callDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function callSlot(dateKey, hour) {
  for (const offset of [4, 5]) {
    const instant = new Date(`${dateKey}T${String(hour + offset).padStart(2, '0')}:00:00.000Z`);
    const parts = callTimeParts(instant);
    if (callDateKey(parts) === dateKey && Number(parts.hour) === hour) return instant;
  }
  throw new Error(`Could not resolve call time for ${dateKey} at ${hour}:00.`);
}
async function activeCalls(dateKey, excludeId = '') {
  const midnight = new Date(`${dateKey}T00:00:00.000Z`).getTime();
  return (await db.prepare(`SELECT id, preferred_at FROM call_requests
    WHERE status IN ('requested', 'confirmed') AND preferred_at >= ? AND preferred_at < ? AND id != ?`)
    .all(new Date(midnight - 86400000).toISOString(), new Date(midnight + 2 * 86400000).toISOString(), excludeId))
    .filter(call => callDateKey(callTimeParts(new Date(call.preferred_at))) === dateKey);
}
async function callHasCapacity(preferred, excludeId = '') {
  const parts = callTimeParts(preferred);
  const calls = (await activeCalls(callDateKey(parts), excludeId));
  return calls.length < 5 && !calls.some(call => callTimeParts(new Date(call.preferred_at)).hour === parts.hour);
}

app.get('/api/call-availability', inquiryStatusLimiter, asyncHandler(async (req, res, next) => {
  try {
    const today = callDateKey(callTimeParts(new Date()));
    const maxMonth = callDateKey(callTimeParts(new Date(Date.now() + 366 * 86400000))).slice(0, 7);
    const month = String(req.query.month || today.slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      month < today.slice(0, 7) || month > maxMonth) {
      return res.status(400).json({ error: 'Choose a month within the next year.' });
    }
    const [year, monthNumber] = month.split('-').map(Number);
    const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const days = [];
    for (let day = 1; day <= dayCount; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
      const calls = (await activeCalls(date));
      const slots = weekday > 0 && weekday < 6 && calls.length < 5
        ? callHours.map(hour => callSlot(date, hour)).filter(slot =>
          slot.getTime() > Date.now() && slot.getTime() <= Date.now() + 366 * 86400000 &&
          !calls.some(call => callTimeParts(new Date(call.preferred_at)).hour === callTimeParts(slot).hour))
        : [];
      days.push({ date, slots: slots.map(slot => slot.toISOString()) });
    }
    res.set('Cache-Control', 'no-store').json({ month, minMonth: today.slice(0, 7), maxMonth, timezone: callTimeZone, days });
  } catch (error) {
    next(error);
  }
}));

app.post('/api/call-requests', inquiryLimiter, asyncHandler(async (req, res, next) => {
  try {
    const contact = inquiryContact(req.body);
    const preferredAt = String(req.body.preferredAt || '');
    const preferred = new Date(preferredAt);
    const timezone = String(req.body.timezone || '').trim();
    const notes = String(req.body.notes || '').trim();
    if (!Number.isFinite(preferred.getTime()) || preferred.toISOString() !== preferredAt || preferred.getTime() <= Date.now() ||
      preferred.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000 ||
      !timezone || timezone.length > 100 || notes.length > 2000) {
      return res.status(400).json({ error: 'Choose a future time within the next year and enter valid call details.' });
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch (error) {
      return res.status(400).json({ error: 'Choose a valid time zone.' });
    }
    const parts = callTimeParts(preferred);
    const dateKey = callDateKey(parts);
    const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || !callHours.includes(Number(parts.hour)) ||
      parts.minute !== '00' || preferred.getUTCSeconds() !== 0 || preferred.getUTCMilliseconds() !== 0 ||
      callSlot(dateKey, Number(parts.hour)).getTime() !== preferred.getTime()) {
      return res.status(400).json({ error: 'Choose an available sales call time.' });
    }
    const id = newId();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    (await db.transaction(async () => {
      if (!(await callHasCapacity(preferred))) throw Object.assign(new Error('That call time is no longer available. Please choose another.'), { status: 409 });
      (await db.prepare(`INSERT INTO call_requests (id, token_hash, name, email, phone, preferred_at, timezone, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tokenHash, contact.name, contact.email, contact.phone, preferred.toISOString(), timezone, notes, nowIso()));
    })());
    res.status(201).json({ id, trackingToken: token, status: 'requested', preferredAt: preferred.toISOString() });
  } catch (error) {
    next(error);
  }
}));

app.get('/api/call-requests/:id', inquiryStatusLimiter, asyncHandler(async (req, res) => {
  const token = String(req.get('x-request-token') || '');
  const request = (await db.prepare('SELECT token_hash, status, preferred_at FROM call_requests WHERE id = ?').get(req.params.id));
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (!request || !/^[a-f0-9]{64}$/.test(token) || !safeEqual(tokenHash, request.token_hash)) {
    return res.status(404).json({ error: 'Call request not found.' });
  }
  res.json({ status: request.status, preferredAt: request.preferred_at });
}));

app.post('/api/auth/register', authLimiter, asyncHandler(async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validNewPassword(password)) {
      return res.status(400).json({ error: 'Enter your name, a valid email address, and a password of at least 12 characters and no more than 72 UTF-8 bytes.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const registration = (await db.transaction(async () => {
      let user = (await db.prepare('SELECT * FROM users WHERE email = ?').get(email));
      if (user?.email_verified) throw Object.assign(new Error('An account with that email already exists.'), { status: 409 });
      if (!user) {
        (await db.prepare("INSERT INTO users (id, name, email, password_hash, role, created_at, email_verified) VALUES (?, ?, ?, ?, 'customer', ?, 0)")
          .run(newId(), name, email, passwordHash, nowIso()));
        user = (await db.prepare('SELECT * FROM users WHERE email = ?').get(email));
      } else {
        (await db.prepare('UPDATE users SET name = ?, password_hash = ?, auth_version = auth_version + 1 WHERE id = ?').run(name, passwordHash, user.id));
        user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
      }
      const issued = (await createCode(user.id, 'registration', 'registration'));
      if (!issued) throw Object.assign(new Error('Please wait before requesting another code.'), { status: 429 });
      return { user, issued };
    })());
    let deliveryStatus = 'sent';
    try { await sendTemplate(email, 'registration_verification', { code: registration.issued.code }); }
    catch (error) {
      (await db.prepare('DELETE FROM account_codes WHERE id = ?').run(registration.issued.id));
      console.error('Registration verification email failed:', error);
      deliveryStatus = 'failed';
    }
    startVerificationSession(req, res, next, registration.user, deliveryStatus);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    next(error);
  }
}));

app.post('/api/auth/login', authLimiter, asyncHandler(async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const user = (await db.prepare('SELECT id, name, email, password_hash, role, auth_version, email_verified FROM users WHERE email = ?').get(email));
    const matches = user && await bcrypt.compare(password, user.password_hash);
    if (!matches) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (!user.email_verified) return startVerificationSession(req, res, next, user, 'unknown');
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, authVersion: user.auth_version };
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.json({ user: req.session.user, token: req.session.csrfToken });
    });
  } catch (error) {
    next(error);
  }
}));

function startVerificationSession(req, res, next, user, deliveryStatus) {
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.pendingVerification = { id: user.id, authVersion: user.auth_version, deliveryStatus };
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.json({ verificationRequired: true, token: req.session.csrfToken });
  });
}

async function pendingVerification(req) {
  const pending = req.session.pendingVerification;
  if (!pending) return null;
  return (await db.prepare('SELECT * FROM users WHERE id = ? AND email_verified = 0 AND auth_version = ?').get(pending.id, pending.authVersion));
}

app.get('/api/auth/verification', asyncHandler(async (req, res) => {
  const user = (await pendingVerification(req));
  if (!user) return res.status(401).json({ error: 'Sign in or register to start email verification.' });
  res.json({ email: user.email, deliveryStatus: req.session.pendingVerification.deliveryStatus });
}));

app.post('/api/auth/verification/resend', codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const user = (await pendingVerification(req));
    if (!user) return res.status(401).json({ error: 'Your verification session expired. Sign in again.' });
    const issued = (await db.transaction(async () => (await createCode(user.id, 'registration', 'registration')))());
    if (!issued) return res.status(429).json({ error: 'Please wait before requesting another code.' });
    try { await sendTemplate(user.email, 'registration_verification', { code: issued.code }); }
    catch (error) {
      (await db.prepare('DELETE FROM account_codes WHERE id = ?').run(issued.id));
      req.session.pendingVerification.deliveryStatus = 'failed';
      console.error('Registration verification email failed:', error);
      return res.status(503).json({ error: 'Could not send the verification code. Please try again later.' });
    }
    req.session.pendingVerification.deliveryStatus = 'sent';
    res.json({ message: 'A new verification code was sent. Check your inbox and spam folder.' });
  } catch (error) { next(error); }
}));

app.post('/api/auth/verification/confirm', codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const user = (await db.transaction(async () => {
      const pending = (await pendingVerification(req));
      if (!pending) return null;
      const row = (await checkCode(pending.id, 'registration', 'registration', req.body.code));
      if (!row) return null;
      (await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(pending.id));
      (await db.prepare("DELETE FROM account_codes WHERE user_id = ? AND purpose = 'registration'").run(pending.id));
      return (await db.prepare('SELECT * FROM users WHERE id = ?').get(pending.id));
    })());
    if (!user) return invalidCode(res);
    updateSession(req, res, next, user);
  } catch (error) { next(error); }
}));

app.post('/api/auth/logout', requireAuth, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

function codeHash(id, code) {
  return crypto.createHmac('sha256', sessionSecret).update(`${id}:${code}`).digest('hex');
}

async function createCode(userId, purpose, stage, targetEmail = null) {
  const now = Date.now();
  const recent = (await db.prepare('SELECT created_at FROM code_requests WHERE user_id = ? AND purpose = ? AND created_at > ? ORDER BY created_at DESC')
    .all(userId, purpose, now - 15 * 60 * 1000));
  if (recent.length >= 5 || (recent[0] && now - recent[0].created_at < 60 * 1000)) return null;
  const id = newId();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  (await db.prepare('INSERT INTO code_requests (user_id, purpose, created_at) VALUES (?, ?, ?)').run(userId, purpose, now));
  (await db.prepare(`INSERT INTO account_codes (id, user_id, purpose, stage, target_email, code_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, purpose) DO UPDATE SET id=excluded.id, stage=excluded.stage,
      target_email=excluded.target_email, code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0`)
    .run(id, userId, purpose, stage, targetEmail, codeHash(id, code), new Date(now + CODE_LIFETIME_MS).toISOString()));
  return { id, code };
}

async function checkCode(userId, purpose, stage, submitted) {
  const row = (await db.prepare('SELECT * FROM account_codes WHERE user_id = ? AND purpose = ? AND stage = ?')
    .get(userId, purpose, stage));
  if (!row || row.expires_at <= nowIso() || row.attempts >= 5) return null;
  if (!/^\d{6}$/.test(String(submitted || '')) || !safeEqual(row.code_hash, codeHash(row.id, submitted))) {
    (await db.prepare('UPDATE account_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id));
    return null;
  }
  return row;
}

function invalidCode(res) {
  return res.status(400).json({ error: 'The code is invalid, expired or has too many attempts. Request a new code.' });
}

function updateSession(req, res, next, user) {
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, authVersion: user.auth_version };
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.json({ user: req.session.user, token: req.session.csrfToken });
  });
}

app.patch('/api/account/profile', requireAuth, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Enter a name between 2 and 100 characters.' });
  (await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.session.user.id));
  req.session.user.name = name;
  res.json({ user: req.session.user });
}));

app.post('/api/account/password', requireAuth, codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const password = String(req.body.newPassword || '');
    if (!validNewPassword(password) || password !== String(req.body.confirmPassword || '')) {
      return res.status(400).json({ error: 'New passwords must match and contain at least 12 characters and no more than 72 UTF-8 bytes.' });
    }
    const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id));
    if (!await bcrypt.compare(currentPassword, user.password_hash)) return res.status(400).json({ error: 'Your current password is incorrect.' });
    const hash = await bcrypt.hash(password, 12);
    const updatedUser = (await db.transaction(async () => {
      const updated = (await db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?')
        .run(hash, user.id, user.auth_version));
      if (!updated.changes) throw Object.assign(new Error('Your account changed. Sign in and try again.'), { status: 409 });
      (await db.prepare('DELETE FROM account_codes WHERE user_id = ?').run(user.id));
      return (await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
    })());
    updateSession(req, res, next, updatedUser);
  } catch (error) { next(error); }
}));

app.post('/api/auth/password-reset/request', codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    mailTransport();
    const user = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email));
    const issued = user ? (await db.transaction(async () => (await createCode(user.id, 'reset', 'reset')))()) : null;
    res.json({ message: 'If an account exists and email delivery is available, a code will be sent. Check your inbox and spam folder; wait a minute before requesting another.' });
    if (issued) sendTemplate(email, 'password_reset', { code: issued.code }).catch(async error => {
      console.error('Password reset email failed:', error);
      try {
        await db.prepare('DELETE FROM account_codes WHERE id = ?').run(issued.id);
      } catch (cleanupError) {
        console.error('Password reset code cleanup failed:', cleanupError);
      }
    });
  } catch (error) {
    if (error.message.startsWith('Email notifications are unavailable')) error.status = 503;
    next(error);
  }
}));

app.post('/api/auth/password-reset/confirm', codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.newPassword || '');
    if (!validEmail(email) || !validNewPassword(password) || password !== String(req.body.confirmPassword || '')) {
      return res.status(400).json({ error: 'Enter a valid email and matching new passwords of at least 12 characters and no more than 72 UTF-8 bytes.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const success = (await db.transaction(async () => {
      const user = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email));
      if (!user || !(await checkCode(user.id, 'reset', 'reset', req.body.code))) return false;
      (await db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?').run(hash, user.id));
      (await db.prepare('DELETE FROM account_codes WHERE user_id = ?').run(user.id));
      return true;
    })());
    if (!success) return invalidCode(res);
    res.json({ message: 'Password reset. You can now sign in with your new password.' });
  } catch (error) { next(error); }
}));

app.post('/api/account/email/request', requireAuth, codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const target = normalizeEmail(req.body.newEmail);
    const user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id));
    if (!validEmail(target) || target === user.email) return res.status(400).json({ error: 'Enter a different valid email address.' });
    if (!await bcrypt.compare(String(req.body.currentPassword || ''), user.password_hash)) return res.status(400).json({ error: 'Your current password is incorrect.' });
    if ((await db.prepare('SELECT id FROM users WHERE email = ?').get(target))) return res.status(409).json({ error: 'An account with that email already exists.' });
    const issued = (await db.transaction(async () => {
      const current = (await db.prepare('SELECT auth_version FROM users WHERE id = ?').get(user.id));
      if (!current || current.auth_version !== user.auth_version) {
        throw Object.assign(new Error('Your account changed. Sign in and try again.'), { status: 409 });
      }
      return (await createCode(user.id, 'email', 'old', target));
    })());
    if (!issued) return res.status(429).json({ error: 'Please wait before requesting another code.' });
    try { await sendTemplate(user.email, 'email_change_old', { code: issued.code }); }
    catch (error) {
      (await db.prepare('DELETE FROM account_codes WHERE id = ?').run(issued.id));
      console.error('Current email verification failed:', error);
      return res.status(503).json({ error: 'Could not send the verification code. Please try again later.' });
    }
    res.json({ message: 'A verification code was sent to your current email address.' });
  } catch (error) { next(error); }
}));

app.post('/api/account/email/verify-old', requireAuth, codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const issued = (await db.transaction(async () => {
      const row = (await checkCode(req.session.user.id, 'email', 'old', req.body.code));
      if (!row) return null;
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const hash = codeHash(row.id, code);
      (await db.prepare("UPDATE account_codes SET stage = 'new', code_hash = ?, attempts = 0, expires_at = ? WHERE id = ?")
        .run(hash, new Date(Date.now() + CODE_LIFETIME_MS).toISOString(), row.id));
      return { id: row.id, target: row.target_email, code, hash };
    })());
    if (!issued) return invalidCode(res);
    try { await sendTemplate(issued.target, 'email_change_new', { code: issued.code }); }
    catch (error) {
      (await db.prepare('DELETE FROM account_codes WHERE id = ? AND code_hash = ?').run(issued.id, issued.hash));
      console.error('New email verification failed:', error);
      return res.status(503).json({ error: 'Could not send the code to your new email. Start the email change again later.' });
    }
    res.json({ message: 'A verification code was sent to your new email address.' });
  } catch (error) { next(error); }
}));

app.post('/api/account/email/verify-new', requireAuth, codeLimiter, asyncHandler(async (req, res, next) => {
  try {
    const user = (await db.transaction(async () => {
      const row = (await checkCode(req.session.user.id, 'email', 'new', req.body.code));
      if (!row) return null;
      (await db.prepare('UPDATE users SET email = ?, auth_version = auth_version + 1 WHERE id = ?').run(row.target_email, row.user_id));
      (await db.prepare('DELETE FROM account_codes WHERE user_id = ?').run(row.user_id));
      return (await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id));
    })());
    if (!user) return invalidCode(res);
    updateSession(req, res, next, user);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    next(error);
  }
}));

app.get('/api/admin/email-previews', requireAuth, requireAdmin, (req, res) => {
  res.json({ templates: Object.entries(templateNames).map(([id, name]) => ({ id, name })) });
});
app.get('/api/admin/email-previews/:type', requireAuth, requireAdmin, (req, res) => {
  if (!Object.hasOwn(templateNames, req.params.type)) return res.status(404).json({ error: 'Email template not found.' });
  res.json({ ...previewEmail(req.params.type), name: templateNames[req.params.type] });
});

app.get('/api/cars', asyncHandler(async (req, res) => {
  const rows = (await db.prepare("SELECT * FROM cars WHERE status != 'sold' ORDER BY created_at DESC").all());
  res.json({ cars: rows.map(publicCar) });
}));

app.get('/api/cars/:id', asyncHandler(async (req, res) => {
  const row = (await db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id));
  if (!row || row.status === 'sold') return res.status(404).json({ error: 'This vehicle is no longer available.' });
  res.json({ car: publicCar(row) });
}));

let ratesCache = null;
async function getRates() {
  if (ratesCache && ratesCache.expires > Date.now()) return ratesCache.data;
  const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Exchange-rate service returned HTTP ${response.status}.`);
  const data = await response.json();
  if (data.result !== 'success' || !data.rates || data.rates.USD !== 1) {
    throw new Error('Exchange-rate service returned an invalid response.');
  }
  ratesCache = {
    expires: Date.now() + 60 * 60 * 1000,
    data: { base: 'USD', updatedAt: data.time_last_update_utc, rates: data.rates }
  };
  return ratesCache.data;
}

app.get('/api/rates', async (req, res, next) => {
  try {
    res.json(await getRates());
  } catch (error) {
    next(error);
  }
});

async function validatePromos(codes, cars) {
  if (!Array.isArray(codes) || codes.length > 2 || codes.some(code => typeof code !== 'string' || !code.trim() || code.trim().length > 30)) {
    throw Object.assign(new Error('Enter up to two valid promo codes.'), { status: 400 });
  }
  const normalized = codes.map(code => code.trim().toUpperCase());
  if (new Set(normalized).size !== normalized.length) {
    throw Object.assign(new Error('Each promo code can only be used once.'), { status: 400 });
  }
  const remaining = cars.map(car => Math.round(car.price_usd * car.quantity * 100));
  const results = [];
  for (const code of normalized) {
    const promo = (await db.prepare('SELECT * FROM promos WHERE lower(code) = lower(?) FOR UPDATE').get(code));
    if (!promo || !promo.active || (promo.uses_limit !== null && promo.uses_count >= promo.uses_limit) ||
      (promo.expires_at && promo.expires_at <= nowIso())) {
      throw Object.assign(new Error(`Promo code ${code} is invalid, expired or no longer available.`), { status: 400 });
    }
    const brands = JSON.parse(promo.brands);
    const eligible = cars.map((car, index) => ({ index, original: Math.round(car.price_usd * car.quantity * 100) }))
      .filter(({ index }) => !brands.length || brands.some(brand => brand.toLocaleLowerCase('en-US') === cars[index].make.trim().toLocaleLowerCase('en-US')));
    if (!eligible.length) throw Object.assign(new Error(`Promo code ${code} does not apply to the selected brands.`), { status: 400 });
    const original = eligible.reduce((sum, item) => sum + item.original, 0);
    const available = eligible.reduce((sum, item) => sum + remaining[item.index], 0);
    const requested = promo.kind === 'percent' ? Math.round(original * promo.amount / 100) : Math.round(promo.amount * 100);
    const discount = Math.min(available, requested);
    if (discount <= 0) throw Object.assign(new Error(`Promo code ${code} has no remaining eligible amount to discount.`), { status: 400 });
    let allocated = 0;
    const shares = eligible.map(item => {
      const exact = discount * remaining[item.index] / available;
      const cents = Math.floor(exact);
      allocated += cents;
      return { index: item.index, cents, fraction: exact - cents };
    }).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let i = 0; i < discount - allocated; i++) shares[i].cents++;
    for (const share of shares) remaining[share.index] -= share.cents;
    results.push({ promo, discountUsd: discount / 100 });
  }
  return { results, discountUsd: results.reduce((sum, item) => sum + Math.round(item.discountUsd * 100), 0) / 100 };
}

function selectedItems(body) {
  const items = Array.isArray(body.items) ? body.items :
    Array.isArray(body.carIds) ? [...new Set(body.carIds.map(String))].map(carId => ({ carId, quantity: 1 })) : [];
  if (!items.length || items.length > 10 || items.some(item => !item || typeof item.carId !== 'string' ||
    !item.carId || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) ||
    new Set(items.map(item => item.carId)).size !== items.length ||
    items.reduce((sum, item) => sum + item.quantity, 0) > 10) {
    throw Object.assign(new Error('Select between 1 and 10 vehicles with valid quantities.'), { status: 400 });
  }
  return items;
}

async function availableSelection(items) {
  const cars = (await db.prepare(`SELECT * FROM cars WHERE id IN (${items.map(() => '?').join(',')})`)
    .all(...items.map(item => item.carId)));
  const byId = new Map(cars.map(car => [car.id, car]));
  return items.map(item => {
    const car = byId.get(item.carId);
    if (!car || car.available_stock < item.quantity) {
      throw Object.assign(new Error('One or more selected vehicles no longer have enough available stock. Update your saved cars and try again.'), { status: 409 });
    }
    return { ...car, quantity: item.quantity };
  });
}

function selectionSubtotal(cars) {
  return cars.reduce((sum, car) => sum + Math.round(car.price_usd * car.quantity * 100), 0) / 100;
}

app.get('/api/promos/featured', asyncHandler(async (req, res) => {
  const promo = (await db.prepare(`SELECT code, kind, amount, description, expires_at, brands FROM promos
    WHERE pinned = 1 AND active = 1 AND (uses_limit IS NULL OR uses_count < uses_limit)
      AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`).get(nowIso()));
  res.json({
    promo: promo ? {
      code: promo.code, kind: promo.kind, amount: promo.amount,
      description: promo.description, expiresAt: promo.expires_at,
      ...(JSON.parse(promo.brands).length ? { brands: JSON.parse(promo.brands) } : {})
    } : null
  });
}));

app.post('/api/promos/validate', requireAuth, asyncHandler(async (req, res, next) => {
  try {
    const cars = (await availableSelection(selectedItems(req.body)));
    const subtotalUsd = selectionSubtotal(cars);
    const codes = req.body.codes === undefined ? [req.body.code] : req.body.codes;
    if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ error: 'Enter a promo code.' });
    const { results, discountUsd } = (await validatePromos(codes, cars));
    const promos = results.map(({ promo, discountUsd: discount }) => ({ code: promo.code, kind: promo.kind, amount: promo.amount, description: promo.description, discountUsd: discount, brands: JSON.parse(promo.brands) }));
    const totalUsd = Math.round(Math.max(0, subtotalUsd - discountUsd) * 100) / 100;
    if (req.body.codes === undefined) {
      const { code, kind, amount, description } = promos[0];
      return res.json({ valid: true, code, kind, amount, description, subtotalUsd, discountUsd, totalUsd });
    }
    res.json({ valid: true, promos, subtotalUsd, discountUsd, totalUsd });
  } catch (error) {
    next(error);
  }
}));

app.get('/api/payment-settings', (req, res) => {
  let cryptoUnavailableReason = '';
  try {
    getCryptoConfig({ id: '00000000-0000-0000-0000-000000000000', total_usd: 1 }, { id: '00000000-0000-0000-0000-000000000000' });
  } catch (error) {
    cryptoUnavailableReason = error.message;
  }
  res.json({
    bankTransferEnabled: true,
    cryptoEnabled: !cryptoUnavailableReason,
    cryptoUnavailableReason,
    cryptoCoin: process.env.GOURL_COIN || 'bitcoin'
  });
});

app.post('/api/orders', requireAuth, orderLimiter, asyncHandler(async (req, res, next) => {
  let orderId;
  let trackingEmailId;
  try {
    const items = selectedItems(req.body);
    const paymentMethod = String(req.body.paymentMethod || '');
    const currency = String(req.body.currency || 'USD').toUpperCase();
    const buyer = req.body.buyer || {};
    if (!['gourl', 'bank'].includes(paymentMethod)) return res.status(400).json({ error: 'Choose a supported payment method.' });
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Choose a valid display currency.' });
    const requiredBuyer = ['name', 'email', 'phone', 'address', 'city', 'country'];
    const buyerDetails = {};
    for (const field of requiredBuyer) {
      const value = String(buyer[field] || '').trim();
      if (!value || value.length > 200) return res.status(400).json({ error: `Enter a valid ${field} for the order.` });
      buyerDetails[field] = value;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerDetails.email)) {
      return res.status(400).json({ error: 'Enter a valid contact email address.' });
    }
    let cryptoPublicKey;
    if (paymentMethod === 'gourl') {
      try {
        cryptoPublicKey = getCryptoConfig({ id: '00000000-0000-0000-0000-000000000000', total_usd: 1 }, req.session.user).publicKey;
      } catch (error) {
        throw Object.assign(error, { status: 503 });
      }
    }

    orderId = newId();
    const createdAt = nowIso();
    const expiresAt = paymentMethod === 'bank' ? null : new Date(Date.now() + ORDER_LIFETIME_MS).toISOString();
    let order;
    const createOrder = db.transaction(async () => {
      const cars = (await availableSelection(items));
      const subtotalUsd = selectionSubtotal(cars);
      const codes = req.body.promoCodes === undefined ? (req.body.promoCode ? [req.body.promoCode] : []) : req.body.promoCodes;
      const { results, discountUsd } = (await validatePromos(codes, cars));
      const totalUsd = Math.round(Math.max(0, subtotalUsd - discountUsd) * 100) / 100;
      if (totalUsd < 0.01 || totalUsd > 1000000) {
        throw Object.assign(new Error('The order total is outside the payment provider limits.'), { status: 400 });
      }
      const paymentDetails = paymentMethod === 'bank'
        ? {}
        : { cryptoCoin: String(process.env.GOURL_COIN || 'bitcoin').toLowerCase(), cryptoPublicKey };
      (await db.prepare(`INSERT INTO orders
        (id, user_id, status, payment_method, currency, subtotal_usd, discount_usd, total_usd, promo_code,
         buyer_details, payment_details, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(orderId, req.session.user.id, paymentMethod === 'bank' ? 'awaiting_bank_assignment' : 'awaiting_payment', paymentMethod, currency, subtotalUsd, discountUsd, totalUsd,
          results[0]?.promo.code || null, JSON.stringify(buyerDetails), JSON.stringify(paymentDetails), createdAt, expiresAt));
      (await db.prepare('INSERT INTO order_tracking (order_id, code) VALUES (?, ?)').run(orderId, newTrackingCode()));
      trackingEmailId = (await queueTrackingEmail(orderId, 'created'));
      if (paymentMethod === 'bank') (await db.prepare("INSERT INTO bank_notifications (order_id, status) VALUES (?, 'pending')").run(orderId));
      const insertItem = db.prepare(`INSERT INTO order_items (order_id, car_id, make, model, year, price_usd, quantity)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const reserve = db.prepare('UPDATE cars SET available_stock = available_stock - ? WHERE id = ? AND available_stock >= ?');
      for (const car of cars) {
        (await insertItem.run(orderId, car.id, car.make, car.model, car.year, car.price_usd, car.quantity));
        if ((await reserve.run(car.quantity, car.id, car.quantity)).changes !== 1) {
          throw Object.assign(new Error('A selected vehicle is no longer available.'), { status: 409 });
        }
        (await refreshCarStatus(car.id));
      }
      for (const [index, { promo, discountUsd: discount }] of results.entries()) {
        (await db.prepare('INSERT INTO order_promos (order_id, position, code, discount_usd) VALUES (?, ?, ?, ?)').run(orderId, index, promo.code, discount));
        const updated = (await db.prepare(`UPDATE promos SET uses_count = uses_count + 1 WHERE id = ?
          AND active = 1 AND (uses_limit IS NULL OR uses_count < uses_limit)
          AND (expires_at IS NULL OR expires_at > ?)`).run(promo.id, nowIso()));
        if (!updated.changes) throw Object.assign(new Error('A promo code is no longer available.'), { status: 409 });
      }
      order = (await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
    });
    (await createOrder());

    if (paymentMethod === 'bank') {
      try {
        const items = (await db.prepare('SELECT make, model, year, quantity FROM order_items WHERE order_id = ?').all(orderId));
        const itemLines = items.map(item => `- ${item.year} ${item.make} ${item.model} x ${item.quantity}`).join('\n');
        await sendTemplate(paymentEmail, 'bank_order', {
          orderId, name: buyerDetails.name, email: buyerDetails.email, phone: buyerDetails.phone,
          address: `${buyerDetails.address}, ${buyerDetails.city}, ${buyerDetails.country}`,
          items: itemLines, total: order.total_usd, currency
        });
        (await db.prepare("UPDATE bank_notifications SET status = 'sent' WHERE order_id = ?").run(orderId));
      } catch (error) {
        (await db.prepare("UPDATE bank_notifications SET status = 'failed' WHERE order_id = ?").run(orderId));
        console.error('Bank-transfer order notification failed:', error);
      }
    }

    let cryptoBox;
    if (paymentMethod === 'gourl') {
      try {
        cryptoBox = getCryptoConfig(order, req.session.user);
      } catch (error) {
        (await db.transaction(async () => {
          (await db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId));
          (await finishInventory(orderId, true));
        })());
        throw Object.assign(error, { status: 503 });
      }
    }
    await deliverTrackingEmail(trackingEmailId);
    const orderItems = (await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId));
    res.status(201).json({ order: (await orderResult(order, orderItems, true)), cryptoBox: cryptoBox || null });
  } catch (error) {
    next(error);
  }
}));

app.get('/api/tracking', trackingLimiter, asyncHandler(async (req, res) => {
  const code = String(req.get('x-tracking-code') || '').trim().toUpperCase();
  if (!/^TX-[A-F0-9]{32}$/.test(code)) return res.status(404).json({ error: 'Tracking code not found.' });
  const order = (await db.prepare(`SELECT o.status, o.created_at, t.shipment_status FROM order_tracking t
    JOIN orders o ON o.id = t.order_id WHERE t.code = ?`).get(code));
  if (!order) return res.status(404).json({ error: 'Tracking code not found.' });
  const events = (await db.prepare(`SELECT status, created_at FROM shipment_events
    WHERE order_id = (SELECT order_id FROM order_tracking WHERE code = ?)
    ORDER BY id DESC LIMIT 100`).all(code)).reverse().map(event => ({ status: event.status, createdAt: event.created_at }));
  const status = ['cancelled', 'expired'].includes(order.status) ? order.status :
    order.shipment_status || (order.status === 'paid' ? 'awaiting_shipment' : 'order_received');
  res.json({ status, createdAt: order.created_at, events });
}));

app.get('/api/orders', requireAuth, asyncHandler(async (req, res) => {
  const orders = (await db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.session.user.id));
  res.json({
    orders: await Promise.all(orders.map(async order => (await orderResult(order, (await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)), true))))
  });
}));

app.get('/api/orders/:id', requireAuth, asyncHandler(async (req, res) => {
  const order = (await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const items = (await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id));
  res.json({ order: (await orderResult(order, items, true)) });
}));

app.get('/api/orders/:id/crypto-box', requireAuth, asyncHandler(async (req, res, next) => {
  const order = (await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND payment_method = ?')
    .get(req.params.id, req.session.user.id, 'gourl'));
  if (!order) return res.status(404).json({ error: 'Crypto order not found.' });
  if (order.status !== 'awaiting_payment' || !order.expires_at || order.expires_at <= nowIso()) {
    return res.status(409).json({ error: 'This order is no longer awaiting payment. Do not send funds.' });
  }
  const details = JSON.parse(order.payment_details);
  if (!details.cryptoPublicKey || details.cryptoPublicKey !== process.env.GOURL_PUBLIC_KEY) {
    return res.status(409).json({ error: 'This payment box cannot be safely reopened. Contact the dealership and do not send funds.' });
  }
  try {
    const cryptoBox = getCryptoConfig(order, req.session.user);
    const items = (await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id));
    res.set('Cache-Control', 'no-store').json({ order: (await orderResult(order, items, true)), cryptoBox });
  } catch (error) {
    next(Object.assign(error, { status: 503 }));
  }
}));

app.post('/api/orders/:id/payment-claim', requireAuth, orderLimiter, asyncHandler(async (req, res) => {
  const order = (await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND payment_method = ?')
    .get(req.params.id, req.session.user.id, 'bank'));
  if (!order) return res.status(404).json({ error: 'Bank order not found.' });
  if (order.status === 'payment_claimed') {
    const proof = (await db.prepare('SELECT available_at FROM payment_proofs WHERE order_id = ?').get(order.id));
    return res.json({ proofAvailableAt: proof.available_at });
  }
  if (order.status !== 'awaiting_payment' || !order.expires_at || order.expires_at <= nowIso() || !JSON.parse(order.payment_details).bankDetails) {
    return res.status(409).json({ error: 'This order is not awaiting a bank payment.' });
  }
  const availableAt = new Date(Date.now() + 60 * 1000).toISOString();
  (await db.transaction(async () => {
    const updated = (await db.prepare("UPDATE orders SET status = 'payment_claimed' WHERE id = ? AND status = 'awaiting_payment' AND expires_at > ?")
      .run(order.id, nowIso()));
    if (!updated.changes) throw Object.assign(new Error('This order is no longer awaiting a bank payment.'), { status: 409 });
    (await db.prepare('INSERT INTO payment_proofs (order_id, available_at) VALUES (?, ?)').run(order.id, availableAt));
  })());
  res.json({ proofAvailableAt: availableAt });
}));

app.post('/api/orders/:id/payment-proof', requireAuth, orderLimiter,
  express.raw({ type: 'application/octet-stream', limit: '5mb' }), asyncHandler(async (req, res) => {
    const order = (await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND payment_method = ?')
      .get(req.params.id, req.session.user.id, 'bank'));
    if (!order) return res.status(404).json({ error: 'Bank order not found.' });
    const proof = (await db.prepare('SELECT * FROM payment_proofs WHERE order_id = ?').get(order.id));
    if (order.status !== 'payment_claimed' || !proof) return res.status(409).json({ error: 'This order is not waiting for payment proof.' });
    if (proof.available_at > nowIso()) return res.status(409).json({ error: 'Please wait until the proof upload is available.' });
    const bytes = req.body;
    const type = String(req.get('x-proof-type') || '');
    const signatures = {
      'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
      'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'application/pdf': Buffer.from('%PDF-')
    };
    const signature = signatures[type];
    if (!Buffer.isBuffer(bytes) || !signature || bytes.length < signature.length ||
      !bytes.subarray(0, signature.length).equals(signature)) {
      return res.status(400).json({ error: 'Upload a JPEG, PNG or PDF payment proof, up to 5 MB.' });
    }
    (await db.transaction(async () => {
      const updated = await db.prepare("UPDATE orders SET status = 'proof_submitted' WHERE id = ? AND status = 'payment_claimed'").run(order.id);
      if (!updated.changes) throw Object.assign(new Error('This order is not waiting for payment proof.'), { status: 409 });
      (await db.prepare('UPDATE payment_proofs SET content_type = ?, contents = ?, uploaded_at = ? WHERE order_id = ?')
        .run(type, bytes, nowIso(), order.id));
    })());
    res.status(201).json({ ok: true });
  }));

app.get('/api/gourl/ipn', (req, res) => {
  res.type('text').send('Only POST Data Allowed');
});

app.post('/api/gourl/ipn', asyncHandler(async (req, res) => {
  const secret = process.env.GOURL_PRIVATE_KEY || '';
  if (!secret) return res.status(503).type('text').send('Crypto payments are not configured.');
  const expectedHash = crypto.createHash('sha512').update(secret).digest('hex');
  if (!safeEqual(String(req.body.private_key_hash || '').toLowerCase(), expectedHash)) {
    return res.status(403).type('text').send('Invalid payment notification.');
  }
  if (req.body.status === 'payment_received_unrecognised') {
    return res.type('text').send('cryptobox_nochanges');
  }
  if (req.body.status !== 'payment_received') {
    return res.status(400).type('text').send('Invalid payment status.');
  }
  const order = (await db.prepare('SELECT * FROM orders WHERE id = ? AND payment_method = ?')
    .get(String(req.body.order || ''), 'gourl'));
  if (!order || String(req.body.user || '') !== `u${order.user_id.replaceAll('-', '')}`) {
    return res.status(404).type('text').send('Order not found.');
  }
  if (req.body.status === 'payment_received' && Number(req.body.confirmed) === 1) {
    const updated = (await db.transaction(async () => {
      const result = (await db.prepare("UPDATE orders SET status = 'paid' WHERE id = ? AND status IN ('awaiting_payment', 'payment_received')").run(order.id));
      if (!result.changes) return false;
      (await finishInventory(order.id, false));
      return true;
    })());
    if (!updated) return res.type('text').send('cryptobox_nochanges');
  } else {
    const updated = (await db.prepare("UPDATE orders SET status = 'payment_received' WHERE id = ? AND status = 'awaiting_payment'").run(order.id));
    if (!updated.changes) return res.type('text').send('cryptobox_nochanges');
  }
  res.type('text').send('cryptobox_updated');
}));

app.get('/api/admin/summary', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const counts = (await db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(available_stock), 0) FROM cars) AS cars_available,
      (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.status IN ('awaiting_bank_assignment', 'awaiting_payment', 'payment_received', 'payment_claimed', 'proof_submitted')) AS cars_reserved,
      (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'paid') AS cars_sold,
      (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers,
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COUNT(*) FROM orders WHERE status IN ('awaiting_bank_assignment', 'awaiting_payment', 'payment_received', 'payment_claimed', 'proof_submitted')) AS pending_orders,
      (SELECT COALESCE(SUM(total_usd), 0) FROM orders WHERE status = 'paid') AS revenue_usd,
      (SELECT COUNT(*) FROM orders WHERE status = 'paid') AS paid_orders
  `).get());
  const payments = (await db.prepare("SELECT payment_method AS method, status, COUNT(*) AS count, COALESCE(SUM(total_usd), 0) AS total_usd FROM orders GROUP BY payment_method, status ORDER BY payment_method, status").all());
  const recentOrders = (await db.prepare(`
    SELECT o.*, u.name AS customer_name, u.email AS customer_email
    FROM orders o JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC LIMIT 10
  `).all());
  res.json({
    counts,
    payments,
    recentOrders: recentOrders.map(order => ({
      id: order.id, status: order.status, paymentMethod: order.payment_method,
      totalUsd: order.total_usd, createdAt: order.created_at, expiresAt: order.expires_at,
      customerName: order.customer_name, customerEmail: order.customer_email
    }))
  });
}));

app.get('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const search = String(req.query.search || '').trim();
  const page = Number(req.query.page || 1);
  if (search.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 100000) {
    return res.status(400).json({ error: 'Enter a valid search and page.' });
  }
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const where = "WHERE u.name ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\'";
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(pattern, pattern)).count;
  const users = (await db.prepare(`SELECT u.id, u.name, u.email, u.role, u.email_verified, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
      (SELECT COALESCE(SUM(o.total_usd), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_total
    FROM users u ${where} ORDER BY u.created_at DESC, u.id LIMIT 50 OFFSET ?`).all(pattern, pattern, (page - 1) * 50));
  res.json({ users, page, total, pageSize: 50 });
}));

app.get('/api/admin/cars', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ cars: (await db.prepare('SELECT * FROM cars ORDER BY created_at DESC').all()).map(publicCar) });
}));

function cleanCarInput(body) {
  const car = {
    make: String(body.make || '').trim(),
    model: String(body.model || '').trim(),
    year: Number(body.year),
    priceUsd: Number(body.priceUsd),
    mileage: Number(body.mileage || 0),
    transmission: String(body.transmission || 'Automatic').trim(),
    bodyType: String(body.bodyType || 'Sedan').trim(),
    description: String(body.description || '').trim(),
    imageUrl: String(body.imageUrl || '').trim(),
    availableStock: body.availableStock === undefined ? 1 : Number(body.availableStock)
  };
  if (!car.make || car.make.length > 80 || !car.model || car.model.length > 100 ||
    !Number.isInteger(car.year) || car.year < 1900 || car.year > new Date().getFullYear() + 2 ||
    !Number.isFinite(car.priceUsd) || car.priceUsd < 1 || car.priceUsd > 10000000 ||
    !Number.isInteger(car.mileage) || car.mileage < 0 || car.mileage > 2000000 ||
    !['Automatic', 'Manual', 'CVT', 'Other'].includes(car.transmission) ||
    !['Sedan', 'SUV', 'Coupe', 'Convertible', 'Hatchback', 'Wagon', 'Truck', 'Other'].includes(car.bodyType) ||
    car.description.length > 4000 || car.imageUrl.length > 1000 ||
    !Number.isInteger(car.availableStock) || car.availableStock < 0 || car.availableStock > 100000 ||
    (car.imageUrl && !/^https?:\/\//i.test(car.imageUrl) && !/^\/assets\//.test(car.imageUrl))) {
    throw Object.assign(new Error('Enter valid vehicle details, including a positive price and supported image URL.'), { status: 400 });
  }
  return car;
}

app.post('/api/admin/cars', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const car = cleanCarInput(req.body);
    const id = newId();
    (await db.prepare(`INSERT INTO cars
      (id, make, model, year, price_usd, mileage, transmission, body_type, description, image_url, available_stock, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, car.make, car.model, car.year, car.priceUsd, car.mileage, car.transmission, car.bodyType, car.description, car.imageUrl, car.availableStock, car.availableStock ? 'available' : 'out_of_stock', nowIso()));
    res.status(201).json({ car: publicCar((await db.prepare('SELECT * FROM cars WHERE id = ?').get(id))) });
  } catch (error) {
    next(error);
  }
}));

app.put('/api/admin/cars/:id', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const car = cleanCarInput(req.body);
    const existing = (await db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Vehicle not found.' });
    if (req.body.availableStock !== undefined &&
      (!Number.isInteger(req.body.expectedAvailableStock) || req.body.expectedAvailableStock !== existing.available_stock)) {
      return res.status(409).json({ error: 'Available stock changed. Refresh the vehicle list before editing.' });
    }
    if (req.body.availableStock === undefined) car.availableStock = existing.available_stock;
    (await db.transaction(async () => {
      const updated = (await db.prepare(`UPDATE cars SET make = ?, model = ?, year = ?, price_usd = ?, mileage = ?, transmission = ?,
        body_type = ?, description = ?, image_url = ?, available_stock = ? WHERE id = ? AND available_stock = ?`)
        .run(car.make, car.model, car.year, car.priceUsd, car.mileage, car.transmission, car.bodyType,
          car.description, car.imageUrl, car.availableStock, req.params.id, existing.available_stock));
      if (!updated.changes) throw Object.assign(new Error('Available stock changed. Refresh the vehicle list before editing.'), { status: 409 });
      (await refreshCarStatus(req.params.id));
    })());
    res.json({ car: publicCar((await db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id))) });
  } catch (error) {
    next(error);
  }
}));

app.delete('/api/admin/cars/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const result = await db.transaction(async () => db.prepare("DELETE FROM cars WHERE id = ? AND status IN ('available', 'out_of_stock') AND id NOT IN (SELECT car_id FROM order_items)")
    .run(req.params.id))();
  if (!result.changes) return res.status(409).json({ error: 'This vehicle cannot be deleted because it is reserved, sold or linked to an order.' });
  res.json({ ok: true });
}));

app.get('/api/admin/orders', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const orders = (await db.prepare(`
    SELECT o.*, u.name AS customer_name, u.email AS customer_email
    FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 300
  `).all());
  res.json({
    orders: await Promise.all(orders.map(async order => ({
      ...(await orderResult(order, (await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)), true)),
      customerName: order.customer_name,
      customerEmail: order.customer_email,
      buyer: JSON.parse(order.buyer_details),
      notificationStatus: (await db.prepare('SELECT status FROM bank_notifications WHERE order_id = ?').get(order.id))?.status || null
    })))
  });
}));

app.patch('/api/admin/orders/:id/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const status = String(req.body.status || '');
  if (!['paid', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Choose paid or cancelled.' });
  const order = (await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!['awaiting_bank_assignment', 'awaiting_payment', 'payment_received', 'payment_claimed', 'proof_submitted'].includes(order.status) ||
    (status === 'paid' && order.status === 'awaiting_bank_assignment')) {
    return res.status(409).json({ error: 'Only pending orders can be updated.' });
  }
  (await db.transaction(async () => {
    const updated = (await db.prepare(`UPDATE orders SET status = ? WHERE id = ? AND status = ?`).run(status, order.id, order.status));
    if (!updated.changes) throw Object.assign(new Error('The order changed. Refresh and try again.'), { status: 409 });
    (await finishInventory(order.id, status === 'cancelled'));
  })());
  res.json({ ok: true });
}));

app.patch('/api/admin/orders/:id/shipment', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!Object.hasOwn(shipmentLabels, status)) return res.status(400).json({ error: 'Choose a valid shipment stage.' });
    const emailId = (await db.transaction(async () => {
      const order = (await db.prepare(`SELECT o.status, t.shipment_status FROM orders o
        JOIN order_tracking t ON t.order_id = o.id WHERE o.id = ?`).get(req.params.id));
      if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (order.status !== 'paid') throw Object.assign(new Error('Shipment updates are available only after payment is confirmed.'), { status: 409 });
      if (order.shipment_status === status) throw Object.assign(new Error('This is already the current shipment stage.'), { status: 409 });
      const eventAt = nowIso();
      (await db.prepare('UPDATE order_tracking SET shipment_status = ? WHERE order_id = ?').run(status, req.params.id));
      (await db.prepare('INSERT INTO shipment_events (order_id, status, created_at) VALUES (?, ?, ?)').run(req.params.id, status, eventAt));
      return (await queueTrackingEmail(req.params.id, 'shipment', status, eventAt));
    })());
    const emailStatus = await deliverTrackingEmail(emailId);
    res.json({ ok: true, emailStatus });
  } catch (error) { next(error); }
}));

app.post('/api/admin/orders/:id/tracking-email', requireAuth, requireAdmin, trackingMailLimiter, asyncHandler(async (req, res, next) => {
  try {
    const tracking = (await db.prepare('SELECT shipment_status FROM order_tracking WHERE order_id = ?').get(req.params.id));
    if (!tracking) return res.status(404).json({ error: 'Order not found.' });
    const kind = tracking.shipment_status ? 'shipment' : 'created';
    const event = tracking.shipment_status
      ? (await db.prepare('SELECT created_at FROM shipment_events WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(req.params.id))
      : null;
    if (tracking.shipment_status && !event) throw new Error('Shipment event history is missing.');
    const emailId = (await queueTrackingEmail(req.params.id, kind, tracking.shipment_status, event?.created_at || null));
    const emailStatus = await deliverTrackingEmail(emailId);
    if (emailStatus !== 'sent') return res.status(503).json({ error: 'Tracking email could not be sent. Check SMTP and PUBLIC_BASE_URL; the tracking link is still available in the order.' });
    res.json({ ok: true, emailStatus });
  } catch (error) { next(error); }
}));

const bankResult = row => ({
  id: row.id, bankName: row.bank_name, accountName: row.account_name, accountNumber: row.account_number,
  routingNumber: row.routing_number, swiftCode: row.swift_code, instructions: row.instructions, currency: row.currency
});

function cleanBank(body) {
  const details = {
    bankName: String(body.bankName || '').trim(),
    accountName: String(body.accountName || '').trim(),
    accountNumber: String(body.accountNumber || '').trim(),
    routingNumber: String(body.routingNumber || '').trim(),
    swiftCode: String(body.swiftCode || '').trim(),
    instructions: String(body.instructions || '').trim(),
    currency: String(body.currency || '').trim().toUpperCase()
  };
  if (!details.bankName || !details.accountName || !details.accountNumber ||
    Object.values(details).some(value => value.length > 500) || !/^[A-Z]{3}$/.test(details.currency)) {
    throw Object.assign(new Error('Enter bank details and a three-letter currency code.'), { status: 400 });
  }
  return details;
}

app.get('/api/admin/banks', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ banks: (await db.prepare('SELECT * FROM bank_accounts ORDER BY bank_name, account_name').all()).map(bankResult) });
}));

app.post('/api/admin/banks', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const bank = cleanBank(req.body);
    const id = newId();
    (await db.prepare(`INSERT INTO bank_accounts (id, bank_name, account_name, account_number, routing_number, swift_code, instructions, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, bank.bankName, bank.accountName, bank.accountNumber,
      bank.routingNumber, bank.swiftCode, bank.instructions, bank.currency, nowIso()));
    res.status(201).json({ bank: bankResult((await db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id))) });
  } catch (error) { next(error); }
}));

app.put('/api/admin/banks/:id', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const bank = cleanBank(req.body);
    const result = (await db.transaction(async () => {
      const updated = (await db.prepare(`UPDATE bank_accounts SET bank_name = ?, account_name = ?, account_number = ?,
        routing_number = ?, swift_code = ?, instructions = ?, currency = ? WHERE id = ?`)
        .run(bank.bankName, bank.accountName, bank.accountNumber, bank.routingNumber, bank.swiftCode, bank.instructions, bank.currency, req.params.id));
      if (updated.changes && req.params.id === 'legacy-bank-account') {
        (await db.prepare(`INSERT INTO settings (key, value) VALUES ('bank_details', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(bank)));
      }
      return updated;
    })());
    if (!result.changes) return res.status(404).json({ error: 'Bank account not found.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
}));

app.delete('/api/admin/banks/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const result = (await db.transaction(async () => {
    const deleted = (await db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(req.params.id));
    if (deleted.changes && req.params.id === 'legacy-bank-account') (await db.prepare("DELETE FROM settings WHERE key = 'bank_details'").run());
    return deleted;
  })());
  if (!result.changes) return res.status(404).json({ error: 'Bank account not found.' });
  res.json({ ok: true });
}));

app.post('/api/admin/orders/:id/assign-bank', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const bank = (await db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(String(req.body.bankId || '')));
    if (!bank || !bank.currency) return res.status(400).json({ error: 'Choose a bank account with a configured currency.' });
    let rate = 1;
    let rateUpdatedAt = nowIso();
    if (bank.currency !== 'USD') {
      let rates;
      try {
        rates = await getRates();
      } catch (error) {
        console.error('Could not load exchange rate for bank assignment:', error);
        return res.status(503).json({ error: 'Could not load the exchange rate. Try assigning this bank again later.' });
      }
      rate = rates.rates[bank.currency];
      rateUpdatedAt = rates.updatedAt;
      if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: 'No valid exchange rate is available for this bank currency.' });
    }
    const assigned = (await db.transaction(async () => {
      const order = (await db.prepare("SELECT * FROM orders WHERE id = ? AND payment_method = 'bank'").get(req.params.id));
      if (!order) throw Object.assign(new Error('Bank order not found.'), { status: 404 });
      if (order.status !== 'awaiting_bank_assignment') {
        throw Object.assign(new Error('Only orders waiting for bank details can be assigned.'), { status: 409 });
      }
      const currentBank = (await db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bank.id));
      if (!currentBank || currentBank.currency !== bank.currency) {
        throw Object.assign(new Error('The bank account changed. Refresh and assign it again.'), { status: 409 });
      }
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency: currentBank.currency }).resolvedOptions().maximumFractionDigits;
      const scaled = Math.round(order.total_usd * rate * 10 ** digits);
      if (!Number.isSafeInteger(scaled) || scaled <= 0) throw Object.assign(new Error('The converted amount is invalid.'), { status: 400 });
      const details = {
        bankDetails: bankResult(currentBank),
        amount: scaled / 10 ** digits,
        currency: currentBank.currency,
        rate,
        rateUpdatedAt
      };
      const expiresAt = new Date(Date.now() + ORDER_LIFETIME_MS).toISOString();
      (await db.prepare("UPDATE orders SET status = 'awaiting_payment', payment_details = ?, expires_at = ? WHERE id = ?")
        .run(JSON.stringify(details), expiresAt, order.id));
      return { paymentDetails: details, expiresAt };
    })());
    res.json(assigned);
  } catch (error) { next(error); }
}));

app.get('/api/admin/orders/:id/payment-proof', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const proof = (await db.prepare('SELECT content_type, contents FROM payment_proofs WHERE order_id = ? AND uploaded_at IS NOT NULL').get(req.params.id));
  if (!proof) return res.status(404).json({ error: 'Payment proof not found.' });
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
  res.set('Content-Disposition', `attachment; filename="payment-proof.${extensions[proof.content_type]}"`);
  res.type('application/octet-stream').send(proof.contents);
}));

app.get('/api/admin/settings', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ bankDetails: (await jsonSetting('bank_details', {})), contact: (await jsonSetting('contact_details', {})) });
}));

app.put('/api/admin/settings/contact', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const contact = {
    phone: String(req.body.phone || '').trim(),
    address: String(req.body.address || '').trim(),
    hours: String(req.body.hours || '').trim()
  };
  if ((contact.phone && !/^\+[1-9]\d{6,14}$/.test(contact.phone)) ||
    contact.address.length > 300 || contact.hours.length > 300) {
    return res.status(400).json({ error: 'Use an international phone number such as +12025550123 and keep address and hours under 300 characters.' });
  }
  (await db.prepare(`INSERT INTO settings (key, value) VALUES ('contact_details', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(contact)));
  res.json({ contact });
}));

app.get('/api/admin/contact-messages', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ messages: (await db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 300').all()) });
}));

app.patch('/api/admin/contact-messages/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!['new', 'handled'].includes(req.body.status)) return res.status(400).json({ error: 'Choose a valid message status.' });
  const result = (await db.prepare('UPDATE contact_messages SET status = ? WHERE id = ?').run(req.body.status, req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true });
}));

app.get('/api/admin/call-requests', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({
    requests: (await db.prepare(`SELECT id, name, email, phone, preferred_at, timezone, notes, status, created_at
    FROM call_requests ORDER BY created_at DESC LIMIT 300`).all())
  });
}));

app.patch('/api/admin/call-requests/:id', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  if (!['requested', 'confirmed', 'declined'].includes(req.body.status)) {
    return res.status(400).json({ error: 'Choose a valid call request status.' });
  }
  try {
    (await db.transaction(async () => {
      const request = (await db.prepare('SELECT status, preferred_at FROM call_requests WHERE id = ?').get(req.params.id));
      if (!request) throw Object.assign(new Error('Call request not found.'), { status: 404 });
      if (request.status === 'declined' && req.body.status !== 'declined' &&
        !(await callHasCapacity(new Date(request.preferred_at), req.params.id))) {
        throw Object.assign(new Error('That day or time is no longer available.'), { status: 409 });
      }
      (await db.prepare('UPDATE call_requests SET status = ? WHERE id = ?').run(req.body.status, req.params.id));
    })());
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}));

app.put('/api/admin/settings/bank', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const details = {
    accountName: String(req.body.accountName || '').trim(),
    bankName: String(req.body.bankName || '').trim(),
    accountNumber: String(req.body.accountNumber || '').trim(),
    routingNumber: String(req.body.routingNumber || '').trim(),
    swiftCode: String(req.body.swiftCode || '').trim(),
    instructions: String(req.body.instructions || '').trim()
  };
  if (!details.accountName || !details.bankName || !details.accountNumber ||
    Object.values(details).some(value => value.length > 500)) {
    return res.status(400).json({ error: 'Account name, bank name and account number are required; keep all fields under 500 characters.' });
  }
  (await db.transaction(async () => {
    (await db.prepare(`INSERT INTO settings (key, value) VALUES ('bank_details', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(details)));
    (await db.prepare(`INSERT INTO bank_accounts (id, bank_name, account_name, account_number, routing_number, swift_code, instructions, created_at)
      VALUES ('legacy-bank-account', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET bank_name=excluded.bank_name, account_name=excluded.account_name,
        account_number=excluded.account_number, routing_number=excluded.routing_number, swift_code=excluded.swift_code, instructions=excluded.instructions`)
      .run(details.bankName, details.accountName, details.accountNumber, details.routingNumber, details.swiftCode, details.instructions, nowIso()));
  })());
  res.json({ bankDetails: details });
}));

app.get('/api/admin/promos', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const promos = (await db.prepare('SELECT * FROM promos ORDER BY created_at DESC').all()).map(promo => ({
    id: promo.id, code: promo.code, kind: promo.kind, amount: promo.amount,
    description: promo.description, pinned: Boolean(promo.pinned),
    brands: JSON.parse(promo.brands),
    active: Boolean(promo.active), usesLimit: promo.uses_limit, usesCount: promo.uses_count,
    expiresAt: promo.expires_at, createdAt: promo.created_at
  }));
  res.json({ promos });
}));

app.post('/api/admin/promos', requireAuth, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    const kind = String(req.body.kind || '');
    const amount = Number(req.body.amount);
    const description = String(req.body.description || '').trim();
    const brands = req.body.brands === undefined ? [] : req.body.brands;
    const usesLimit = req.body.usesLimit === '' || req.body.usesLimit === null || req.body.usesLimit === undefined
      ? null
      : Number(req.body.usesLimit);
    const expiry = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    if (!/^[A-Z0-9_-]{3,30}$/.test(code) || !['percent', 'fixed'].includes(kind) ||
      !Number.isFinite(amount) || amount <= 0 || (kind === 'percent' && amount > 100) ||
      description.length > 500 || (expiry && !Number.isFinite(expiry.getTime())) ||
      (usesLimit !== null && (!Number.isInteger(usesLimit) || usesLimit < 1)) ||
      !Array.isArray(brands) || brands.length > 100 ||
      brands.some(brand => typeof brand !== 'string' || !brand.trim() || brand.trim().length > 80) ||
      (Array.isArray(brands) && new Set(brands.map(brand => typeof brand === 'string' ? brand.trim().toLocaleLowerCase('en-US') : '')).size !== brands.length)) {
      return res.status(400).json({ error: 'Enter a valid code, discount amount, discount type and optional use limit.' });
    }
    const knownBrands = new Set((await db.prepare('SELECT DISTINCT make FROM cars').all()).map(row => row.make.trim().toLocaleLowerCase('en-US')));
    if (brands.some(brand => !knownBrands.has(brand.trim().toLocaleLowerCase('en-US')))) {
      return res.status(400).json({ error: 'Choose brands from the current vehicle inventory.' });
    }
    const expiresAt = expiry ? expiry.toISOString() : null;
    const id = newId();
    (await db.prepare(`INSERT INTO promos (id, code, kind, amount, uses_limit, expires_at, description, created_at, brands)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, code, kind, amount, usesLimit, expiresAt, description, nowIso(), JSON.stringify(brands.map(brand => brand.trim()))));
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That promo code already exists.' });
    next(error);
  }
}));

app.patch('/api/admin/promos/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (typeof req.body.active !== 'boolean' && typeof req.body.pinned !== 'boolean') {
    return res.status(400).json({ error: 'Choose an active or pinned state.' });
  }
  (await db.transaction(async () => {
    const promo = await db.prepare('SELECT * FROM promos WHERE id = ? FOR UPDATE').get(req.params.id);
    if (!promo) throw Object.assign(new Error('Promo code not found.'), { status: 404 });
    if (req.body.pinned === true && (!promo.active || (promo.uses_limit !== null && promo.uses_count >= promo.uses_limit) ||
      (promo.expires_at && promo.expires_at <= nowIso()) || req.body.active === false)) {
      throw Object.assign(new Error('Only an available promo code can be pinned.'), { status: 400 });
    }
    if (req.body.pinned === true) (await db.prepare('UPDATE promos SET pinned = 0 WHERE pinned = 1').run());
    (await db.prepare('UPDATE promos SET active = ?, pinned = ? WHERE id = ?')
      .run(req.body.active === undefined ? promo.active : Number(req.body.active),
        req.body.active === false ? 0 : req.body.pinned === undefined ? promo.pinned : Number(req.body.pinned), promo.id));
  })());
  res.json({ ok: true });
}));

app.delete('/api/admin/promos/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const result = await db.transaction(async () => db.prepare('DELETE FROM promos WHERE id = ?').run(req.params.id))();
  if (!result.changes) return res.status(404).json({ error: 'Promo code not found.' });
  res.json({ ok: true });
}));

const storefront = path.join(root, 'storefront.html');
const appRoutes = new Set(['/', '/about', '/cars', '/cart', '/checkout', '/login', '/register', '/verify-email', '/account', '/settings', '/reset-password', '/admin', '/contact', '/book-call', '/track']);
app.get(['/', '/about', '/cars', '/cars/:id', '/cart', '/checkout', '/login', '/register', '/verify-email', '/account', '/settings', '/reset-password', '/admin', '/contact', '/book-call', '/track',
  '/index.html', '/shop.html', '/shop-detail.html', '/deal.html', '/deal-detail.html', '/cart.html',
  '/checkout.html', '/login.html', '/register.html', '/contact.html'], (req, res, next) => {
    if (req.path.endsWith('.html')) {
      const aliases = {
        '/index.html': '/',
        '/shop.html': '/cars',
        '/shop-detail.html': '/cars',
        '/deal.html': '/cars',
        '/deal-detail.html': '/cars',
        '/cart.html': '/cart',
        '/checkout.html': '/checkout',
        '/login.html': '/login',
        '/register.html': '/register',
        '/contact.html': '/contact'
      };
      return res.redirect(301, aliases[req.path] || '/');
    }
    if (!appRoutes.has(req.path) && !req.path.startsWith('/cars/')) return next();
    res.sendFile(storefront);
  });
app.get(/\.html$/, (req, res) => res.redirect(301, '/cars'));
app.use('/assets', express.static(path.join(root, 'assets'), { maxAge: '7d', fallthrough: false }));
app.use('/storefront.css', express.static(path.join(root, 'storefront.css'), { maxAge: '1d' }));
app.use('/storefront.js', express.static(path.join(root, 'storefront.js'), { maxAge: '1d' }));
app.use((req, res) => res.status(404).json({ error: 'Page not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === '23505' ? 409 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'The request could not be completed. Please try again.' : error.message });
});

async function start() {
  await initializePostgres(pool);
  await db.transaction(async () => {
    await seedCars();
    await seedAdmin();
  })();
  app.listen(port, () => {
    console.log(`TurqueX car sales app listening on port ${port}`);
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      console.warn('No initial admin is configured. Set ADMIN_EMAIL and ADMIN_PASSWORD before startup.');
    }
  });
  setInterval(async () => {
    try {
      await releaseExpiredOrders();
      await db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      await db.prepare('DELETE FROM account_codes WHERE expires_at <= ?').run(nowIso());
      await db.prepare('DELETE FROM code_requests WHERE created_at <= ?').run(Date.now() - 15 * 60 * 1000);
    } catch (error) {
      console.error('Scheduled database cleanup failed:', error);
    }
  }, 60 * 1000).unref();
}
start().catch(async error => {
  console.error('PostgreSQL application startup failed:', error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
