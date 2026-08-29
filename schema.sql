-- Connecting Wall — database schema (Postgres)
-- Reference only: server.js applies this itself on boot.
-- Everything is an additive counter, so concurrent players merge safely.

CREATE TABLE IF NOT EXISTS cat_stats (
  key      TEXT PRIMARY KEY,
  shown    BIGINT NOT NULL DEFAULT 0,  -- times this category appeared in a wall
  solved   BIGINT NOT NULL DEFAULT 0,  -- times players found it
  rank_sum BIGINT NOT NULL DEFAULT 0,  -- sum of solve positions (1st..4th)
  rank_n   BIGINT NOT NULL DEFAULT 0,  -- how many ranks are in that sum
  hints    BIGINT NOT NULL DEFAULT 0   -- times a hint was spent on it
);

-- Which two categories players actually confuse with each other.
-- 'pair' is the two category keys, sorted, joined by a tilde.
CREATE TABLE IF NOT EXISTS pair_stats (
  pair TEXT PRIMARY KEY,
  n    BIGINT NOT NULL DEFAULT 0
);

-- Shared saved walls.
CREATE TABLE IF NOT EXISTS walls (
  id      TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  data    TEXT NOT NULL,               -- the wall as JSON
  created BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS walls_created ON walls (created);

-- Scalars (currently just the total wall count).
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v BIGINT NOT NULL
);
