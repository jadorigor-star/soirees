// Soirées du mois — Worker Cloudflare (API + fichiers statiques)
// Stockage : D1 (binding DB). Interface : /public (servie par le binding ASSETS).

const TZ = 'Europe/Zurich';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        return json({ error: 'Erreur interne' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function todayZurich() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

const clean = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max) || null);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const isTime = (v) => /^\d{2}:\d{2}$/.test(v || '');
const bool = (v) => (v ? 1 : 0);

// Messageries d'un membre : WhatsApp, Signal ou les deux (au moins une)
function channels(b) {
  let wa = bool(b.on_whatsapp), sg = bool(b.on_signal);
  if (!wa && !sg) wa = 1;
  return { wa, sg, legacy: sg && !wa ? 'signal' : 'whatsapp' };
}

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Requête invalide'); }
}

async function auth(request, env) {
  const token = request.headers.get('x-token') || new URL(request.url).searchParams.get('t');
  if (!token) throw new HttpError(401, 'Lien personnel manquant');
  const me = await env.DB.prepare('SELECT * FROM members WHERE token = ? AND active = 1 AND blocked = 0').bind(token).first();
  if (!me) throw new HttpError(401, 'Lien personnel inconnu ou désactivé');
  return me;
}

async function currentEvent(env) {
  const today = todayZurich();
  const q = `SELECT e.*, m.name AS host_name FROM events e LEFT JOIN members m ON m.id = e.host_id`;
  return (
    (await env.DB.prepare(`${q} WHERE e.date >= ? AND e.cancelled = 0 ORDER BY e.date ASC LIMIT 1`).bind(today).first()) ||
    (await env.DB.prepare(`${q} ORDER BY e.date DESC LIMIT 1`).first())
  );
}

async function getEvent(env, id) {
  const ev = await env.DB.prepare(
    `SELECT e.*, m.name AS host_name FROM events e LEFT JOIN members m ON m.id = e.host_id WHERE e.id = ?`
  ).bind(id).first();
  if (!ev) throw new HttpError(404, 'Soirée introuvable');
  return ev;
}

const canEdit = (me, ev) => !!me.is_admin || (ev && ev.host_id === me.id);

