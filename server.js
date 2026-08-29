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
CREATE TABLE IF NOT EXISTS players (
  name         TEXT PRIMARY KEY,      -- lowercased; display kept separately
  display_name TEXT NOT NULL,
  points       BIGINT NOT NULL DEFAULT 0,
  played       BIGINT NOT NULL DEFAULT 0,
  won          BIGINT NOT NULL DEFAULT 0,
  streak       BIGINT NOT NULL DEFAULT 0,
  best_streak  BIGINT NOT NULL DEFAULT 0,
  last_daily   TEXT,                  -- last daily WON (YYYY-MM-DD), drives streaks
  created      BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_results (
  day      TEXT NOT NULL,
  name     TEXT NOT NULL,
  won      BOOLEAN NOT NULL,
  mistakes INTEGER NOT NULL,
  time_s   INTEGER NOT NULL,
  score    INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);
`;

async function initDb() {
  await pool.query(SCHEMA);
  // additive migrations for databases created before these columns existed
  await pool.query("ALTER TABLE walls ADD COLUMN IF NOT EXISTS author TEXT");
  await pool.query("ALTER TABLE walls ADD COLUMN IF NOT EXISTS plays BIGINT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE walls ADD COLUMN IF NOT EXISTS solves BIGINT NOT NULL DEFAULT 0");
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
const NAME_RE = /^[a-z0-9 _-]{2,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SCORE = 1000;
const MAX_TIME_S = 6 * 3600;

function normName(raw) {
  const display = String(raw || "").trim().slice(0, 20);
  const key = display.toLowerCase();
  return NAME_RE.test(key) ? { key, display } : null;
}

function ukToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

function prevDay(day) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function profileRow(r) {
  return {
    name: r.display_name,
    points: Number(r.points), played: Number(r.played), won: Number(r.won),
    streak: Number(r.streak), bestStreak: Number(r.best_streak),
    lastDaily: r.last_daily || null,
  };
}

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
    pool.query("SELECT data, author, plays, solves FROM walls ORDER BY created ASC LIMIT $1", [MAX_LIBRARY]),
  ]);
  const walls = [];
  for (const r of wallRes.rows) {
    try {
      const w = JSON.parse(r.data);
      w.author = r.author || null;
      w.plays = Number(r.plays) || 0;
      w.solves = Number(r.solves) || 0;
      walls.push(w);
    } catch { /* skip corrupt row */ }
  }
  return { walls, stats };
}

function validWall(w) {
  if (!w || typeof w.id !== "string" || typeof w.title !== "string") return null;
  if (!Array.isArray(w.groups) || w.groups.length !== 4) return null;
  for (const g of w.groups) {
    if (!g || typeof g.label !== "string" || !Array.isArray(g.items) || g.items.length !== 4) return null;
  }
  const clean = {
    id: w.id.slice(0, 64),
    title: w.title.slice(0, 200),
    difficulty: typeof w.difficulty === "string" ? w.difficulty.slice(0, 20) : undefined,
    traps: typeof w.traps === "number" ? Math.max(0, Math.min(99, Math.floor(w.traps))) : undefined,
    groups: w.groups.map((g) => ({
      label: String(g.label).slice(0, 120),
      color: ["sage","gold","slate","brick"].includes(g.color) ? g.color : "sage",
      tier: typeof g.tier === "number" ? Math.max(0, Math.min(3, Math.floor(g.tier))) : undefined,
      items: g.items.map((it) => String(it).slice(0, 300)),  // image URLs run long
    })),
  };
  const data = JSON.stringify(clean);
  return data.length <= 8000 ? { clean, data } : null;
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

/* Add ONE wall to the community library, credited to its author.
   The old replace-the-whole-library endpoint is gone: it let any visitor
   wipe every other player's walls in a single request. */
app.post("/api/wall", async (req, res) => {
  const v = validWall(req.body && req.body.wall);
  if (!v) return res.status(400).json({ error: "bad wall" });
  const nm = normName(req.body && req.body.author);
  try {
    const count = await pool.query("SELECT COUNT(*) AS n FROM walls");
    if (Number(count.rows[0].n) >= MAX_LIBRARY) {
      return res.status(409).json({ error: "library full" });
    }
    await pool.query(
      `INSERT INTO walls (id, title, data, author, created) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [v.clean.id, v.clean.title, v.data, nm ? nm.display : null, Date.now()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("wall add:", err.message);
    res.status(500).json({ error: "could not save wall" });
  }
});

