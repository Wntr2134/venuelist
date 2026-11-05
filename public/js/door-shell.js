'use strict';

/* global h */

// The Riderly door layout for the sign-in, setup and reset pages: the Guest List logo, one card,
// one quiet line, no nav (Riderly's docs/site-look.md). Styles: .rs-door* in static/riderly/site.css.
function doorPage(...card) {
  return h('main', { class: 'rs-door' },
    h('img', { class: 'rs-door-logo', src: '/static/riderly/logos/guest-list-logo-on-dark.svg', alt: 'Guest List by Riderly', height: '64' }),
    h('div', { class: 'rs-door-card stack' }, card),
    h('p', { class: 'rs-door-line' },
      h('a', { href: 'https://riderly.com.au/', rel: 'noreferrer' }, 'Riderly'), ' · ',
      h('a', { href: '/privacy' }, 'Privacy'), ' · ',
      h('a', { href: '/terms' }, 'Terms')));
}
