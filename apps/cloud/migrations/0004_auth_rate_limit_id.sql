ALTER TABLE auth."rateLimit"
  ADD COLUMN id text;

UPDATE auth."rateLimit"
SET id = key
WHERE id IS NULL;

ALTER TABLE auth."rateLimit"
  ALTER COLUMN id SET NOT NULL,
  DROP CONSTRAINT "rateLimit_pkey",
  ADD CONSTRAINT "rateLimit_pkey" PRIMARY KEY (id),
  ADD CONSTRAINT "rateLimit_key_key" UNIQUE (key);