/* Delete a wall — only its author (by name), or anyone for unattributed walls. */
app.post("/api/wall/delete", async (req, res) => {
  const id = String(req.body && req.body.id || "").slice(0, 64);
  const nm = normName(req.body && req.body.name);
  if (!id) return res.status(400).json({ error: "bad id" });
  try {
    const r = await pool.query(
      "DELETE FROM walls WHERE id = $1 AND (author IS NULL OR LOWER(author) = $2)",
      [id, nm ? nm.key : ""]
    );
    if (r.rowCount === 0) return res.status(403).json({ error: "not yours to delete" });
    res.json({ ok: true });
  } catch (err) {
    console.error("wall delete:", err.message);
    res.status(500).json({ error: "could not delete wall" });
  }
});

/* A community wall was played — count it, and whether it was solved. */
app.post("/api/wall/played", async (req, res) => {
  const id = String(req.body && req.body.id || "").slice(0, 64);
  const won = !!(req.body && req.body.won);
  if (!id) return res.status(400).json({ error: "bad id" });
  try {
    await pool.query(
      "UPDATE walls SET plays = plays + 1, solves = solves + $2 WHERE id = $1",
      [id, won ? 1 : 0]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("wall played:", err.message);
    res.status(500).json({ error: "could not record play" });
  }
});

/* ---------- players, results, leaderboard ---------- */

app.post("/api/player", async (req, res) => {
  const nm = normName(req.body && req.body.name);
  if (!nm) return res.status(400).json({ error: "bad name" });
  try {
    const r = await pool.query(
      `INSERT INTO players (name, display_name, created) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING *`,
      [nm.key, nm.display, Date.now()]
    );
    res.json({ player: profileRow(r.rows[0]) });
  } catch (err) {
    console.error("player:", err.message);
    res.status(500).json({ error: "could not save player" });
  }
});

app.post("/api/result", async (req, res) => {
  const b = req.body || {};
  const nm = normName(b.name);
  if (!nm) return res.status(400).json({ error: "bad name" });
  const won = !!b.won;
  const mistakes = clampInt(b.mistakes, 10);
  const timeS = clampInt(b.timeS, MAX_TIME_S);
  let score = won ? clampInt(b.score, MAX_SCORE) : 0;  // no points for a lost wall
  const today = ukToday();
  // only today's daily counts as a daily — a stale client can't rewrite history
  const daily = (typeof b.daily === "string" && DAY_RE.test(b.daily) && b.daily === today) ? b.daily : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // ensure the player exists, and lock their row for the streak update
    await client.query(
      `INSERT INTO players (name, display_name, created) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [nm.key, nm.display, Date.now()]
    );
    const cur = (await client.query("SELECT * FROM players WHERE name = $1 FOR UPDATE", [nm.key])).rows[0];

    let counts = true;
    if (daily) {
      const ins = await client.query(
        `INSERT INTO daily_results (day, name, won, mistakes, time_s, score)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (day, name) DO NOTHING`,
        [daily, nm.key, won, mistakes, timeS, score]
      );
      counts = ins.rowCount === 1;  // replays of today's daily never re-score
    }

    if (counts) {
      let streak = Number(cur.streak);
      let lastDaily = cur.last_daily;
      if (daily) {
        if (won) {
          streak = (lastDaily === prevDay(daily)) ? streak + 1 : 1;
          lastDaily = daily;
        } else {
          streak = 0;
        }
      }
      const bestStreak = Math.max(Number(cur.best_streak), streak);
      await client.query(
        `UPDATE players SET
           points = points + $2, played = played + 1, won = won + $3,
           streak = $4, best_streak = $5, last_daily = $6
         WHERE name = $1`,
        [nm.key, score, won ? 1 : 0, streak, bestStreak, lastDaily]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("result:", err.message);
    client.release();
    return res.status(500).json({ error: "could not save result" });
  }
  client.release();

  try {
    const r = await pool.query("SELECT * FROM players WHERE name = $1", [nm.key]);
    res.json({ ok: true, player: r.rows[0] ? profileRow(r.rows[0]) : null });
  } catch {
    res.json({ ok: true });
  }
});

app.get("/api/leaderboard", async (_req, res) => {
  try {
    const today = ukToday();
    const [top, daily] = await Promise.all([
      pool.query("SELECT * FROM players ORDER BY points DESC, best_streak DESC LIMIT 10"),
      pool.query("SELECT COUNT(*) FILTER (WHERE won) AS solvers, COUNT(*) AS played FROM daily_results WHERE day = $1", [today]),
    ]);
    res.json({
      players: top.rows.map(profileRow),
      daily: { day: today, solvers: Number(daily.rows[0].solvers), played: Number(daily.rows[0].played) },
    });
  } catch (err) {
    console.error("leaderboard:", err.message);
    res.status(500).json({ error: "could not read leaderboard" });
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
