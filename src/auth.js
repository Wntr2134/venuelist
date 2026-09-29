'use strict';

const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const VENUE_COOKIE = 'vl_session';
const OWNER_COOKIE = 'vl_owner';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function secret(db) {
  let s = getSetting(db, 'session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', s);
  }
  return s;
}

function sign(db, payload) {
  return crypto.createHmac('sha256', secret(db)).update(payload).digest('base64url');
}

function cookieHeader(name, value, maxAge, secure) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// A session is "<fields...>.<issuedAt>.<mac>". Callers check the fields (e.g. password version).
function issue(db, name, fields, secure) {
  const payload = [...fields, Date.now()].join('.');
  return cookieHeader(name, `${payload}.${sign(db, payload)}`, SESSION_DAYS * 86400, secure);
}

function read(db, req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  const mac = raw.slice(i + 1);
  const expected = sign(db, payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const fields = payload.split('.');
  const issued = Number(fields.pop());
  if (!(Date.now() - issued < SESSION_DAYS * 86400 * 1000)) return null;
  return fields;
}

// ----- venue sessions: bound to the venue's password version -----

function venueCookie(db, venue, secure) {
  return issue(db, VENUE_COOKIE, ['v', venue.id, venue.password_version], secure);
}

function venueSession(db, req) {
  const f = read(db, req, VENUE_COOKIE);
  if (!f || f.length !== 3 || f[0] !== 'v') return null;
  return { venueId: Number(f[1]), version: Number(f[2]) };
}

function clearVenueCookie(secure) {
  return cookieHeader(VENUE_COOKIE, '', 0, secure);
}

// ----- owner (platform admin) sessions -----

function ownerVersion(db) {
  return Number(getSetting(db, 'owner_password_version') || 1);
}

function ownerCookie(db, secure) {
  return issue(db, OWNER_COOKIE, ['o', ownerVersion(db)], secure);
}

function isOwner(db, req) {
  if (!getSetting(db, 'owner_password_hash')) return false;
  const f = read(db, req, OWNER_COOKIE);
  return !!f && f.length === 2 && f[0] === 'o' && Number(f[1]) === ownerVersion(db);
}

function clearOwnerCookie(secure) {
  return cookieHeader(OWNER_COOKIE, '', 0, secure);
}

// In-memory limiter that only counts FAILED attempts, so a whole venue logging in
// from the same Wi-Fi (one public IP) never locks itself out.
function createLimiter({ max, windowMs }) {
  const fails = new Map();
  const recent = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < windowMs);
  return {
    blocked(key) {
      const list = recent(key);
      fails.set(key, list);
      return list.length >= max;
    },
    fail(key) {
      const list = recent(key);
      list.push(Date.now());
      fails.set(key, list);
    },
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  venueCookie,
  venueSession,
  clearVenueCookie,
  ownerCookie,
  isOwner,
  clearOwnerCookie,
  createLimiter,
};
