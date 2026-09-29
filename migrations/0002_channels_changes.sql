-- Un membre peut être sur WhatsApp, sur Signal, ou sur les deux
ALTER TABLE members ADD COLUMN on_whatsapp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN on_signal INTEGER NOT NULL DEFAULT 0;
UPDATE members SET on_whatsapp = (channel = 'whatsapp'), on_signal = (channel = 'signal');

-- Suivi des changements d'avis
ALTER TABLE rsvps ADD COLUMN changed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rsvps ADD COLUMN previous TEXT;
