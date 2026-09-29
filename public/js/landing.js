'use strict';

(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Returning staff go straight to their own venue's login.
  let last = '';
  try {
    last = localStorage.getItem('vl.lastVenue') || '';
  } catch {
    /* ignore */
  }
  if (last) document.getElementById('nav-login').href = `/v/${encodeURIComponent(last)}`;

  // ---------- scroll reveal + count-up ----------

  function countUp(el) {
    const to = Number(el.dataset.to);
    if (reduceMotion || !to) return;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 900);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  }

  const revealEls = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        el.style.transitionDelay = `${Number(el.dataset.delay || 0)}ms`;
        el.classList.add('in');
        el.querySelectorAll('.count').forEach(countUp);
        io.unobserve(el);
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach((el) => io.observe(el));
  }

  // ---------- animated door demo in the hero ----------

  const demo = document.getElementById('demo');
  if (demo) runDemo();

  function runDemo() {
    const $ = (id) => document.getElementById(id);
    const list = $('d-list');
    const search = $('d-search');
    const toast = $('d-toast');
    const counters = { inside: $('d-inside'), arrived: $('d-arrived'), vip: $('d-vip') };
    const base = { inside: 142, arrived: 156, vip: 2 };
    const state = { ...base };
    const people = [
      { n: 'Jane Smith', p: 2, tag: 'Artist', cls: 't-artist', by: 'Midnight Arcade TM' },
      { n: 'Janelle Ortiz', p: 0, tag: 'Media', cls: 't-media', by: 'Publicist', vip: true },
      { n: 'Janik Brooks', p: 1, tag: 'Guest', cls: '', by: 'Harbour Presents' },
      { n: 'Priya Patel', p: 1, tag: 'Artist', cls: 't-artist', by: 'Midnight Arcade TM' },
      { n: 'Dev Raman', p: 3, tag: 'Guest', cls: '', by: 'Harbour Presents', start: 4 },
      { n: 'Theo Lindqvist', p: 1, tag: 'Media', cls: 't-media', by: 'Publicist', start: 2 },
    ];
    let query = '';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    function tween(key, to) {
      const node = counters[key];
      const from = Number(node.textContent) || 0;
      state[key] = to;
      if (reduceMotion) return void (node.textContent = String(to));
      const start = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - start) / 450);
        node.textContent = String(Math.round(from + (to - from) * k));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      node.parentElement.classList.remove('bump');
      void node.parentElement.offsetWidth;
      node.parentElement.classList.add('bump');
    }

    function render() {
      search.textContent = query;
      search.classList.toggle('empty', !query);
      const q = query.toLowerCase();
      const rows = people.filter((x) => !q || x.n.toLowerCase().includes(q)).slice(0, 4);
      list.replaceChildren(
        ...rows.map((x) => {
          const party = 1 + x.p;
          const row = el('div', `ph-row${x.inside ? ' is-in' : ''}${x.vip ? ' vip' : ''}`);
          x.row = row;
          const info = el('div');
          const name = el('strong');
          if (x.vip) name.append(el('i', 'tag t-vipb', '★ VIP'), ' ');
          name.append(x.n);
          if (x.p) name.append(' ', el('em', '', `+${x.p}`));
          const meta = el('small');
          meta.append(el('i', `tag ${x.cls}`, x.tag), ` ${x.by}`);
          if (x.inside) meta.append(' · ', el('b', 'c-in', `${x.inside}/${party} in`));
          info.append(name, meta);
          const btns = el('div', 'ph-btns');
          btns.append(el('span', `b-out${x.inside ? '' : ' off'}`, 'OUT'), el('span', `b-in${x.inside >= party ? ' done' : ''}`, x.inside >= party ? '✓ IN' : 'IN'));
          row.append(info, btns);
          return row;
        })
      );
    }

    async function type(text) {
      for (const ch of text) {
        query += ch;
        render();
        await sleep(170);
      }
    }

    async function erase() {
      while (query) {
        query = query.slice(0, -1);
        render();
        await sleep(70);
      }
    }

    async function tapIn(person, count) {
      const btn = person.row && person.row.querySelector('.b-in');
      if (btn) btn.classList.add('press');
      await sleep(320);
      person.inside = (person.inside || 0) + count;
      tween('inside', state.inside + count);
      tween('arrived', state.arrived + count);
      if (person.vip) {
        tween('vip', state.vip + 1);
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2600);
      }
      render();
      person.row.classList.add('flash');
    }

    function reset() {
      for (const x of people) x.inside = x.start || 0;
      query = '';
      for (const k of Object.keys(base)) {
        state[k] = base[k];
        counters[k].textContent = String(base[k]);
      }
      render();
    }

    if (reduceMotion) {
      reset();
      people[0].inside = 2;
      query = 'ja';
      render();
      return;
    }

    let visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((e) => {
        visible = e[0].isIntersecting;
      }).observe(demo);
    }
    const waitVisible = async () => {
      while (!visible || document.hidden) await sleep(400);
    };

    // Other door phones checking people in, for a "live" feel.
    setInterval(() => {
      if (!visible || document.hidden || Math.random() < 0.4) return;
      const n = 1 + Math.floor(Math.random() * 2);
      tween('inside', state.inside + n);
      tween('arrived', state.arrived + n);
    }, 2300);

    (async function loop() {
      for (;;) {
        reset();
        await sleep(1200);
        await waitVisible();
        await type('jan');
        await sleep(700);
        await tapIn(people[0], 3); // Jane Smith +2 → 3/3 in
        await sleep(1600);
        await erase();
        await type('janel');
        await sleep(600);
        await tapIn(people[1], 1); // VIP → alert on every door
        await sleep(2400);
        await erase();
        await type('pri');
        await sleep(600);
        await tapIn(people[3], 2);
        await sleep(2200);
      }
    })();
  }

  // ---------- sign-up form ----------

  const slug = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

  const form = document.getElementById('signup-form');
  if (!form) return;
  const status = document.getElementById('signup-status');
  const venue = form.elements.venueName;
  const user = form.elements.username;
  const echo = document.getElementById('slug-echo');
  let userTouched = false;

  venue.addEventListener('input', () => {
    if (!userTouched) user.value = slug(venue.value);
    echo.textContent = user.value || 'your-username';
  });
  user.addEventListener('input', () => {
    userTouched = true;
    echo.textContent = slug(user.value) || 'your-username';
  });
  user.addEventListener('blur', () => {
    user.value = slug(user.value);
  });

  function say(msg, isError) {
    status.textContent = msg;
    status.classList.toggle('error-text', !!isError);
  }

  function done(title, text) {
    form.replaceChildren();
    const box = document.createElement('div');
    box.className = 'request-done';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    box.append(h, p);
    form.append(box);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    user.value = slug(user.value);
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.password !== data.confirm) return say('Passwords don’t match.', true);
    if (data.adminPassword !== data.adminConfirm) return say('Venue admin passwords don’t match.', true);
    if (data.adminPassword === data.password) return say('Use a venue admin password that’s different from the staff password.', true);
    delete data.confirm;
    delete data.adminConfirm;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    say('Sending…');
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      try {
        localStorage.setItem('vl.lastVenue', data.username);
      } catch {
        /* ignore */
      }
      if (body.status === 'active') {
        location.href = '/app';
        return;
      }
      done('Thanks — you’re signed up ✓',
        `We’ll email ${data.email} as soon as ${data.venueName} is approved. Then log in with username “${data.username}” and the password you just chose.`);
    } catch (err) {
      say(err.message, true);
      btn.disabled = false;
    }
  });
})();
