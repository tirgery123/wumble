/* global PROMPTS, ASK */
(function () {
  'use strict';

  // ---------- mode ----------
  // With Supabase configured: visitors read, only the signed-in owner edits.
  // Without it: preview mode, everything is editable and kept in this browser.
  var cfg = window.SITE_CONFIG || {};
  var remote = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  var sb = remote ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;
  var isOwner = !remote;

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) node.appendChild(arguments[i]);
    return node;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromIso(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtTime(t) {
    if (!t) return '';
    var p = t.split(':'), h = +p[0];
    return (h % 12 || 12) + ':' + p[1] + (h < 12 ? ' AM' : ' PM');
  }
  function newestFirst(a, b) { return a.created_at < b.created_at ? 1 : -1; }
  var today = new Date(); today.setHours(0, 0, 0, 0);

  var flashTimer;
  function flash(msg) {
    $('flash').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { $('flash').textContent = ''; }, 6000);
  }
  function fail(err) {
    if (window.console) console.error(err);
    flash('Something went wrong. Please try again.');
  }

  // ---------- storage ----------
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem('wumble.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem('wumble.' + key, JSON.stringify(value)); } catch (e) {}
  }
  var memory = {};   // fallback when the browser blocks localStorage
  function rowsOf(table) { return memory[table] || (memory[table] = lsGet(table, [])); }
  function keep(table) { lsSet(table, memory[table]); }

  var localDb = {
    list: async function (table) { return rowsOf(table).slice(); },
    insert: async function (table, row) {
      row.id = uid(); row.created_at = new Date().toISOString();
      rowsOf(table).push(row); keep(table);
    },
    update: async function (table, id, patch) {
      rowsOf(table).forEach(function (r) { if (r.id === id) Object.assign(r, patch); });
      keep(table);
    },
    remove: async function (table, id) {
      memory[table] = rowsOf(table).filter(function (r) { return r.id !== id; });
      keep(table);
    },
    upsert: async function (table, key, row) {
      var rows = rowsOf(table), hit = false;
      rows.forEach(function (r) { if (r[key] === row[key]) { Object.assign(r, row); hit = true; } });
      if (!hit) rows.push(row);
      keep(table);
    }
  };
  function ok(res) { if (res.error) throw res.error; return res.data; }
  var remoteDb = {
    list: async function (table) { return ok(await sb.from(table).select('*')); },
    insert: async function (table, row) { ok(await sb.from(table).insert(row)); },
    update: async function (table, id, patch) { ok(await sb.from(table).update(patch).eq('id', id)); },
    remove: async function (table, id) { ok(await sb.from(table).delete().eq('id', id)); },
    upsert: async function (table, key, row) { ok(await sb.from(table).upsert(row, { onConflict: key })); }
  };
  var db = remote ? remoteDb : localDb;

  // Replaces a card's last child with a textarea plus Save / Cancel.
  function openEditor(card, value, label, saveText, onSave, onCancel) {
    var ta = el('textarea', { 'aria-label': label });
    ta.value = value;
    var save = el('button', { class: 'primary', type: 'button', text: saveText, onclick: function () { onSave(ta.value.trim()); } });
    var cancel = el('button', { type: 'button', text: 'Cancel', onclick: onCancel });
    card.replaceChild(el('div', null, ta, el('div', { class: 'row' }, save, cancel)), card.lastChild);
    ta.focus();
  }

  // ---------- journal ----------
  var MOODS = ['low', 'tired', 'neutral', 'steady', 'good'];
  var mood = null;
  var entries = [];
  var promptIdx = Math.floor(Math.random() * PROMPTS.length);

  function renderPrompt() { $('prompt').textContent = PROMPTS[promptIdx]; }
  $('nextPrompt').addEventListener('click', function () {
    promptIdx = (promptIdx + 1) % PROMPTS.length;
    renderPrompt();
  });
  function renderMoods() {
    var box = $('moods'); box.textContent = '';
    MOODS.forEach(function (m) {
      box.appendChild(el('button', {
        type: 'button', text: m, 'aria-pressed': String(mood === m),
        onclick: function () { mood = mood === m ? null : m; renderMoods(); }
      }));
    });
  }
  async function loadEntries() {
    entries = (await db.list('journal')).sort(newestFirst);
    renderEntries();
  }
  function renderEntries() {
    var box = $('entries'); box.textContent = '';
    if (!entries.length) { box.appendChild(el('p', { class: 'empty', text: 'No entries yet.' })); return; }
    entries.forEach(function (e) {
      var when = new Date(e.created_at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
      var card = el('div', { class: 'card entry' },
        el('div', { class: 'entry-head' },
          el('span', { class: 'date', text: when + (e.edited ? ' (edited)' : '') }),
          e.mood ? el('span', { class: 'tag', text: e.mood }) : null,
          isOwner ? el('span', { class: 'acts' },
            el('button', { class: 'ghost neutral', type: 'button', text: 'Edit', onclick: function () {
              openEditor(card, e.body, 'Edit entry', 'Save', function (text) {
                if (!text) return;
                db.update('journal', e.id, { body: text, edited: true }).then(loadEntries).catch(fail);
              }, renderEntries);
            } }),
            el('button', { class: 'ghost', type: 'button', text: 'Delete', onclick: function () {
              if (!confirm('Delete this entry?')) return;
              db.remove('journal', e.id).then(loadEntries).catch(fail);
            } })
          ) : null
        ),
        e.prompt ? el('p', { class: 'asked', text: e.prompt }) : null,
        el('p', { text: e.body })
      );
      box.appendChild(card);
    });
  }
  $('vent').value = lsGet('draft', '');
  $('vent').addEventListener('input', function () { lsSet('draft', this.value); });
  $('saveEntry').addEventListener('click', function () {
    var text = $('vent').value.trim();
    if (!text) { $('vent').focus(); return; }
    db.insert('journal', { mood: mood, prompt: PROMPTS[promptIdx], body: text, edited: false }).then(function () {
      $('vent').value = ''; lsSet('draft', ''); mood = null;
      promptIdx = (promptIdx + 1) % PROMPTS.length;
      renderPrompt(); renderMoods();
      return loadEntries();
    }).catch(fail);
  });

  // ---------- questions ----------
  var asked = [];
  var askCat = null;

  function renderAskIdeas() {
    var cats = $('askCats'), list = $('askIdeas');
    cats.textContent = ''; list.textContent = '';
    Object.keys(ASK).forEach(function (c) {
      cats.appendChild(el('button', {
        type: 'button', text: c, 'aria-pressed': String(askCat === c),
        onclick: function () { askCat = askCat === c ? null : c; renderAskIdeas(); }
      }));
    });
    if (!askCat) return;
    ASK[askCat].forEach(function (q) {
      list.appendChild(el('button', { type: 'button', class: 'idea', text: q, onclick: function () {
        $('askText').value = q; $('askText').focus();
      } }));
    });
  }
  async function loadAsked() {
    asked = (await db.list('questions')).sort(newestFirst);
    renderAsked();
  }
  function renderAsked() {
    var box = $('asked'); box.textContent = '';
    // Visitors only see questions that have been answered.
    var shown = isOwner ? asked : asked.filter(function (x) { return x.answer; });
    if (!shown.length) {
      box.appendChild(el('p', { class: 'empty', text: isOwner ? 'No questions yet.' : 'No answered questions yet.' }));
      return;
    }
    shown.forEach(function (item) {
      var when = new Date(item.created_at).toLocaleDateString([], { dateStyle: 'medium' });
      var card = el('div', { class: 'card entry' },
        el('div', { class: 'entry-head' },
          el('span', { text: 'Anonymous · ' + when }),
          isOwner ? el('span', { class: 'acts' },
            el('button', { class: 'ghost neutral', type: 'button', text: item.answer ? 'Edit answer' : 'Answer', onclick: function () {
              openEditor(card, item.answer || '', 'Answer', 'Save answer', function (text) {
                db.update('questions', item.id, { answer: text }).then(loadAsked).catch(fail);
              }, renderAsked);
            } }),
            el('button', { class: 'ghost', type: 'button', text: 'Delete', onclick: function () {
              if (!confirm('Delete this question?')) return;
              db.remove('questions', item.id).then(loadAsked).catch(fail);
            } })
          ) : null
        ),
        el('p', { class: 'asked-q', text: item.question }),
        el('p', { class: item.answer ? 'answer' : 'empty', text: item.answer || 'Not answered yet.' })
      );
      box.appendChild(card);
    });
  }
  $('askForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = this, q = $('askText').value.trim();
    if (!q) return;
    db.insert('questions', { question: q, answer: '' }).then(function () {
      form.reset();
      $('askMsg').textContent = 'Sent anonymously. It will appear here once it has been answered.';
      return loadAsked();
    }).catch(fail);
  });

  // ---------- reservations ----------
  var requests = [];
  $('rDate').min = iso(today);

  async function loadRequests() {
    var all = await db.list('reservations');
    var cutoff = iso(today);
    // A reservation stays listed through its own day and is dropped the day after.
    requests = all.filter(function (r) { return r.date >= cutoff; });
    renderRequests();
    if (isOwner) {
      all.filter(function (r) { return r.date < cutoff; }).forEach(function (r) {
        db.remove('reservations', r.id).catch(function () {});
      });
    }
  }
  function renderRequests() {
    var box = $('requests'); box.textContent = '';
    if (!requests.length) { box.appendChild(el('p', { class: 'empty', text: 'No upcoming reservations.' })); return; }
    requests.slice().sort(function (a, b) {
      return (a.date + a.from_time).localeCompare(b.date + b.from_time);
    }).forEach(function (r) {
      var day = fromIso(r.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      var when = day + ' · ' + fmtTime(r.from_time) + (r.to_time ? ' – ' + fmtTime(r.to_time) : '');
      function setStatus(s) {
        return function () { db.update('reservations', r.id, { status: s }).then(loadRequests).catch(fail); };
      }
      box.appendChild(el('div', { class: 'card req' },
        el('span', { class: 'who', text: r.name }),
        el('span', { class: 'when', text: when }),
        el('span', { class: 'pill ' + r.status, text: r.status }),
        isOwner ? el('div', { class: 'actions' },
          r.status !== 'confirmed' ? el('button', { type: 'button', text: 'Confirm', onclick: setStatus('confirmed') }) : null,
          r.status !== 'declined' ? el('button', { type: 'button', text: 'Decline', onclick: setStatus('declined') }) : null,
          el('button', { class: 'ghost', type: 'button', text: 'Remove', onclick: function () {
            db.remove('reservations', r.id).then(loadRequests).catch(fail);
          } })
        ) : null,
        r.note ? el('span', { class: 'note', text: r.note }) : null,
        el('span', { class: 'sent', text: 'Submitted ' + new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) })
      ));
    });
  }
  $('reqForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = this, from = $('rFrom').value, to = $('rTo').value, msg = $('reqMsg');
    if (to && to <= from) { msg.textContent = 'The end time needs to be after the start.'; return; }
    db.insert('reservations', {
      name: $('rName').value.trim(), date: $('rDate').value,
      from_time: from, to_time: to, note: $('rNote').value.trim(), status: 'pending'
    }).then(function () {
      form.reset();
      msg.textContent = 'Request recorded. Pending confirmation.';
      return loadRequests();
    }).catch(fail);
  });

  // ---------- goals ----------
  var goals = [];
  async function loadGoals() {
    var rows = await db.list('goals');
    goals = [1, 2, 3, 4].map(function (n) {
      var hit = rows.filter(function (r) { return r.slot === n; })[0];
      return hit || { slot: n, game: '', goal: '', pct: 0 };
    });
    renderGoals();
  }
  function renderGoals() {
    var box = $('slots'); box.textContent = '';
    goals.forEach(function (g) {
      var fill = el('i'); fill.style.width = g.pct + '%';
      var pct = el('span', { class: 'pct', text: g.pct + '%' });
      var meter = el('div', { class: 'meter' }, fill);
      var num = el('div', { class: 'num', text: 'Slot ' + g.slot });

      if (!isOwner) {
        box.appendChild(el('div', { class: 'card slot' },
          num,
          el('p', { class: 'ro-game', text: g.game || 'Empty slot' }),
          g.goal ? el('p', { class: 'ro-goal', text: g.goal }) : null,
          meter, pct
        ));
        return;
      }

      var game = el('input', { type: 'text', class: 'game', placeholder: 'Game', maxlength: '40', 'aria-label': 'Slot ' + g.slot + ' game' });
      var goal = el('input', { type: 'text', placeholder: 'Objective', maxlength: '100', 'aria-label': 'Slot ' + g.slot + ' objective' });
      var range = el('input', { type: 'range', min: '0', max: '100', step: '5', 'aria-label': 'Slot ' + g.slot + ' progress' });
      game.value = g.game; goal.value = g.goal; range.value = g.pct;
      var timer;
      function save() {
        clearTimeout(timer);
        timer = setTimeout(function () {
          db.upsert('goals', 'slot', { slot: g.slot, game: g.game, goal: g.goal, pct: g.pct }).catch(fail);
        }, 600);
      }
      game.addEventListener('input', function () { g.game = game.value; save(); });
      goal.addEventListener('input', function () { g.goal = goal.value; save(); });
      range.addEventListener('input', function () {
        g.pct = +range.value; fill.style.width = g.pct + '%'; pct.textContent = g.pct + '%'; save();
      });
      box.appendChild(el('div', { class: 'card slot' }, num, game, goal, meter, range, pct));
    });
  }

  // ---------- tabs ----------
  var TABS = ['questions', 'hangouts', 'goals', 'journal'];
  function showTab(id) {
    if (TABS.indexOf(id) < 0) id = location.hash.slice(1);
    if (TABS.indexOf(id) < 0) id = 'questions';
    TABS.forEach(function (t) { $(t).classList.toggle('active', t === id); });
    Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) {
      if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () { showTab(); });
  document.querySelector('nav').addEventListener('click', function (ev) {
    var a = ev.target.closest('a');
    if (!a) return;
    ev.preventDefault();
    var id = a.getAttribute('href').slice(1);
    try { history.replaceState(null, '', '#' + id); } catch (e) {}
    showTab(id);
  });

  // ---------- owner ----------
  function refreshAll() {
    return Promise.all([loadEntries(), loadAsked(), loadRequests(), loadGoals()]).catch(function (err) {
      if (window.console) console.error(err);
      flash('Could not load the latest data.');
    });
  }
  function applyOwner() {
    document.body.classList.toggle('owner', isOwner);
    $('vent').closest('.card').hidden = !isOwner;
    $('ownerBtn').textContent = isOwner ? 'Sign out' : 'Owner sign in';
    return refreshAll();
  }
  async function syncOwner() {
    var session = (await sb.auth.getSession()).data.session;
    var owner = false;
    if (session) {
      var res = await sb.rpc('is_owner');
      owner = res.data === true;
      if (!owner) {
        flash('That account is not the owner of this site.');
        await sb.auth.signOut();
        return;
      }
    }
    isOwner = owner;
    await applyOwner();
  }

  $('ownerBtn').hidden = !remote;
  $('modeNote').textContent = remote ? '' : 'Preview mode: data is stored in this browser only.';
  $('ownerBtn').addEventListener('click', function () {
    if (isOwner) { sb.auth.signOut().catch(fail); return; }
    $('siMsg').textContent = '';
    $('signin').showModal();
  });
  $('siCancel').addEventListener('click', function () { $('signin').close(); });
  $('signinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = this;
    sb.auth.signInWithPassword({ email: $('siEmail').value.trim(), password: $('siPass').value }).then(function (res) {
      if (res.error) { $('siMsg').textContent = 'Sign in failed. Check the email and password.'; return; }
      form.reset();
      $('signin').close();
    }).catch(fail);
  });

  renderPrompt(); renderMoods(); renderAskIdeas(); showTab();
  if (remote) {
    // Fires once on load with the stored session, then on every sign in / out.
    sb.auth.onAuthStateChange(function () { setTimeout(function () { syncOwner().catch(fail); }, 0); });
  } else {
    applyOwner();
  }
})();
