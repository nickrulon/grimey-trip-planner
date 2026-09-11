// Guarded schema migrations, applied on every boot in BOTH database paths:
// the local better-sqlite3 file and the serverless WASM copy (whose bundled
// .sqlite may predate a deploy). Each migration is additive — the redesign
// extends the engine plan into the single canonical plan (costs, rest days,
// a first-class work stop) without touching history tables.

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

export function applyMigrations(db) {
  const add = (table, col, ddl) => {
    if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };

  // Costs + rest days live on the plan itself now (the old day-plan document
  // is retired). lodging_cost is the night's bed, misc_cost is everything else.
  add('planned_days', 'rest', 'INTEGER NOT NULL DEFAULT 0');
  add('planned_days', 'lodging_cost', 'REAL');
  add('planned_days', 'misc_cost', 'REAL');
  // A curated camping-guide spot chosen as the overnight (they are not rows in
  // `resources`, so they get their own reference).
  add('planned_days', 'overnight_camp_id', 'TEXT');

  // Stops: 'work' marks the day's work anchor; cost is the loiter spend.
  add('planned_stops', 'kind', 'TEXT');
  add('planned_stops', 'cost', 'REAL');

  // Per-day time overrides. The rider — not the solar table — decides when the
  // day starts and how late they are willing to ride: `ride_until` past dusk is
  // a legitimate choice (lights), it just has to be stated, never assumed.
  // NULL means "use the default" (civil dawn / the ET work window / civil dusk).
  add('day_plans', 'work_start', 'TEXT');   // local HH:MM the work block begins
  add('day_plans', 'ride_until', 'TEXT');   // latest local HH:MM willing to ride

  // Stretches of route covered WITHOUT pedalling — ferries, shuttles, a lift
  // around a closed bridge. Mile-anchored like every other durable fact, so
  // the Mobile Bay Ferry stays at mile 86.5 no matter how the days renumber.
  // The miles still count toward the route; the TIME is the operator's, not
  // the rider's legs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_transits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_mile REAL NOT NULL,
      end_mile REAL NOT NULL,
      name TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ferry',
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_route_transits_mile
      ON route_transits(start_mile, end_mile);
  `);

  // Rider-drawn marks on the Day Canvas. These are the OPPOSITE of a break:
  // a break is mile-anchored and time-derived ("45 minutes in" slides when you
  // roll out later), while a mark is TIME-anchored and mile-indifferent — the
  // 3:30 boat leaves at 3:30 whether or not you are on it. That is why they
  // cannot live in planned_stops: the whole point of drawing one on the bar is
  // that it is the fixed thing the ride has to meet.
  //
  // scope says what the time is pinned to. 'day' is the literal ask ("day one
  // in particular") and the UI default. 'mile' exists because day numbers
  // renumber on every replan: a ferry schedule really belongs to mile 86.5, and
  // a day-anchored mark is silently on the wrong day once the plan shifts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_marks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope       TEXT    NOT NULL,                  -- 'day' | 'mile'
      day_number  INTEGER,                           -- set when scope='day'
      route_mile  REAL,                              -- set when scope='mile'
      label       TEXT    NOT NULL,
      shape       TEXT    NOT NULL DEFAULT 'block',  -- 'block' | 'line'
      color       TEXT    NOT NULL DEFAULT 'slate',  -- token name, NOT raw hex
      start_min   INTEGER NOT NULL,                  -- minutes after local midnight
      end_min     INTEGER,                           -- NULL when shape='line'
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_marks_day  ON canvas_marks(day_number);
    CREATE INDEX IF NOT EXISTS idx_canvas_marks_mile ON canvas_marks(route_mile);
  `);

  // Data fix: stops scheduled by the work-aware auto-itinerary before 'kind'
  // existed are unmistakably work anchors — a 2h+ wi-fi sit is a work block.
  db.exec(`
    UPDATE planned_stops SET kind='work'
    WHERE kind IS NULL
      AND (notes = 'work stop (auto)' OR (category = 'wifi_work' AND dwell_min >= 120))
  `);
}
