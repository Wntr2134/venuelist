'use strict';

// Off-site backups: encrypts the nightly snapshot and uploads it to DigitalOcean Spaces (S3-compatible).
// Config lives in a JSON file outside git, e.g. /srv/guestlist/backup.json (chmod 600):
//   { "endpoint": "syd1.digitaloceanspaces.com", "region": "syd1", "bucket": "riderly-backups",
//     "key": "DO00…", "secret": "…", "passphrase": "long random words", "prefix": "guestlist/" }
// Restore with: node scripts/decrypt-backup.js <file.vlb> <out.db>

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const MAGIC = Buffer.from('VLB1');

function loadOffsiteConfig(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!c.endpoint || !c.bucket || !c.key || !c.secret || !c.passphrase) return null;
    return { region: 'us-east-1', prefix: 'guestlist/', ...c };
  } catch {
    return null;
  }
}

// ----- encryption: AES-256-GCM with a key derived from the passphrase -----

function encrypt(buf, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(buf, passphrase) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Riderly backup file');
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]);
}

// ----- AWS Signature Version 4 (what S3 and Spaces expect) -----

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodePath = (p) => p.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

function sign({ method, host, path, headers, payloadHash, region, key, secret, amzDate }) {
  const date = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [
    method,
    encodePath(path),
    '',
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    headers: lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

// Uploads one object. endpoint "syd1.digitaloceanspaces.com" → https://<bucket>.syd1.digitaloceanspaces.com/<key>;
// an "http://host:port" endpoint (tests) uses path-style http://host:port/<bucket>/<key>.
function putObject(cfg, objectKey, body) {
  const local = /^http:\/\//.test(cfg.endpoint);
  const endpoint = cfg.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = local ? endpoint : `${cfg.bucket}.${endpoint}`;
  const path = local ? `/${cfg.bucket}/${objectKey}` : `/${objectKey}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256(body);
  const { headers, authorization } = sign({
    method: 'PUT', host, path, payloadHash, region: cfg.region, key: cfg.key, secret: cfg.secret, amzDate,
    headers: { 'content-type': 'application/octet-stream', 'x-amz-acl': 'private' },
  });
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    const req = (local ? http : https).request({
      method: 'PUT',
      hostname,
      port: port || (local ? 80 : 443),
      path: encodePath(path),
      headers: { ...headers, authorization, 'content-length': body.length },
      timeout: 60000,
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
        ? resolve()
        : reject(new Error(`Upload failed (${res.statusCode}): ${(text.match(/<Code>([^<]+)</) || [])[1] || text.slice(0, 120)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Upload timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// Uploads an encrypted copy of a local snapshot, rotating by weekday plus one per month.
async function uploadBackup(cfg, file, at = new Date()) {
  const body = encrypt(fs.readFileSync(file), cfg.passphrase);
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][at.getUTCDay()];
  const prefix = cfg.prefix.replace(/^\/+/, '');
  const keys = [`${prefix}daily-${day}.vlb`];
  if (at.getUTCDate() === 1) keys.push(`${prefix}monthly-${at.toISOString().slice(0, 7)}.vlb`);
  for (const k of keys) await putObject(cfg, k, body);
  return { keys, bytes: body.length };
}

module.exports = { loadOffsiteConfig, uploadBackup, encrypt, decrypt, sign };
