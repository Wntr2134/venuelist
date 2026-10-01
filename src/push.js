'use strict';

// Web push for VIP alerts, with no dependencies. Each push is EMPTY: it only wakes the phone,
// which then fetches the alert from this server over its own login. So no guest names ever
// pass through Apple's, Google's or Mozilla's push servers, and there is no payload to encrypt.
// Signed with VAPID (an ES256 JWT); the key pair is made once and kept in the settings table.

const crypto = require('node:crypto');
const https = require('node:https');

// Only the browsers' real push services: a subscription can never make us call anywhere else.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];

function allowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function vapidKeys(getSetting, setSetting) {
  let pem = getSetting('vapid_private_pem');
  if (!pem) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    setSetting('vapid_private_pem', pem);
  }
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64url(raw), privateKey };
}

function vapidJwt(audience, subject, privateKey, at = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(at / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(sig)}`;
}

// Resolves to the push service's HTTP status (0 = network failure). 404/410 = subscription gone.
function sendPush(endpoint, keys, subject, { request = https.request } = {}) {
  if (!allowedEndpoint(endpoint)) return Promise.resolve(400);
  const u = new URL(endpoint);
  const jwt = vapidJwt(`${u.protocol}//${u.host}`, subject, keys.privateKey);
  return new Promise((resolve) => {
    const req = request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { TTL: '300', Urgency: 'high', 'Content-Length': 0, Authorization: `vapid t=${jwt}, k=${keys.publicKey}` },
      timeout: 10000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

module.exports = { allowedEndpoint, vapidKeys, vapidJwt, sendPush };
