// Soirées du mois — interface (vanilla JS, aucune dépendance)
(() => {
  'use strict';
  const $app = document.getElementById('app');
  const LS = 'soirees-token';
  let token = null;
  let data = null;
  let form = null; // réponse en cours d'édition
  let editing = false; // « Changer d'avis » ouvert

  // ---------- utilitaires ----------
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const d = (iso, opts) => new Date(iso + 'T12:00:00').toLocaleDateString('fr-CH', opts);
  const longDate = (iso) => d(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shortDate = (iso) => d(iso, { weekday: 'short', day: 'numeric', month: 'long' });
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
  const addDays = (iso, n) => { const x = new Date(iso + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const personalLink = (t) => `${location.origin}/m/${t}`;
  const phoneDigits = (p) => String(p || '').replace(/[^\d]/g, '').replace(/^00/, '');

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function call(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || 'Erreur'), { status: res.status });
    return out;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copié ✔'); }
    catch { prompt('Copiez le texte :', text); }
  }
  async function share(text) {
    if (navigator.share) { try { await navigator.share({ text }); } catch {} }
    else copy(text);
  }
  const waLink = (text, phone) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(text)}`;

  // ---------- démarrage ----------
  async function boot() {
    const m = location.pathname.match(/^\/m\/([a-z0-9]+)/i);
    if (m) {
      token = m[1];
      try { localStorage.setItem(LS, token); } catch {}
    } else {
      try { token = localStorage.getItem(LS); } catch {}
    }
    if (!token) return renderNoToken();
    await load();
  }

  async function load(eventId) {
    try {
      data = await call('GET', '/me' + (eventId ? `?event=${eventId}` : ''));
      form = null;
      editing = false;
      render();
    } catch (e) {
      if (e.status === 401) {
        try { localStorage.removeItem(LS); } catch {}
        token = null;
        return renderNoToken(e.message);
      }
      $app.innerHTML = `<p class="center pad">${h(e.message)}</p>`;
    }
  }

  async function renderNoToken(err) {
    let setup = false;
    try { setup = (await call('GET', '/setup')).needsSetup; } catch {}
    if (setup) {
      $app.innerHTML = `
        <div class="topbar"><h1>Soirées du mois</h1></div>
        <div class="card hero">
          <h2>Bienvenue 👋</h2>
          <p>Première utilisation : créez votre profil. Vous serez administrateur et pourrez ajouter les autres membres.</p>
          <form id="setup">
            <label class="field">Votre prénom<input type="text" name="name" required maxlength="60" autocomplete="given-name"></label>
            <div class="field">Vous êtes sur</div>
            <div class="chk2"><label class="check"><input type="checkbox" name="on_whatsapp" checked> WhatsApp</label>
              <label class="check"><input type="checkbox" name="on_signal"> Signal</label></div>
            <label class="field">Téléphone (facultatif)<input type="tel" name="phone" placeholder="+41 79 123 45 67"></label>
            <button class="btn primary">Créer mon profil</button>
          </form>
        </div>`;
      document.getElementById('setup').onsubmit = async (ev) => {
        ev.preventDefault();
        const f = Object.fromEntries(new FormData(ev.target));
        try {
          const r = await call('POST', '/setup', f);
          location.href = personalLink(r.token);
        } catch (e) { toast(e.message); }
      };
      return;
    }
    let roster = [];
    try { roster = (await call('GET', '/roster')).members; } catch {}
    $app.innerHTML = `
      <div class="topbar"><h1>Soirées du mois</h1></div>
      <div class="card hero">
        <h2>Qui es-tu ? 👋</h2>
        <p class="muted small" style="margin-top:-6px">${err ? h(err) + '. ' : ''}Touche ton nom : ton téléphone s'en souviendra pour les prochaines fois.</p>
        ${roster.length > 8 ? `<input type="text" id="find" placeholder="🔍 Chercher mon nom" autocomplete="off">` : ''}
        <ul class="list" id="roster" style="margin-top:8px">
          ${roster.map((m) => `<li data-name="${h(m.name.toLowerCase())}">
            <button class="pick" data-id="${m.id}" ${m.admin ? 'data-admin="1"' : ''}>${h(m.name)}${m.admin ? ' <span class="pill no">admin</span>' : ''}</button></li>`).join('')}
        </ul>
        ${roster.length ? '' : '<p class="muted">La liste est encore vide.</p>'}
        <p class="muted small" style="margin-bottom:0">Ton nom n'y est pas ? Demande à l'organisateur de t'ajouter.</p>
      </div>`;
    const find = document.getElementById('find');
    if (find) find.oninput = () => {
      const q = find.value.trim().toLowerCase();
      document.querySelectorAll('#roster li').forEach((li) => { li.hidden = q && !li.dataset.name.includes(q); });
    };
    document.querySelectorAll('.pick').forEach((b) => b.onclick = async () => {
      if (b.dataset.admin) return toast('Ouvre ton lien admin personnel pour te connecter');
      if (!confirm(`Tu es bien ${b.textContent.trim()} ?`)) return;
      try {
        token = (await call('POST', '/claim', { member_id: b.dataset.id })).token;
        try { localStorage.setItem(LS, token); } catch {}
        await load();
      } catch (e) { toast(e.message); }
    });
  }

  function logout() {
    try { localStorage.removeItem(LS); } catch {}
    token = null;
    history.replaceState(null, '', '/');
    renderNoToken();
  }

  // ---------- messages à partager ----------
  function announceText(ev) {
    const where = [ev.place, ev.address].filter(Boolean).join(', ');
    return [
      `🎉 ${ev.title}`,
      `📅 ${longDate(ev.date)} à ${ev.time}`,
      where ? `📍 ${where}` : `📍 Lieu annoncé bientôt`,
      ev.host_name ? `🙋 Organisé par ${ev.host_name}` : null,
      '',
      `Qui vient ? Qui mange 🍽️, chante au karaoké 🎤, boit un verre 🍷 ? Seul·e ou accompagné·e ?`,
      `👉 Réponds ici avant le ${shortDate(ev.deadline)} : ${location.origin}`,
    ].filter((x) => x !== null).join('\n');
  }

  function reminderText(ev) {
    const left = daysBetween(data.today, ev.deadline);
    const when = left <= 0 ? "c'est aujourd'hui le dernier jour" : left === 1 ? "plus qu'1 jour" : `plus que ${left} jours`;
    const t = totals();
    const names = data.pending.map((p) => p.name).join(', ');
    return [
      `⏰ Rappel — ${ev.title} (${shortDate(ev.date)})`,
      `Réponses jusqu'au ${shortDate(ev.deadline)} : ${when} !`,
      names ? `Pas encore de réponse de : ${names}.` : `Tout le monde a répondu, merci 🙏`,
      `Déjà ${t.people} personne${t.people > 1 ? 's' : ''} attendue${t.people > 1 ? 's' : ''}.`,
      `👉 Réponds ici : ${location.origin}`,
    ].join('\n');
  }

  function individualText(member, ev) {
    return `Salut ${member.name} ! Petit rappel pour « ${ev.title} » du ${shortDate(ev.date)} : tu viens ? Réponds ici avant le ${shortDate(ev.deadline)} 👉 ${location.origin}`;
  }

  function welcomeText(member) {
    return `Salut ${member.name} ! Voici ton lien administrateur pour les soirées du mois (garde-le pour toi, il donne accès à la gestion) :\n${personalLink(member.token)}`;
  }

  function shareButtons(text, id) {
    return `<div class="btns">
      <a class="btn sm wa" href="${h(waLink(text))}" target="_blank" rel="noopener">WhatsApp</a>
      <button class="btn sm signal" data-share="${id}">Signal / partager</button>
      <button class="btn sm" data-copy="${id}">Copier</button>
    </div>`;
  }

  const chanPills = (m) => `${m.on_whatsapp ? '<span class="pill wa">WhatsApp</span>' : ''}${m.on_signal ? '<span class="pill signal">Signal</span>' : ''}`;
  const pad2 = (n) => String(n).padStart(2, '0');
  function googleCalLink(ev) {
    const [hh, mm] = ev.time.split(':').map(Number);
    const day = ev.date.replace(/-/g, '');
    const start = `${day}T${pad2(hh)}${pad2(mm)}00`, end = `${day}T${pad2(Math.min(23, hh + 4))}${pad2(mm)}00`;
    const where = [ev.place, ev.address].filter(Boolean).join(', ');
    const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates: `${start}/${end}`, ctz: 'Europe/Zurich',
      details: `${ev.notes ? ev.notes + '\n\n' : ''}Organisé par ${ev.host_name || '?'} — ${location.origin}`, location: where });
    return `https://calendar.google.com/calendar/render?${q}`;
  }

  // ---------- calculs ----------
  function totals() {
    const t = { people: 0, maybe: 0, no: 0, eat: 0, sing: 0, drink: 0 };
    for (const r of data.rsvps) {
      const n = 1 + (r.guests || 0);
      if (r.attending === 'yes') {
        t.people += n;
        if (r.eat) t.eat += n;
        if (r.sing) t.sing += n;
        if (r.drink) t.drink += n;
      } else if (r.attending === 'maybe') t.maybe += n;
      else t.no += 1;
    }
    return t;
  }

  function suggestedHost() {
    const ev = data.event;
    const cand = data.members.filter((m) => m.active && (!ev || m.id !== ev.host_id));
    cand.sort((a, b) => (a.last_hosted || '').localeCompare(b.last_hosted || '') || a.name.localeCompare(b.name));
    return cand[0];
  }

  // ---------- rendu ----------
  const texts = {};
  function render() {
    const ev = data.event;
    const me = data.me;
    const html = [];
    html.push(`<div class="topbar"><h1>Soirées du mois</h1><span class="hello">Salut ${h(me.name)} · <a href="#" id="logout">pas toi ?</a></span></div>`);

    html.push(switcher());
    if (!ev) {
      html.push(`<div class="card hero center"><p style="font-size:40px;margin:0">🗓️</p><h2>Pas encore de soirée prévue</h2>
        <p class="muted">${data.canCreate ? 'Créez la première soirée ci-dessous.' : "L'organisateur va bientôt l'annoncer."}</p></div>`);
    } else {
      html.push(eventCard(ev));
      if (!ev.cancelled) html.push(rsvpCard(ev));
      html.push(summaryCard(ev));
    }

    if (data.canEdit || data.canCreate || me.is_admin) html.push(`<div class="section-label">Organisation</div>`);
    if (ev && data.canEdit) html.push(shareCard(ev), editCard(ev));
    if (data.canCreate) html.push(createCard());
    if (me.is_admin) html.push(membersCard());
    if (data.history.length > 1) html.push(historyCard());

    $app.innerHTML = html.join('');
    bind();
  }

  // Plusieurs soirées à venir : onglets pour passer de l'une à l'autre
  function switcher() {
    const up = data.upcoming || [];
    const cur = data.event && data.event.id;
    if (up.length < 2 && (up.length === 0 || up[0].id === cur)) return '';
    const mark = { yes: '👍', maybe: '🤔', no: '🙅' };
    return `<nav class="chips" aria-label="Soirées à venir">${up.map((e) => `
      <button class="chip" data-ev="${e.id}" aria-current="${e.id === cur}">
        <b>${h(d(e.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</b>
        <span>${h(e.title)}</span>
        <i>${e.cancelled ? 'annulée' : e.mine ? mark[e.mine] : '❓ à répondre'}</i>
      </button>`).join('')}</nav>`;
  }

  function eventCard(ev) {
    const left = daysBetween(data.today, ev.deadline);
    const past = ev.date < data.today;
    const over = left < 0;
    const dl = over
      ? `Réponses closes depuis le ${shortDate(ev.deadline)}${past ? '' : ' — vous pouvez encore prévenir'}`
      : `⏳ Réponses jusqu'au <b>${shortDate(ev.deadline)}</b> — ${left === 0 ? "dernier jour !" : left === 1 ? 'plus que 1 jour' : `plus que ${left} jours`}`;
    const where = [ev.place, ev.address].filter(Boolean).join(', ');
    const map = where ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}` : null;
    return `<section class="card hero">
      ${ev.cancelled ? `<div class="cancelled">Soirée annulée</div>` : ''}
      ${past && !ev.cancelled ? `<div class="cancelled">Soirée passée</div>` : ''}
      <div class="date">${h(longDate(ev.date))}</div>
      <h2 style="margin:0">${h(ev.title)}</h2>
      <div class="meta">
        <div><span>🕖</span><span>${h(ev.time)}</span></div>
        <div><span>📍</span><span>${where ? `<a href="${h(map)}" target="_blank" rel="noopener">${h(where)}</a>` : '<span class="muted">Lieu à définir</span>'}</span></div>
        <div><span>🙋</span><span>Organisé par <b>${h(ev.host_name || '—')}</b></span></div>
      </div>
      ${ev.cancelled || past ? '' : `<div class="deadline ${over ? 'over' : ''}">${dl}</div>`}
      ${ev.notes ? `<div class="notes">${h(ev.notes)}</div>` : ''}
      ${ev.cancelled || past ? '' : `<div class="btns">
        <a class="btn sm" href="/api/events/${ev.id}/soiree.ics">📅 Agenda iPhone / Outlook</a>
        <a class="btn sm" href="${h(googleCalLink(ev))}" target="_blank" rel="noopener">Google Agenda</a></div>`}
    </section>`;
  }

  function rsvpCard(ev) {
    const mine = data.rsvps.find((r) => r.member_id === data.me.id);
    if (mine && !editing) {
      const label = { yes: '👍 Tu viens', maybe: '🤔 Peut-être', no: '🙅 Tu ne viens pas' }[mine.attending];
      const extras = mine.attending === 'no' ? '' : [mine.guests ? `avec ${mine.guests} personne${mine.guests > 1 ? 's' : ''}` : 'seul·e',
        mine.eat ? '🍽️' : '', mine.sing ? '🎤' : '', mine.drink ? '🍷' : ''].filter(Boolean).join(' ');
      return `<section class="card" id="rsvp">
        <h2>Ta réponse</h2>
        <div class="answer ${mine.attending}"><b>${label}</b>${extras ? `<span>${extras}</span>` : ''}</div>
        ${mine.comment ? `<p class="muted small" style="margin:8px 2px 0">« ${h(mine.comment)} »</p>` : ''}
        <button class="btn" id="change" style="width:100%;margin-top:14px">🔄 Changer d'avis / modifier</button>
        <p class="muted small center" style="margin:8px 0 0">Tu peux changer ta réponse à tout moment.</p>
      </section>`;
    }
    if (!form) form = mine ? { ...mine } : { attending: null, guests: 0, eat: 0, sing: 0, drink: 0, comment: '' };
    const going = form.attending && form.attending !== 'no';
    const btn = (v, label) => `<button type="button" class="${v}" data-att="${v}" aria-pressed="${form.attending === v}">${label}</button>`;
    const tog = (k, emo, label) => `<label class="toggle"><input type="checkbox" data-tog="${k}" ${form[k] ? 'checked' : ''}><span class="emo">${emo}</span>${label}</label>`;
    return `<section class="card" id="rsvp">
      <h2>${mine ? 'Modifier ta réponse' : 'Tu viens ?'}</h2>
      <div class="choice">${btn('yes', '👍 Oui')}${btn('maybe', '🤔 Peut-être')}${btn('no', '🙅 Non')}</div>
      ${going ? `
        <div class="stepper">
          <span>Accompagné·e de</span>
          <span class="ctrl"><button type="button" data-g="-1" aria-label="Moins">−</button><output>${form.guests}</output><button type="button" data-g="1" aria-label="Plus">+</button></span>
        </div>
        <p class="muted small" style="margin:6px 2px 0">${form.guests ? `Vous serez ${1 + form.guests}. Les choix ci-dessous comptent pour tout votre groupe.` : 'Vous venez seul·e.'}</p>
        <div class="toggles">${tog('eat', '🍽️', 'Je mange')}${tog('sing', '🎤', 'Karaoké')}${tog('drink', '🍷', 'Un verre')}</div>` : ''}
      <label class="field">Un mot (facultatif)<textarea id="comment" maxlength="280" placeholder="${going ? 'Ex. : j’arrive vers 20h' : 'Ex. : la prochaine fois !'}">${h(form.comment || '')}</textarea></label>
      <button class="btn primary" id="save" ${form.attending ? '' : 'disabled'}>${mine ? 'Mettre à jour' : 'Envoyer ma réponse'}</button>
      ${mine ? `<button class="btn" id="cancel-edit" style="width:100%;margin-top:8px">Annuler</button>` : ''}
    </section>`;
  }

  function summaryCard(ev) {
    const t = totals();
    const icons = (r) => r.attending === 'no' ? '' : `${r.eat ? '🍽️' : ''}${r.sing ? '🎤' : ''}${r.drink ? '🍷' : ''}`;
    const label = { yes: 'Oui', maybe: 'Peut-être', no: 'Non' };
    const rows = data.rsvps.map((r) => `<li>
        <div class="who"><b>${h(r.name)}</b>${r.guests ? ` <span class="muted">+${r.guests}</span>` : ''}<span class="pill ${r.attending}">${label[r.attending]}</span>${r.changed ? `<span class="pill changed" title="Avant : ${label[r.previous] || '?'}">a changé d'avis</span>` : ''}
          ${r.comment ? `<div class="c">« ${h(r.comment)} »</div>` : ''}</div>
        <span class="icons">${icons(r)}</span></li>`).join('');
    const pend = data.pending.map((p) => `<li><div class="who">${h(p.name)} ${chanPills(p)}</div>
        ${data.canEdit && !ev.cancelled ? `<span class="quick" title="Réponse reçue par message">
          <button data-for="${p.id}" data-a="yes">Oui</button><button data-for="${p.id}" data-a="no">Non</button></span>` : ''}</li>`).join('');
    return `<section class="card">
      <h2>Qui vient ?</h2>
      <div class="stats">
        <div class="stat big"><b>${t.people}</b><span>personne${t.people > 1 ? 's' : ''} attendue${t.people > 1 ? 's' : ''}${t.maybe ? ` · ${t.maybe} peut-être` : ''}</span></div>
        <div class="stat"><b>${t.eat}</b><span>🍽️ repas</span></div>
        <div class="stat"><b>${t.sing}</b><span>🎤 karaoké</span></div>
        <div class="stat"><b>${t.drink}</b><span>🍷 verre</span></div>
      </div>
      ${rows ? `<h3>Réponses (${data.rsvps.length})</h3><ul class="list">${rows}</ul>` : ''}
      ${pend ? `<h3>Pas encore répondu (${data.pending.length})</h3><ul class="list">${pend}</ul>` : ''}
    </section>`;
  }

  function shareCard(ev) {
    texts.announce = announceText(ev);
    texts.reminder = reminderText(ev);
    const relance = data.pending.map((p) => {
      const txt = individualText(p, ev);
      texts['ind' + p.id] = txt;
      const direct = p.phone
        ? `${p.on_whatsapp ? `<a class="btn sm wa" href="${h(waLink(txt, p.phone))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${p.on_signal
            ? `<a class="btn sm signal" href="https://signal.me/#p/+${phoneDigits(p.phone)}" target="_blank" rel="noopener" data-copyfirst="ind${p.id}">Signal</a>` : ''}`
        : `<button class="btn sm" data-share="ind${p.id}">Partager</button>`;
      return `<li><div class="who">${h(p.name)}</div><span class="quick">${direct}</span></li>`;
    }).join('');
    return `<details class="card" open>
      <summary>Messages pour les groupes</summary>
      <p class="muted small">Collez ces messages dans le groupe WhatsApp et dans le groupe Signal.</p>
      <h3>1. Annonce</h3>
      <div class="msg">${h(texts.announce)}</div>
      ${shareButtons(texts.announce, 'announce')}
      <h3>2. Rappel avant l'échéance</h3>
      <div class="msg">${h(texts.reminder)}</div>
      ${shareButtons(texts.reminder, 'reminder')}
      ${relance ? `<h3>3. Relances individuelles</h3>
        <p class="muted small">Pour Signal, le message est copié : collez-le dans la conversation qui s'ouvre.</p>
        <ul class="list">${relance}</ul>` : ''}
    </details>`;
  }

  function hostOptions(selected) {
    return data.members.filter((m) => m.active || m.id === selected)
      .map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${h(m.name)}${m.last_hosted ? ` (dernière fois : ${d(m.last_hosted, { month: 'short', year: 'numeric' })})` : ' (jamais organisé)'}</option>`).join('');
  }

  function eventForm(id, ev, submitLabel, extra = '') {
    return `<form id="${id}">
      <label class="field">Titre<input type="text" name="title" required maxlength="80" value="${h(ev.title)}"></label>
      <div class="row2">
        <label class="field">Date<input type="date" name="date" required value="${h(ev.date)}"></label>
        <label class="field">Heure<input type="time" name="time" required value="${h(ev.time)}"></label>
      </div>
      <label class="field">Lieu<input type="text" name="place" maxlength="120" value="${h(ev.place)}" placeholder="Ex. : Chez Marco, Bar du Lac…"></label>
      <label class="field">Adresse<input type="text" name="address" maxlength="200" value="${h(ev.address)}"></label>
      <label class="field">Réponses jusqu'au<input type="date" name="deadline" required value="${h(ev.deadline)}"></label>
      <label class="field">Organisateur<select name="host_id">${hostOptions(ev.host_id)}</select></label>
      <label class="field">Infos (facultatif)<textarea name="notes" maxlength="1000" placeholder="Menu, prix, parking, thème karaoké…">${h(ev.notes)}</textarea></label>
      ${extra}
      <button class="btn primary">${submitLabel}</button>
    </form>`;
  }

  function editCard(ev) {
    return `<details class="card">
      <summary>Modifier la soirée</summary>
      ${eventForm('edit', ev, 'Enregistrer', `<label class="check"><input type="checkbox" name="cancelled" ${ev.cancelled ? 'checked' : ''}> Soirée annulée</label>`)}
    </details>`;
  }

  function createCard() {
    const up = (data.upcoming || []).filter((e) => !e.cancelled);
    const base = up.length ? up[up.length - 1].date : data.today;
    const next = new Date(base + 'T12:00:00');
    next.setMonth(next.getMonth() + 1);
    const date = next.toISOString().slice(0, 10);
    const month = next.toLocaleDateString('fr-CH', { month: 'long' });
    const host = suggestedHost() || data.me;
    const ev = {
      title: `Soirée ${/^[aeiouéèh]/i.test(month) ? "d'" : 'de '}${month}`, date, time: data.event?.time || '19:00',
      place: '', address: '', deadline: addDays(date, -7), host_id: host.id, notes: '',
    };
    return `<details class="card" ${data.event ? '' : 'open'}>
      <summary>Prévoir une nouvelle soirée</summary>
      <p class="muted small">Il peut y en avoir plusieurs dans le mois : changez simplement la date. L'organisateur suggéré est celui qui n'a pas organisé depuis le plus longtemps ; il pourra compléter le lieu lui-même.</p>
      ${eventForm('create', ev, 'Créer la soirée')}
    </details>`;
  }

  function membersCard() {
    const rows = data.members.map((m) => {
      texts['w' + m.id] = welcomeText(m);
      const send = m.is_admin && m.id !== data.me.id
        ? `<button class="btn sm" data-share="w${m.id}" title="Envoyer son lien admin">🔑 Lien</button>` : '';
      return `<li>
        <div class="who"><b>${h(m.name)}</b>
          ${chanPills(m)}
          ${m.is_admin ? '<span class="pill yes">admin</span>' : ''}${m.active ? '' : '<span class="pill off">inactif</span>'}
          <div class="c">${m.phone ? h(m.phone) : 'pas de numéro'}</div></div>
        <span class="quick">${m.active ? send : ''}<button class="btn sm" data-edit-m="${m.id}">✎</button></span>
      </li>`;
    }).join('');
    return `<details class="card">
      <summary>Liste de distribution (${data.members.filter((m) => m.active).length})</summary>
      <p class="muted small">Tout le monde utilise le lien commun et choisit son nom. Seuls les admins ont un lien personnel (bouton 🔑).</p>
      <ul class="list">${rows}</ul>
      <div id="member-form"></div>
      <button class="btn" id="add-member" style="width:100%;margin-top:10px">＋ Ajouter un membre</button>
    </details>`;
  }

  function memberForm(m) {
    const edit = !!m.id;
    return `<form id="mform" class="card" style="margin:12px 0 0;box-shadow:none">
      <h3 style="margin-top:0">${edit ? 'Modifier ' + h(m.name) : 'Nouveau membre'}</h3>
      <label class="field">Prénom / nom<input type="text" name="name" required maxlength="60" value="${h(m.name)}"></label>
      <div class="field">Dans le(s) groupe(s)</div>
      <div class="chk2"><label class="check"><input type="checkbox" name="on_whatsapp" ${m.on_whatsapp ? 'checked' : ''}> WhatsApp</label>
        <label class="check"><input type="checkbox" name="on_signal" ${m.on_signal ? 'checked' : ''}> Signal</label></div>
      <label class="field">Téléphone (facultatif, pour les envois directs)<input type="tel" name="phone" value="${h(m.phone)}" placeholder="+41 79 123 45 67"></label>
      <label class="check"><input type="checkbox" name="is_admin" ${m.is_admin ? 'checked' : ''}> Administrateur</label>
      ${edit ? `<label class="check"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Actif (reçoit les invitations)</label>` : ''}
      <button class="btn primary">${edit ? 'Enregistrer' : 'Ajouter'}</button>
      ${edit ? `<div class="btns">${m.is_admin && m.id !== data.me.id ? '<button type="button" class="btn sm" id="regen">Nouveau lien admin</button>' : ''}<button type="button" class="btn sm" id="mcancel">Fermer</button></div>` : ''}
    </form>`;
  }

  function historyCard() {
    const rows = data.history.map((e) => `<li><div class="who"><a href="#" data-ev="${e.id}">${h(e.title)}</a>
      <div class="c">${h(shortDate(e.date))}${e.place ? ' · ' + h(e.place) : ''} · ${h(e.host_name || '—')}</div></div>
      <span class="muted small">${e.cancelled ? 'annulée' : `${e.people} pers.`}</span></li>`).join('');
    return `<details class="card"><summary>Toutes les soirées</summary><ul class="list">${rows}</ul></details>`;
  }

  // ---------- interactions ----------
  function bind() {
    $app.querySelectorAll('[data-att]').forEach((b) => b.onclick = () => { form.attending = b.dataset.att; readComment(); render(); });
    $app.querySelectorAll('[data-g]').forEach((b) => b.onclick = () => {
      form.guests = Math.max(0, Math.min(20, form.guests + Number(b.dataset.g))); readComment(); render();
    });
    $app.querySelectorAll('[data-tog]').forEach((c) => c.onchange = () => { form[c.dataset.tog] = c.checked ? 1 : 0; });
    const save = document.getElementById('save');
    if (save) save.onclick = async () => {
      readComment();
      save.disabled = true;
      try {
        await call('PUT', '/rsvp', { ...form, event_id: data.event.id });
        toast(form.attending === 'no' ? 'Noté, à la prochaine !' : 'Merci, c’est noté 🎉');
        await load(data.event.id);
      } catch (e) { toast(e.message); save.disabled = false; }
    };

    $app.querySelectorAll('[data-for]').forEach((b) => b.onclick = async () => {
      try {
        await call('PUT', '/rsvp', { event_id: data.event.id, member_id: b.dataset.for, attending: b.dataset.a });
        toast('Réponse enregistrée'); await load(data.event.id);
      } catch (e) { toast(e.message); }
    });

    $app.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copy(texts[b.dataset.copy]));
    $app.querySelectorAll('[data-share]').forEach((b) => b.onclick = () => share(texts[b.dataset.share]));
    $app.querySelectorAll('[data-copyfirst]').forEach((a) => a.addEventListener('click', () => {
      navigator.clipboard?.writeText(texts[a.dataset.copyfirst]).then(() => toast('Message copié — collez-le dans Signal'), () => {});
    }));
    $app.querySelectorAll('[data-ev]').forEach((a) => a.onclick = (e) => { e.preventDefault(); load(a.dataset.ev); scrollTo(0, 0); });

    const toBody = (f) => {
      const o = Object.fromEntries(new FormData(f));
      f.querySelectorAll('input[type=checkbox]').forEach((c) => { o[c.name] = c.checked; });
      return o;
    };
    const edit = document.getElementById('edit');
    if (edit) edit.onsubmit = async (e) => {
      e.preventDefault();
      try { await call('PUT', `/events/${data.event.id}`, toBody(edit)); toast('Soirée mise à jour'); await load(data.event.id); }
      catch (err) { toast(err.message); }
    };
    const create = document.getElementById('create');
    if (create) create.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await call('POST', '/events', toBody(create)); toast('Soirée créée — partagez l’annonce !'); await load(r.id); scrollTo(0, 0); }
      catch (err) { toast(err.message); }
    };

    const lo = document.getElementById('logout');
    if (lo) lo.onclick = (e) => { e.preventDefault(); if (confirm('Changer de personne sur ce téléphone ?')) logout(); };
    const add = document.getElementById('add-member');
    if (add) add.onclick = () => openMemberForm({ on_whatsapp: 1, active: 1 });
    const ch = document.getElementById('change');
    if (ch) ch.onclick = () => { editing = true; form = null; render(); document.getElementById('rsvp').scrollIntoView({ block: 'start' }); };
    const ce = document.getElementById('cancel-edit');
    if (ce) ce.onclick = () => { editing = false; form = null; render(); };
    $app.querySelectorAll('[data-edit-m]').forEach((b) => b.onclick = () => openMemberForm(data.members.find((m) => m.id === Number(b.dataset.editM))));
  }

  function openMemberForm(m) {
    const box = document.getElementById('member-form');
    box.innerHTML = memberForm(m);
    const f = document.getElementById('mform');
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const o = Object.fromEntries(new FormData(f));
      o.is_admin = f.is_admin.checked;
      o.on_whatsapp = f.on_whatsapp.checked;
      o.on_signal = f.on_signal.checked;
      if (!o.on_whatsapp && !o.on_signal) return toast('Cochez au moins WhatsApp ou Signal');
      o.active = f.active ? f.active.checked : true;
      try {
        if (m.id) await call('PUT', `/members/${m.id}`, o); else await call('POST', '/members', o);
        toast(m.id ? 'Membre mis à jour' : `${o.name} ajouté·e — envoyez-lui son lien`);
        await load(data.event?.id);
      } catch (err) { toast(err.message); }
    };
    const regen = document.getElementById('regen');
    if (regen) regen.onclick = async () => {
      if (!confirm(`L'ancien lien de ${m.name} ne fonctionnera plus. Continuer ?`)) return;
      try { await call('POST', `/members/${m.id}/token`); toast('Nouveau lien créé — renvoyez-le'); await load(data.event?.id); }
      catch (err) { toast(err.message); }
    };
    const cancel = document.getElementById('mcancel');
    if (cancel) cancel.onclick = () => { box.innerHTML = ''; };
  }

  function readComment() {
    const c = document.getElementById('comment');
    if (c && form) form.comment = c.value;
  }

  boot();
})();
