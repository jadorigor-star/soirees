-- Réglages généraux de l'app (ex. : titre affiché), modifiables par un administrateur
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
