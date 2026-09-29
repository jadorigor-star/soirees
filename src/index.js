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

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Requête invalide'); }
}

async function auth(request, env) {
  const token = request.headers.get('x-token') || new URL(request.url).searchParams.get('t');
  if (!token) throw new HttpError(401, 'Lien personnel manquant');
  const me = await env.DB.prepare('SELECT * FROM members WHERE token = ? AND active = 1').bind(token).first();
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
    await env.DB.prepare('INSERT INTO members (name, token, channel, phone, is_admin) VALUES (?, ?, ?, ?, 1)')
      .bind(name, token, b.channel === 'signal' ? 'signal' : 'whatsapp', clean(b.phone, 30)).run();
    return json({ token });
  }

  // --- Lien commun : chacun choisit son nom dans la liste ---
  if (path === '/roster' && method === 'GET') {
    const rows = (await env.DB.prepare(
      'SELECT id, name, is_admin FROM members WHERE active = 1 ORDER BY lower(name)'
    ).all()).results;
    return json({ members: rows.map((r) => ({ id: r.id, name: r.name, admin: !!r.is_admin })) });
  }
  if (path === '/claim' && method === 'POST') {
    const b = await body(request);
    const row = await env.DB.prepare('SELECT token, is_admin FROM members WHERE id = ? AND active = 1')
      .bind(Number(b.member_id)).first();
    if (!row) throw new HttpError(404, 'Membre introuvable');
    // Les administrateurs gardent leur lien perso : il donne accès à la gestion.
    if (row.is_admin) throw new HttpError(403, 'Les administrateurs utilisent leur lien personnel');
    return json({ token: row.token });
  }
  // --- Calendrier (.ics) : accessible avec ?t= pour les applis agenda ---
  if ((m = path.match(/^\/events\/(\d+)\/ics$/)) && method === 'GET') {
    await auth(request, env);
    const ev = await getEvent(env, Number(m[1]));
    return new Response(ics(ev, url.origin), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `attachment; filename="soiree-${ev.date}.ics"`,
      },
    });
  }

  const me = await auth(request, env);

  // --- Tableau de bord du membre ---
  if (path === '/me' && method === 'GET') {
    const wanted = url.searchParams.get('event');
    const ev = wanted ? await getEvent(env, Number(wanted)) : await currentEvent(env);
    const editor = canEdit(me, ev);
    const members = (await env.DB.prepare(
      `SELECT m.id, m.name, m.channel, m.phone, m.is_admin, m.active, m.token,
              (SELECT MAX(date) FROM events WHERE host_id = m.id AND cancelled = 0) AS last_hosted
         FROM members m ORDER BY m.active DESC, lower(m.name)`
    ).all()).results.map((x) => ({
      id: x.id, name: x.name, channel: x.channel, is_admin: x.is_admin, active: x.active, last_hosted: x.last_hosted,
      phone: me.is_admin || editor ? x.phone : undefined,
      token: me.is_admin ? x.token : undefined,
    }));

    let rsvps = [];
    if (ev) {
      rsvps = (await env.DB.prepare(
        `SELECT r.*, m.name, m.channel FROM rsvps r JOIN members m ON m.id = r.member_id
          WHERE r.event_id = ? ORDER BY r.attending = 'yes' DESC, r.attending = 'maybe' DESC, lower(m.name)`
      ).bind(ev.id).all()).results;
    }
    const answered = new Set(rsvps.map((r) => r.member_id));
    const pending = members.filter((x) => x.active && !answered.has(x.id));

    const history = (await env.DB.prepare(
      `SELECT e.id, e.title, e.date, e.place, e.cancelled, e.host_id, m.name AS host_name,
              (SELECT COALESCE(SUM(1 + guests), 0) FROM rsvps WHERE event_id = e.id AND attending = 'yes') AS people
         FROM events e LEFT JOIN members m ON m.id = e.host_id ORDER BY e.date DESC LIMIT 24`
    ).all()).results;

    const latest = history[0];
    return json({
      me: { id: me.id, name: me.name, channel: me.channel, phone: me.phone, is_admin: !!me.is_admin },
      today: todayZurich(),
      event: ev || null,
      rsvps,
      pending,
      members,
      history,
      canEdit: editor,
      // Crée la soirée suivante : l'admin, ou l'organisateur de la dernière soirée prévue
      canCreate: !!me.is_admin || !latest || latest.host_id === me.id,
    });
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
       ON CONFLICT (event_id, member_id) DO UPDATE SET attending = excluded.attending, guests = excluded.guests,
         eat = excluded.eat, sing = excluded.sing, drink = excluded.drink, comment = excluded.comment,
         updated_at = excluded.updated_at`
    ).bind(ev.id, memberId, b.attending, guests,
      bool(going && b.eat), bool(going && b.sing), bool(going && b.drink), clean(b.comment, 280)).run();
    return json({ ok: true });
  }

  // --- Soirées ---
  if (path === '/events' && method === 'POST') {
    const latest = await env.DB.prepare('SELECT host_id FROM events ORDER BY date DESC LIMIT 1').first();
    if (!me.is_admin && latest && latest.host_id !== me.id) {
      throw new HttpError(403, "Seul l'organisateur actuel ou un admin peut créer la prochaine soirée");
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
    const r = await env.DB.prepare('INSERT INTO members (name, token, channel, phone, is_admin) VALUES (?, ?, ?, ?, ?)')
      .bind(name, newToken(), b.channel === 'signal' ? 'signal' : 'whatsapp', clean(b.phone, 30), bool(b.is_admin)).run();
    return json({ id: r.meta.last_row_id });
  }
  if ((m = path.match(/^\/members\/(\d+)$/)) && method === 'PUT') {
    requireAdmin(me);
    const id = Number(m[1]);
    const b = await body(request);
    const name = clean(b.name, 60);
    if (!name) throw new HttpError(400, 'Nom requis');
    if (id === me.id && (!b.is_admin || !b.active)) throw new HttpError(400, 'Vous ne pouvez pas retirer vos propres droits');
    await env.DB.prepare('UPDATE members SET name = ?, channel = ?, phone = ?, is_admin = ?, active = ? WHERE id = ?')
      .bind(name, b.channel === 'signal' ? 'signal' : 'whatsapp', clean(b.phone, 30), bool(b.is_admin), bool(b.active), id).run();
    return json({ ok: true });
  }
  if ((m = path.match(/^\/members\/(\d+)\/token$/)) && method === 'POST') {
    requireAdmin(me);
    await env.DB.prepare('UPDATE members SET token = ? WHERE id = ?').bind(newToken(), Number(m[1])).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Route inconnue');
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
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Soirees du mois//FR', 'CALSCALE:GREGORIAN',
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
  ].filter(Boolean).join('\r\n');
}
