'use strict';

// New features: anything that changes how the app behaves beyond what venues already have.
//
// Every new feature ships OFF for every venue. Will turns it on in /admin → New features:
// per venue, for every venue with "Early access" ticked (they get all new features
// automatically), or for everyone once it's ready.
//
// Adding one: add an entry here in the same pull request as the code, then guard the new
// behaviour with feature(venue, KEY) on the server or hasFeature(KEY) in the venue app.
// A test fails if code checks a key that isn't listed here.
//   key    lower-case-with-dashes, never reused or renamed (it's stored per venue)
//   name   short name Will sees in /admin
//   what   plain English: what changes for staff, guests or contributors when it's on
//   added  YYYY-MM-DD, the date it was merged
//   by     optional: who built it
//
// When a feature is on for everyone and will stay that way, delete its entry and its checks
// (it becomes part of the base app). Saved per-venue settings for old keys are ignored.

const FEATURES = [
  // { key: 'example-thing', name: 'Example thing', what: 'What staff will notice.', added: '2026-10-07' },
  {
    key: 'red-theme',
    name: 'Red colours',
    what: 'The venue’s guest list, door screens, venue admin and contributor links turn red instead of amber. OUT and delete buttons turn orange so they don’t look like the main buttons.',
    added: '2026-10-06',
  },
  {
    key: 'banned-photos',
    name: 'Banned list photos',
    what: 'Door staff can take a photo of someone being refused entry. It waits in memory for 24 hours for the venue admin to approve (then it joins the banned list) or it is deleted. Door staff see the photo when a name matches, and can open a gallery of banned faces. A manager code can remove a photo. Staff compare by eye only: there is no automatic face matching.',
    added: '2026-10-07',
  },
  {
    key: 'door-undo',
    name: 'Oops / undo at the door',
    what: 'Door mode gets an “↩️ Oops / Undo” button listing the last 12 hours of check-ins and check-outs from every door device. Staff tap Undo and type YES to reverse a mis-tap: the guest, the door count and the night report go back as if it never happened. Each undo is logged with who did it.',
    added: '2026-10-07',
  },
  {
    key: 'regular-nights',
    name: 'Regular nights (same links every week)',
    what: 'An event can be set to “Repeat every week” (e.g. Toff Tuesday). 24 hours after the night ends, next week’s copy is made automatically and each contributor link ticked “Permanent” moves to it: same link, fresh empty list. Unticked links are one-offs, erased when the night refreshes. Last week’s guests and report stay on last week’s event. The Contributors tab gets “New links for everyone” and “Clear out links”.',
    added: '2026-10-09',
  },
];

// Problems with a feature list, as readable strings (empty = fine). Used by the tests.
function validate(list) {
  const problems = [];
  const seen = new Set();
  for (const [i, f] of list.entries()) {
    const at = `features[${i}]${f && f.key ? ` (${f.key})` : ''}`;
    if (!f || typeof f !== 'object') {
      problems.push(`${at} is not an object`);
      continue;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.key || '')) problems.push(`${at}: key must be lower-case-with-dashes`);
    if (seen.has(f.key)) problems.push(`${at}: key is used twice`);
    seen.add(f.key);
    if (!f.name || String(f.name).length > 60) problems.push(`${at}: needs a name (60 characters max)`);
    if (!f.what || String(f.what).length < 10) problems.push(`${at}: needs a plain-English "what" saying what changes`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.added || '')) problems.push(`${at}: "added" must be a YYYY-MM-DD date`);
  }
  return problems;
}

module.exports = { FEATURES, validate };
