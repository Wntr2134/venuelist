'use strict';

// Minimal SMTP sender (no dependencies). Works with Gmail using an app password over TLS (port 465).
// Config lives in a JSON file outside git, e.g. /srv/guestlist/mail.json (chmod 600):
//   { "host": "smtp.gmail.com", "port": 465, "user": "you@gmail.com", "pass": "app password",
//     "from": "Riderly Guest List <you@gmail.com>", "notify": "you@gmail.com" }

const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

function loadMailConfig(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg.host || !cfg.user || !cfg.pass) return null;
    return {
      host: cfg.host,
      port: Number(cfg.port) || 465,
      secure: cfg.secure !== false, // plain SMTP only for local testing
      user: cfg.user,
      pass: String(cfg.pass).replace(/\s+/g, ''), // Gmail shows app passwords with spaces
      from: cfg.from || cfg.user,
      notify: cfg.notify || cfg.user,
    };
  } catch {
    return null;
  }
}

const addr = (s) => (String(s).match(/<([^>]+)>/) || [null, String(s)])[1].trim();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

function buildMessage(cfg, { to, subject, text, replyTo }) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const from = clean(cfg.from);
  const headers = [
    `From: ${encodeHeader(from)}`,
    `To: ${clean(to)}`,
    replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: ${encodeHeader(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${addr(from).split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

// Sends one plain-text email. Resolves when the server accepts it; rejects with the server's reply otherwise.
function sendMail(cfg, msg, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    let buffer = '';
    let waiting = null;
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => done(new Error('Email server timed out')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (e) => done(new Error(`Email connection failed: ${e.message}`)));
    socket.on('data', (chunk) => {
      buffer += chunk;
      // A reply is complete when its last line is "NNN text" (not "NNN-text").
      const lines = buffer.split('\r\n');
      const last = lines.length > 1 ? lines[lines.length - 2] : '';
      if (/^\d{3} /.test(last) && waiting) {
        const reply = buffer;
        buffer = '';
        const w = waiting;
        waiting = null;
        w(reply);
      }
    });
    const expect = (code) => new Promise((ok, fail) => {
      waiting = (reply) => (reply.startsWith(String(code)) ? ok(reply) : fail(new Error(`Email server said: ${reply.trim()}`)));
    });
    const say = (line, code) => {
      const p = expect(code);
      socket.write(`${line}\r\n`);
      return p;
    };

    (async () => {
      await expect(220);
      await say(`EHLO ${os.hostname() || 'localhost'}`, 250);
      await say('AUTH LOGIN', 334);
      await say(Buffer.from(cfg.user).toString('base64'), 334);
      await say(Buffer.from(cfg.pass).toString('base64'), 235);
      await say(`MAIL FROM:<${addr(cfg.from)}>`, 250);
      await say(`RCPT TO:<${addr(msg.to)}>`, 250);
      await say('DATA', 354);
      await say(`${buildMessage(cfg, msg)}.`, 250);
      socket.write('QUIT\r\n');
      done();
    })().catch(done);
  });
}

module.exports = { loadMailConfig, sendMail, buildMessage };
