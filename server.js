/**
 * Connecting Wall — Render service
 *
 * Serves the game and its API from one origin, so there is no CORS to
 * configure and only one thing to deploy.
 *
 * Every stat is an additive counter, so concurrent players merge with
 * ON CONFLICT DO UPDATE and can never clobber each other — no locking and
 * no read-modify-write race.
 *
 * Env:
 *   DATABASE_URL  Postgres connection string (Render provides this)
 *   PORT          supplied by Render
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — add a Postgres instance and link it.");
}

const isLocal = (process.env.DATABASE_URL || "").includes("localhost");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

app.use(express.json({ limit: "512kb" }));

/* ---------- schema, applied on boot so there's no manual migration step ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cat_stats (
  key      TEXT PRIMARY KEY,
  shown    BIGINT NOT NULL DEFAULT 0,
  solved   BIGINT NOT NULL DEFAULT 0,
  rank_sum BIGINT NOT NULL DEFAULT 0,
  rank_n   BIGINT NOT NULL DEFAULT 0,
  hints    BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pair_stats (
  pair TEXT PRIMARY KEY,
  n    BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS walls (
  id      TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  data    TEXT NOT NULL,
  created BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v BIGINT NOT NULL
);
`;

async function initDb() {
  await pool.query(SCHEMA);
  console.log("schema ready");
}

/* ---------- guards: nothing from the internet is trusted ---------- */
const KEY_RE = /^[a-z0-9-]{1,48}$/;
const PAIR_RE = /^[a-z0-9-]{1,48}~[a-z0-9-]{1,48}$/;
const MAX_WALLS_PER_BATCH = 25;
const MAX_COUNTER = 500;
const MAX_CATS_PER_BATCH = 200;
const MAX_PAIRS_PER_BATCH = 400;
const MAX_LIBRARY = 500;

