-- Membres bloqués par un administrateur : n'apparaissent plus, ne peuvent plus répondre ni se réinscrire sous ce nom
ALTER TABLE members ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
