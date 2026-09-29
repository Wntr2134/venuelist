'use strict';

// Fills in Riderly's contact email on the privacy and terms pages, if the owner has set one in /admin.
fetch('/api/public')
  .then((r) => r.json())
  .then(({ contactEmail }) => {
    if (!contactEmail) return;
    for (const el of document.querySelectorAll('[data-contact]')) {
      const a = document.createElement('a');
      a.href = `mailto:${contactEmail}`;
      a.textContent = contactEmail;
      el.replaceChildren('Email Riderly at ', a, '. We aim to reply within a few business days.');
    }
  })
  .catch(() => {});