async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;
  let m;

  // --- Première installation : le premier membre devient administrateur ---
  if (path === '/setup' && method === 'GET') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first();
    return json({ needsSetup: row.n === 0 });
  }
  if (path === '/setup' && method === 'POST') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first();
    if (row.n > 0) throw new HttpError(403, 'Déjà configuré');
    const b = await body(request);
    const name = clean(b.name, 60);
    if (!name) throw new HttpError(400, 'Nom requis');
    const token = newToken();
    const c = channels(b);
    await env.DB.prepare('INSERT INTO members (name, token, channel, on_whatsapp, on_signal, phone, is_admin) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .bind(name, token, c.legacy, c.wa, c.sg, clean(b.phone, 30)).run();
    return json({ token });
  }

  // --- Lien commun : chacun choisit son nom dans la liste ---
  if (path === '/roster' && method === 'GET') {
    const rows = (await env.DB.prepare(
      'SELECT id, name, is_admin FROM members WHERE active = 1 AND blocked = 0 ORDER BY lower(name)'
    ).all()).results;
    return json({ members: rows.map((r) => ({ id: r.id, name: r.name, admin: !!r.is_admin })) });
  }
  if (path === '/claim' && method === 'POST') {
    const b = await body(request);
    const row = await env.DB.prepare('SELECT token, is_admin FROM members WHERE id = ? AND active = 1 AND blocked = 0')
      .bind(Number(b.member_id)).first();
    if (!row) throw new HttpError(404, 'Membre introuvable');
    // Les administrateurs gardent leur lien perso : il donne accès à la gestion.
    if (row.is_admin) throw new HttpError(403, 'Les administrateurs utilisent leur lien personnel');
    return json({ token: row.token });
  }
  // --- Inscription libre depuis le lien commun ---
  if (path === '/join' && method === 'POST') {
    const b = await body(request);
    const name = clean(b.name, 60);
    if (!name) throw new HttpError(400, 'Indique ton prénom');
    const banned = await env.DB.prepare('SELECT id FROM members WHERE lower(name) = lower(?) AND blocked = 1').bind(name).first();
    if (banned) throw new HttpError(403, "Ce nom n'est pas disponible. Contacte l'organisateur.");
    await assertFreeName(env, name);
    const c = channels(b);
    const token = newToken();
    // Quelqu'un qui avait quitté le groupe revient : on réactive sa fiche (historique conservé)
    const old = await env.DB.prepare('SELECT id FROM members WHERE lower(name) = lower(?) AND active = 0 AND blocked = 0 ORDER BY id DESC LIMIT 1').bind(name).first();
    if (old) {
      await env.DB.prepare('UPDATE members SET active = 1, token = ?, channel = ?, on_whatsapp = ?, on_signal = ?, phone = COALESCE(?, phone) WHERE id = ?')
        .bind(token, c.legacy, c.wa, c.sg, clean(b.phone, 30), old.id).run();
      return json({ token });
    }
    await env.DB.prepare('INSERT INTO members (name, token, channel, on_whatsapp, on_signal, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(name, token, c.legacy, c.wa, c.sg, clean(b.phone, 30)).run();
    return json({ token });
  }

  // --- Calendrier (.ics) : ouvert directement par Safari / Agenda, sans en-têtes d'authentification ---
  if ((m = path.match(/^\/events\/(\d+)\/[\w-]*\.ics$/)) && method === 'GET') {
    const ev = await getEvent(env, Number(m[1]));
    return new Response(ics(ev, url.origin), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `inline; filename="soiree-${ev.date}.ics"`,
        'cache-control': 'no-store',
      },
    });
  }

  const me = await auth(request, env);

  // --- Tableau de bord du membre ---
  if (path === '/me' && method === 'GET') {
    const wanted = url.searchParams.get('event');
    const ev = wanted ? await getEvent(env, Number(wanted)) : await currentEvent(env);
    // Toutes les soirées à venir (il peut y en avoir plusieurs dans le mois)
    const upcoming = (await env.DB.prepare(
      `SELECT e.id, e.title, e.date, e.time, e.cancelled, e.host_id, r.attending AS mine
         FROM events e LEFT JOIN rsvps r ON r.event_id = e.id AND r.member_id = ?
        WHERE e.date >= ? ORDER BY e.date, e.time`
    ).bind(me.id, todayZurich()).all()).results;
    const editor = canEdit(me, ev);
    const members = (await env.DB.prepare(
      `SELECT m.id, m.name, m.on_whatsapp, m.on_signal, m.phone, m.is_admin, m.active, m.blocked, m.token,
              (SELECT MAX(date) FROM events WHERE host_id = m.id AND cancelled = 0) AS last_hosted
         FROM members m ORDER BY m.active DESC, lower(m.name)`
    ).all()).results.map((x) => ({
      id: x.id, name: x.name, on_whatsapp: x.on_whatsapp, on_signal: x.on_signal, is_admin: x.is_admin, active: x.active, blocked: x.blocked, last_hosted: x.last_hosted,
      phone: me.is_admin || editor ? x.phone : undefined,
      token: me.is_admin ? x.token : undefined,
    }));

    let rsvps = [];
    if (ev) {
      rsvps = (await env.DB.prepare(
        `SELECT r.*, m.name, m.on_whatsapp, m.on_signal FROM rsvps r JOIN members m ON m.id = r.member_id
          WHERE r.event_id = ? ORDER BY r.attending = 'yes' DESC, r.attending = 'maybe' DESC, lower(m.name)`
      ).bind(ev.id).all()).results;
    }
    const answered = new Set(rsvps.map((r) => r.member_id));
    const pending = members.filter((x) => x.active && !x.blocked && !answered.has(x.id));

    const history = (await env.DB.prepare(
      `SELECT e.id, e.title, e.date, e.place, e.cancelled, e.host_id, m.name AS host_name,
              (SELECT COALESCE(SUM(1 + guests), 0) FROM rsvps WHERE event_id = e.id AND attending = 'yes') AS people
         FROM events e LEFT JOIN members m ON m.id = e.host_id ORDER BY e.date DESC LIMIT 24`
    ).all()).results;

    const latest = history[0];
    return json({
      me: { id: me.id, name: me.name, phone: me.phone, on_whatsapp: me.on_whatsapp, on_signal: me.on_signal, is_admin: !!me.is_admin },
      upcoming,
      today: todayZurich(),
      event: ev || null,
      rsvps,
      pending,
      members,
      history,
      canEdit: editor,
      canCreate: await mayCreate(env, me),
    });
  }

  // --- Quitter le groupe ---
  if (path === '/me/leave' && method === 'POST') {
    if (me.is_admin) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE is_admin = 1 AND active = 1').first();
      if (n.n <= 1) throw new HttpError(400, "Tu es le seul administrateur : nomme d'abord quelqu'un d'autre admin");
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rsvps WHERE member_id = ? AND event_id IN (SELECT id FROM events WHERE date >= ?)').bind(me.id, todayZurich()),
      env.DB.prepare('UPDATE members SET active = 0, is_admin = 0, token = ? WHERE id = ?').bind(newToken(), me.id),
    ]);
    return json({ ok: true });
  }

  // --- Modifier son propre profil (nom affiché, messageries, téléphone) ---
  if (path === '/me' && method === 'PUT') {
    const b = await body(request);
    const name = clean(b.name, 60);
    if (!name) throw new HttpError(400, 'Nom requis');
    await assertFreeName(env, name, me.id);
    const c = channels(b);
    await env.DB.prepare('UPDATE members SET name = ?, channel = ?, on_whatsapp = ?, on_signal = ?, phone = ? WHERE id = ?')
      .bind(name, c.legacy, c.wa, c.sg, clean(b.phone, 30), me.id).run();
    return json({ ok: true });
  }

  // --- Répondre / modifier sa réponse ---
  if (path === '/rsvp' && method === 'PUT') {
    const b = await body(request);
    const ev = await getEvent(env, Number(b.event_id));
    if (ev.cancelled) throw new HttpError(400, 'Cette soirée est annulée');
    if (!['yes', 'maybe', 'no'].includes(b.attending)) throw new HttpError(400, 'Réponse invalide');
    // Un organisateur ou un admin peut répondre pour quelqu'un (ex. : réponse reçue par message)
    let memberId = me.id;
    if (b.member_id && Number(b.member_id) !== me.id) {
      if (!canEdit(me, ev)) throw new HttpError(403, 'Non autorisé');
      memberId = Number(b.member_id);
    }
    const going = b.attending !== 'no';
    const guests = going ? Math.max(0, Math.min(20, parseInt(b.guests, 10) || 0)) : 0;
    await env.DB.prepare(
      `INSERT INTO rsvps (event_id, member_id, attending, guests, eat, sing, drink, comment, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (event_id, member_id) DO UPDATE SET
         changed = CASE WHEN rsvps.attending <> excluded.attending THEN 1 ELSE rsvps.changed END,
         previous = CASE WHEN rsvps.attending <> excluded.attending THEN rsvps.attending ELSE rsvps.previous END,
         attending = excluded.attending, guests = excluded.guests,
         eat = excluded.eat, sing = excluded.sing, drink = excluded.drink, comment = excluded.comment,
         updated_at = excluded.updated_at`
    ).bind(ev.id, memberId, b.attending, guests,
      bool(going && b.eat), bool(going && b.sing), bool(going && b.drink), clean(b.comment, 280)).run();
    return json({ ok: true });
  }

  // --- Retirer une réponse (organisateur de la soirée ou admin) ---
  if ((m = path.match(/^\/rsvp\/(\d+)\/(\d+)$/)) && method === 'DELETE') {
    const ev = await getEvent(env, Number(m[1]));
    if (!canEdit(me, ev)) throw new HttpError(403, "Seul l'organisateur de cette soirée ou un admin peut retirer une réponse");
    await env.DB.prepare('DELETE FROM rsvps WHERE event_id = ? AND member_id = ?').bind(ev.id, Number(m[2])).run();
    return json({ ok: true });
  }

  // --- Soirées ---
  if (path === '/events' && method === 'POST') {
    if (!(await mayCreate(env, me))) {
      throw new HttpError(403, "Seul un organisateur d'une soirée à venir ou un admin peut en créer une nouvelle");
    }
    const e = eventFields(await body(request));
    const r = await env.DB.prepare(
      `INSERT INTO events (title, date, time, place, address, notes, deadline, host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(e.title, e.date, e.time, e.place, e.address, e.notes, e.deadline, e.host_id).run();
    return json({ id: r.meta.last_row_id });
  }
  if ((m = path.match(/^\/events\/(\d+)$/)) && method === 'PUT') {
    const ev = await getEvent(env, Number(m[1]));
    if (!canEdit(me, ev)) throw new HttpError(403, "Seul l'organisateur de cette soirée peut la modifier");
    const b = await body(request);
    const e = eventFields(b);
    await env.DB.prepare(
      `UPDATE events SET title = ?, date = ?, time = ?, place = ?, address = ?, notes = ?, deadline = ?, host_id = ?, cancelled = ? WHERE id = ?`
    ).bind(e.title, e.date, e.time, e.place, e.address, e.notes, e.deadline, e.host_id, bool(b.cancelled), ev.id).run();
    return json({ ok: true });
  }

  // --- Liste de distribution (admin) ---
  if (path === '/members' && method === 'POST') {
    requireAdmin(me);
    const b = await body(request);
    const name = clean(b.name, 60);
    if (!name) throw new HttpError(400, 'Nom requis');
    await assertFreeName(env, name);
    const c = channels(b);
    const r = await env.DB.prepare('INSERT INTO members (name, token, channel, on_whatsapp, on_signal, phone, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(name, newToken(), c.legacy, c.wa, c.sg, clean(b.phone, 30), bool(b.is_admin)).run();
    return json({ id: r.meta.last_row_id });
  }
  if ((m = path.match(/^\/members\/(\d+)$/)) && method === 'PUT') {
    requireAdmin(me);
    const id = Number(m[1]);
    const b = await body(request);
    const name = clean(b.name, 60);
    if (!name) throw new HttpError(400, 'Nom requis');
    await assertFreeName(env, name, id);
    if (id === me.id && (!b.is_admin || !b.active)) throw new HttpError(400, 'Vous ne pouvez pas retirer vos propres droits');
    const c = channels(b);
    await env.DB.prepare('UPDATE members SET name = ?, channel = ?, on_whatsapp = ?, on_signal = ?, phone = ?, is_admin = ?, active = ? WHERE id = ?')
      .bind(name, c.legacy, c.wa, c.sg, clean(b.phone, 30), bool(b.is_admin), bool(b.active), id).run();
    return json({ ok: true });
  }
  // Bloquer / débloquer : un membre bloqué disparaît de la liste, perd l'accès et ne peut pas se réinscrire sous ce nom
  if ((m = path.match(/^\/members\/(\d+)\/block$/)) && method === 'POST') {
    requireAdmin(me);
    const id = Number(m[1]);
    if (id === me.id) throw new HttpError(400, 'Vous ne pouvez pas vous bloquer vous-même');
    const b = await body(request);
    if (b.blocked) {
      await env.DB.batch([
        env.DB.prepare('UPDATE members SET blocked = 1, active = 0, is_admin = 0, token = ? WHERE id = ?').bind(newToken(), id),
        env.DB.prepare('DELETE FROM rsvps WHERE member_id = ? AND event_id IN (SELECT id FROM events WHERE date >= ?)').bind(id, todayZurich()),
      ]);
    } else {
      await env.DB.prepare('UPDATE members SET blocked = 0, active = 1 WHERE id = ?').bind(id).run();
    }
    return json({ ok: true });
  }
  // Supprimer définitivement un membre et toutes ses réponses
  if ((m = path.match(/^\/members\/(\d+)$/)) && method === 'DELETE') {
    requireAdmin(me);
    const id = Number(m[1]);
    if (id === me.id) throw new HttpError(400, 'Vous ne pouvez pas vous supprimer vous-même');
    await env.DB.batch([
      env.DB.prepare('UPDATE events SET host_id = NULL WHERE host_id = ?').bind(id),
      env.DB.prepare('DELETE FROM rsvps WHERE member_id = ?').bind(id),
      env.DB.prepare('DELETE FROM members WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }
  if ((m = path.match(/^\/members\/(\d+)\/token$/)) && method === 'POST') {
    requireAdmin(me);
    await env.DB.prepare('UPDATE members SET token = ? WHERE id = ?').bind(newToken(), Number(m[1])).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Route inconnue');
}

// Peut créer une soirée : un admin, l'organisateur d'une soirée à venir,
// ou celui de la dernière soirée (pour passer le relais au suivant).
async function mayCreate(env, me) {
  if (me.is_admin) return true;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN host_id = ? AND date >= ? THEN 1 ELSE 0 END) AS upcoming_mine,
            (SELECT host_id FROM events ORDER BY date DESC LIMIT 1) AS last_host
       FROM events`
  ).bind(me.id, todayZurich()).first();
  return row.n === 0 || row.upcoming_mine > 0 || row.last_host === me.id;
}

