'use strict';

// A venue's banned (refused entry) list: who matches it. Deliberately strict, because a
// false alarm at the door is embarrassing: a banned "Jake Smith" needs both names to match
// (a typo allowed in longer names), so one "Jake" on a list never lights up every Jake.

const key = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’`.\-]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

function close(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || a[0] !== b[0] || Math.abs(a.length - b.length) > 1) return false;
  // one edit apart
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function matches(guestName, bannedName) {
  const g = key(guestName);
  const b = key(bannedName);
  if (!g.length || !b.length) return false;
  if (b.length === 1) return g.length === 1 && close(g[0], b[0]); // a one-word ban only matches a one-word name
  const first = g.findIndex((t) => close(t, b[0]));
  if (first < 0) return false;
  return g.some((t, i) => i !== first && close(t, b[b.length - 1]));
}

// The first active banned entry a guest's name matches, or null.
function findMatch(entries, name) {
  return entries.find((e) => matches(name, e.name)) || null;
}

module.exports = { matches, findMatch };
