'use strict';

const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const VENUE_COOKIE = 'vl_session';
const OWNER_COOKIE = 'vl_owner';
const VADMIN_COOKIE = 'vl_vadmin';
const SESSION_DAYS = 30;

// Over HTTPS, cookies get the __Host- prefix: the browser then refuses to let any other
// riderly.com.au subdomain set or shadow them (a __Host- cookie must be host-only, Secure and
// Path=/). We read both names, so the plain cookies already on phones keep working until they
// expire; we only ever write the prefixed name when cookies are Secure.
const hostName = (name, secure) => (secure ? `__Host-${name}` : name);

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

// The HMAC key for session cookies. In production it comes from SESSION_SECRET (a file outside
// git and outside the backups), so a stolen backup can't forge logins. SESSION_SECRET_OLD lets
// you rotate it without logging everyone out at once. With no env secret (dev, or before it's
// set up) we fall back to one kept in the database. Setting SESSION_SECRET for the first time
// logs everyone out once, which is the point of rotating a key.
function secrets(db) {
  const env = [process.env.SESSION_SECRET, process.env.SESSION_SECRET_OLD].filter(Boolean);
  if (env.length) return env;
  let s = getSetting(db, 'session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', s);
  }
  return [s];
}

function sign(db, payload, key) {
  return crypto.createHmac('sha256', key || secrets(db)[0]).update(payload).digest('base64url');
}

function cookieHeader(name, value, maxAge, secure) {
  return `${hostName(name, secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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
  const jar = parseCookies(req);
  // Prefer the __Host- cookie so a plain one a sibling subdomain planted can't shadow the real one.
  const raw = jar[`__Host-${name}`] || jar[name];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  const mac = Buffer.from(raw.slice(i + 1));
  const ok = secrets(db).some((key) => {
    const expected = Buffer.from(sign(db, payload, key));
    return mac.length === expected.length && crypto.timingSafeEqual(mac, expected);
  });
  if (!ok) return null;
  const fields = payload.split('.');
  const issued = Number(fields.pop());
  if (!(Date.now() - issued < SESSION_DAYS * 86400 * 1000)) return null;
  return fields;
}

// Clearing has to kill both the prefixed and the plain cookie, so logout works whichever one
// the phone is carrying.
function clearCookie(name, secure) {
  const out = [`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
  if (secure) out.push(`__Host-${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
  return out;
}

// ----- venue sessions: bound to the venue's password version -----

function venueCookie(db, venue, secure) {
  return issue(db, VENUE_COOKIE, ['v', venue.id, venue.password_version], secure);
}

// A one-click (SSO) session also pins the venue's API epoch, so revoking the key revokes it.
function ssoVenueCookie(db, venue, secure) {
  return issue(db, VENUE_COOKIE, ['s', venue.id, venue.password_version, venue.api_epoch || 1], secure);
}

function venueSession(db, req) {
  const f = read(db, req, VENUE_COOKIE);
  if (!f) return null;
  if (f.length === 3 && f[0] === 'v') return { venueId: Number(f[1]), version: Number(f[2]), sso: false };
  if (f.length === 4 && f[0] === 's') return { venueId: Number(f[1]), version: Number(f[2]), epoch: Number(f[3]), sso: true };
  return null;
}

function clearVenueCookie(secure) {
  return clearCookie(VENUE_COOKIE, secure);
}

// ----- venue admin portal sessions: bound to the venue's admin password version -----

function vadminCookie(db, venue, secure) {
  return issue(db, VADMIN_COOKIE, ['a', venue.id, venue.admin_version || 1], secure);
}

function vadminSession(db, req) {
  const f = read(db, req, VADMIN_COOKIE);
  if (!f || f.length !== 3 || f[0] !== 'a') return null;
  return { venueId: Number(f[1]), version: Number(f[2]) };
}

function clearVadminCookie(secure) {
  return clearCookie(VADMIN_COOKIE, secure);
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
  return clearCookie(OWNER_COOKIE, secure);
}

// In-memory limiter that only counts FAILED attempts, so a whole venue logging in
// from the same Wi-Fi (one public IP) never locks itself out. Entries are dropped once they
// age out, and the whole map is swept when it grows, so a flood of one-off keys can't grow
// memory without bound.
function createLimiter({ max, windowMs, cap = 50000 }) {
  const fails = new Map();
  const recent = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < windowMs);
  const store = (key, list) => {
    if (list.length) fails.set(key, list);
    else fails.delete(key);
  };
  const sweep = () => {
    const now = Date.now();
    for (const [k, list] of fails) {
      const live = list.filter((t) => now - t < windowMs);
      if (live.length) fails.set(k, live);
      else fails.delete(k);
    }
  };
  return {
    blocked(key) {
      const list = recent(key);
      store(key, list);
      return list.length >= max;
    },
    fail(key) {
      if (fails.size > cap) sweep();
      const list = recent(key);
      list.push(Date.now());
      store(key, list);
    },
    size: () => fails.size,
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  venueCookie,
  ssoVenueCookie,
  venueSession,
  clearVenueCookie,
  vadminCookie,
  vadminSession,
  clearVadminCookie,
  ownerCookie,
  isOwner,
  clearOwnerCookie,
  createLimiter,
};
