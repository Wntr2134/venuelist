'use strict';

// The door's forgiving name search (public/js/common.js), run outside a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'common.js'), 'utf8');
const normFn = src.slice(src.indexOf('function norm(s)'), src.indexOf('}', src.indexOf('function norm(s)')) + 1);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${normFn}\n${src.slice(src.indexOf('// ---------- forgiving name search'))}\nthis.guestScore = guestScore;`, ctx);
const hit = (q, name, extra = {}) => ctx.guestScore(q, { name, ...extra }) > 0;

test('door search finds surnames, nicknames, punctuation-free and slightly misspelt names', () => {
  for (const [q, name] of [
    ['smith', 'Jonathan Smith'], ['jon', 'Jonathan Smith'], ['jon', 'John Smith'], ['kate', 'Katherine Wu'], ['lachie', 'Lachlan Ross'],
    ['mike', 'Michael Webb'], ['obrien', "Finn O'Brien"], ["o'brien", 'Finn O’Brien'], ['annmarie', 'Ann-Marie Lee'], ['jose', 'José Ramírez'],
    ['nakamra', 'Cr. Ruth Nakamura'], ['katherin', 'Kathryn Wu'], ['jane smyth', 'Jane Smith'],
  ]) assert.ok(hit(q, name), `${q} → ${name}`);
  assert.ok(hit('harbour', 'Dev Raman', { contributorName: 'Harbour Presents' }), 'contributor name');
});

test('door search does not match unrelated names', () => {
  for (const [q, name] of [['kate', 'Priya Patel'], ['mark', 'Marcus Webb'], ['zoe', 'Chloe Nguyen'], ['al', 'Hana Kobayashi'], ['dev', 'Isla Thompson'], ['tom', 'Tamsin Lee'], ['jane smith', 'Jane Doe']]) {
    assert.ok(!hit(q, name), `${q} should not find ${name}`);
  }
});

test('names that start with the search come first', () => {
  const s = (q, n) => ctx.guestScore(q, { name: n });
  assert.ok(s('ben', 'Ben Carter') > s('ben', 'Amy Benson'));
  assert.ok(s('ben', 'Amy Benson') > s('ben', 'Reuben Ortiz'));
});
