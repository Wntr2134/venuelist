'use strict';

const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const COOKIE = 'vl_session';
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

// Bumped whenever the password changes, which invalidates every existing session.
function passwordVersion(db) {
  return getSetting(db, 'password_version') || '1';
}

function sign(db, payload) {
  return crypto.createHmac('sha256', secret(db)).update(payload).digest('base64url');
}

function createSessionCookie(db, secure) {
  const payload = `${Date.now()}.${passwordVersion(db)}`;
  const value = `${payload}.${sign(db, payload)}`;
  return cookieHeader(value, SESSION_DAYS * 86400, secure);
}

function clearSessionCookie(secure) {
  return cookieHeader('', 0, secure);
}

function cookieHeader(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(db, req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [issued, version, mac] = parts;
  const expected = sign(db, `${issued}.${version}`);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  if (version !== passwordVersion(db)) return false;
  return Date.now() - Number(issued) < SESSION_DAYS * 86400 * 1000;
}

// Simple in-memory limiter for login attempts.
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSessionCookie,
  clearSessionCookie,
  isAuthed,
  createLimiter,
};
