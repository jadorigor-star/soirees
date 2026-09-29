-- Membres de la liste de distribution
CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,          -- lien personnel secret
  channel     TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','signal')),
  phone       TEXT,                           -- optionnel, format international (+41...)
  is_admin    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Une soirée par mois, chaque fois organisée par un membre différent
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,                  -- YYYY-MM-DD
  time        TEXT NOT NULL DEFAULT '19:00',  -- HH:MM (heure de Zurich)
  place       TEXT,                           -- nom du lieu
  address     TEXT,
  notes       TEXT,
  deadline    TEXT NOT NULL,                  -- YYYY-MM-DD, réponses jusqu'à 23:59
  host_id     INTEGER REFERENCES members(id),
  cancelled   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Réponses : une ligne par membre et par soirée
CREATE TABLE IF NOT EXISTS rsvps (
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  attending   TEXT NOT NULL CHECK (attending IN ('yes','maybe','no')),
  guests      INTEGER NOT NULL DEFAULT 0,     -- nombre d'accompagnants
  eat         INTEGER NOT NULL DEFAULT 0,
  sing        INTEGER NOT NULL DEFAULT 0,
  drink       INTEGER NOT NULL DEFAULT 0,
  comment     TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