// Deux membres actifs ne peuvent pas porter le même nom (sinon on ne sait plus qui choisir).
async function assertFreeName(env, name, exceptId = 0) {
  const dup = await env.DB.prepare('SELECT id FROM members WHERE lower(name) = lower(?) AND active = 1 AND id <> ?')
    .bind(name, exceptId).first();
  if (dup) throw new HttpError(409, `« ${name} » existe déjà : choisis ce nom dans la liste, ou ajoute une initiale`);
}

function requireAdmin(me) {
  if (!me.is_admin) throw new HttpError(403, 'Réservé aux administrateurs');
}

function eventFields(b) {
  const e = {
    title: clean(b.title, 80),
    date: b.date,
    time: b.time || '19:00',
    place: clean(b.place, 120),
    address: clean(b.address, 200),
    notes: clean(b.notes, 1000),
    deadline: b.deadline,
    host_id: b.host_id ? Number(b.host_id) : null,
  };
  if (!e.title) throw new HttpError(400, 'Titre requis');
  if (!isDate(e.date)) throw new HttpError(400, 'Date invalide');
  if (!isTime(e.time)) throw new HttpError(400, 'Heure invalide');
  if (!isDate(e.deadline)) throw new HttpError(400, 'Échéance invalide');
  if (e.deadline > e.date) throw new HttpError(400, "L'échéance doit précéder la soirée");
  return e;
}

// --- Export agenda avec rappel la veille ---
function ics(ev, origin) {
  const d = ev.date.replace(/-/g, '');
  const [h, mi] = ev.time.split(':').map(Number);
  const endH = String(Math.min(23, h + 4)).padStart(2, '0');
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const location = [ev.place, ev.address].filter(Boolean).join(', ');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Soirees du mois//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Zurich',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:soiree-${ev.id}@${new URL(origin).host}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/Zurich:${d}T${String(h).padStart(2, '0')}${String(mi).padStart(2, '0')}00`,
    `DTEND;TZID=Europe/Zurich:${d}T${endH}${String(mi).padStart(2, '0')}00`,
    `SUMMARY:${esc(ev.title)}`,
    location ? `LOCATION:${esc(location)}` : null,
    `DESCRIPTION:${esc((ev.notes ? ev.notes + '\n\n' : '') + 'Organisé par ' + (ev.host_name || '?'))}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.title)} demain`, 'TRIGGER:-PT24H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

// Les lignes iCalendar ne doivent pas dépasser 75 octets (RFC 5545) : Apple Agenda y est sensible.
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { out.push(cur); cur = ''; size = 0; limit = 74; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