function clampInt(v, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function sanitiseBatch(body) {
  const cats = {};
  const pairs = {};
  const rawCats = body && typeof body.cats === "object" && body.cats ? body.cats : {};
  const rawPairs = body && typeof body.pairs === "object" && body.pairs ? body.pairs : {};

  let n = 0;
  for (const k of Object.keys(rawCats)) {
    if (n++ >= MAX_CATS_PER_BATCH) break;
    if (!KEY_RE.test(k)) continue;
    const c = rawCats[k] || {};
    const e = {
      shown: clampInt(c.shown, MAX_COUNTER),
      solved: clampInt(c.solved, MAX_COUNTER),
      rankSum: clampInt(c.rankSum, MAX_COUNTER * 4),
      rankN: clampInt(c.rankN, MAX_COUNTER),
      hints: clampInt(c.hints, MAX_COUNTER),
    };
    if (e.shown === 0) continue;
    if (e.solved > e.shown) e.solved = e.shown;
    if (e.rankN > e.shown) e.rankN = e.shown;
    // a mean solve position outside 1..4 is impossible; drop the row
    if (e.rankN > 0 && (e.rankSum < e.rankN || e.rankSum > e.rankN * 4)) continue;
    cats[k] = e;
  }

  let p = 0;
  for (const k of Object.keys(rawPairs)) {
    if (p++ >= MAX_PAIRS_PER_BATCH) break;
    if (!PAIR_RE.test(k)) continue;
    const v = clampInt(rawPairs[k], MAX_COUNTER);
    if (v > 0) pairs[k] = v;
  }

  return { cats, pairs, walls: clampInt(body && body.walls, MAX_WALLS_PER_BATCH) };
}

async function readStats() {
  const [catRes, pairRes, metaRes] = await Promise.all([
    pool.query("SELECT * FROM cat_stats"),
    pool.query("SELECT * FROM pair_stats WHERE n > 0"),
    pool.query("SELECT v FROM meta WHERE k = 'walls'"),
  ]);

  const cats = {};
  for (const r of catRes.rows) {
    cats[r.key] = {
      shown: Number(r.shown), solved: Number(r.solved),
      rankSum: Number(r.rank_sum), rankN: Number(r.rank_n), hints: Number(r.hints),
    };
  }
  const pairs = {};
  for (const r of pairRes.rows) pairs[r.pair] = Number(r.n);
  const wallCount = metaRes.rows[0] ? Number(metaRes.rows[0].v) : 0;
  return { cats, pairs, walls: wallCount };
}

async function readState() {
  const [stats, wallRes] = await Promise.all([
    readStats(),
    pool.query("SELECT data FROM walls ORDER BY created ASC LIMIT $1", [MAX_LIBRARY]),
  ]);
  const walls = [];
  for (const r of wallRes.rows) {
    try { walls.push(JSON.parse(r.data)); } catch { /* skip corrupt row */ }
  }
  return { walls, stats };
}

/* ---------- API ---------- */
app.get("/api/state", async (_req, res) => {
  try {
    res.json(await readState());
  } catch (err) {
    console.error("state:", err.message);
    res.status(500).json({ error: "could not read state" });
  }
});

app.post("/api/stats", async (req, res) => {
  const batch = sanitiseBatch(req.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [k, c] of Object.entries(batch.cats)) {
      await client.query(
        `INSERT INTO cat_stats (key, shown, solved, rank_sum, rank_n, hints)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key) DO UPDATE SET
           shown    = cat_stats.shown    + EXCLUDED.shown,
           solved   = cat_stats.solved   + EXCLUDED.solved,
           rank_sum = cat_stats.rank_sum + EXCLUDED.rank_sum,
           rank_n   = cat_stats.rank_n   + EXCLUDED.rank_n,
           hints    = cat_stats.hints    + EXCLUDED.hints`,
        [k, c.shown, c.solved, c.rankSum, c.rankN, c.hints]
      );
    }
    for (const [k, v] of Object.entries(batch.pairs)) {
      await client.query(
        `INSERT INTO pair_stats (pair, n) VALUES ($1,$2)
         ON CONFLICT (pair) DO UPDATE SET n = pair_stats.n + EXCLUDED.n`,
        [k, v]
      );
    }
    if (batch.walls > 0) {
      await client.query(
        `INSERT INTO meta (k, v) VALUES ('walls', $1)
         ON CONFLICT (k) DO UPDATE SET v = meta.v + EXCLUDED.v`,
        [batch.walls]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("stats:", err.message);
    client.release();
    return res.status(500).json({ error: "could not save stats" });
  }
  /* Release BEFORE reading back. Holding the transaction's client while
     asking the same pool for another one deadlocks as soon as there are
     more concurrent writers than pool slots. */
  client.release();

  try {
    res.json({ ok: true, stats: await readStats() });
  } catch (err) {
    console.error("stats readback:", err.message);
    res.json({ ok: true });
  }
});

app.post("/api/walls", async (req, res) => {
  const incoming = Array.isArray(req.body && req.body.walls)
    ? req.body.walls.slice(0, MAX_LIBRARY) : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM walls");
    const now = Date.now();
    let saved = 0;
    for (let i = 0; i < incoming.length; i++) {
      const w = incoming[i];
      if (!w || typeof w.id !== "string" || typeof w.title !== "string") continue;
      if (!Array.isArray(w.groups) || w.groups.length !== 4) continue;
      const data = JSON.stringify(w);
      if (data.length > 8000) continue;
      await client.query(
        "INSERT INTO walls (id, title, data, created) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
        [w.id.slice(0, 64), w.title.slice(0, 200), data, now + i]
      );
      saved++;
    }
    await client.query("COMMIT");
    client.release();
    res.json({ ok: true, count: saved });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("walls:", err.message);
    client.release();
    res.status(500).json({ error: "could not save walls" });
  }
});

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* ---------- the game ----------
   The page ships with BACKEND set to "", so the identical file also works
   as a plain static upload. Serving it from here flips it to same-origin,
   which is why there is nothing to edit by hand. */
const PAGE_PATH = path.join(__dirname, "public", "index.html");
let page = null;

function loadPage() {
  const raw = fs.readFileSync(PAGE_PATH, "utf8");
  const patched = raw.replace('var BACKEND = "";', 'var BACKEND = "same-origin";');
  if (patched === raw) {
    console.warn("BACKEND line not found in index.html — page will run device-local");
  }
  return patched;
}

app.get("/", (_req, res) => {
  try {
    if (!page || process.env.NODE_ENV !== "production") page = loadPage();
    res.type("html").send(page);
  } catch (err) {
    console.error("page:", err.message);
    res.status(500).send("index.html is missing from public/");
  }
});

app.use(express.static(path.join(__dirname, "public")));

initDb()
  .then(() => app.listen(PORT, () => console.log(`connecting wall listening on ${PORT}`)))
  .catch((err) => {
    console.error("could not initialise database:", err.message);
    // still serve the game; it falls back to device-local storage
    app.listen(PORT, () => console.log(`listening on ${PORT} (no database)`));
  });
