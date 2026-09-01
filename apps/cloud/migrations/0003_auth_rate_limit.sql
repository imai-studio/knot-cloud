CREATE TABLE auth."rateLimit" (
  key text PRIMARY KEY,
  count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth."rateLimit" TO knot_app;
