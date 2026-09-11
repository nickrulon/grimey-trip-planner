import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { applyMigrations } from './migrate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// TRIP_DB points a second instance at a throwaway copy — the way the UI is
// exercised without touching the rider's real plan.
export const DB_PATH = process.env.TRIP_DB || path.join(dataDir, 'trip.sqlite');

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // ingest scripts and the API share this file
  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,              -- canonical | personal | actual
      name TEXT NOT NULL,
      total_miles REAL,
      provenance TEXT NOT NULL,        -- official-public | osm-proposed | reconstructed | user-drawn
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS route_segments (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES routes(id),
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_mile REAL NOT NULL,
      end_mile REAL NOT NULL,
      provenance TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT,
      retrieved_at TEXT NOT NULL,
      confidence TEXT NOT NULL,        -- high | medium | low
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS route_points (
      segment_id TEXT NOT NULL REFERENCES route_segments(id),
      seq INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      mile REAL NOT NULL,
      elevation_m REAL,
      PRIMARY KEY (segment_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_route_points_mile ON route_points(mile);

    CREATE TABLE IF NOT EXISTS resource_categories (
      id TEXT PRIMARY KEY,             -- wifi_work | campground | hotel | ...
      label TEXT NOT NULL,
      corridor_width_mi REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES resource_categories(id),
      name TEXT NOT NULL,
      brand TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      hours TEXT,
      route_mile REAL NOT NULL,
      off_route_mi REAL NOT NULL,
      wifi_status TEXT,                -- confirmed | likely | unknown | none
      attributes_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      first_seen TEXT NOT NULL,
      last_verified TEXT,
      user_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_resources_mile ON resources(route_mile);
    CREATE INDEX IF NOT EXISTS idx_resources_cat ON resources(category_id);
    -- Anchor scoring asks "how much wi-fi is near mile X" thousands of times per
    -- auto-plan; category alone made SQLite scan every wi-fi row each call.
    CREATE INDEX IF NOT EXISTS idx_resources_cat_mile ON resources(category_id, route_mile);

    -- Mile-anchored rider notes (ferries, detours, hard roads, no-service gaps).
    -- Anchored to route miles, NOT day numbers: days shift when the plan is
    -- revised, and notes must follow the road, not the schedule.
    CREATE TABLE IF NOT EXISTS route_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,              -- ferry|detour|highway|no_services|climb|bridge|traffic|trail|caution
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      start_mile REAL NOT NULL,
      end_mile REAL NOT NULL,
      source TEXT,
      confidence TEXT NOT NULL DEFAULT 'medium'
    );
    CREATE INDEX IF NOT EXISTS idx_route_notes_mile ON route_notes(start_mile, end_mile);

    -- Intra-day itinerary. Stops are keyed to ROUTE MILE, not day number, so
    -- they survive replans and renumbering the same way rider notes do — a
    -- Starbucks does not move when the schedule does.
    CREATE TABLE IF NOT EXISTS planned_stops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_mile REAL NOT NULL,
      resource_id TEXT REFERENCES resources(id),
      name TEXT NOT NULL,
      category TEXT,
      off_route_mi REAL,
      dwell_min INTEGER NOT NULL DEFAULT 30,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_planned_stops_mile ON planned_stops(route_mile);

    -- Per-day overrides (departure time). Keyed by day number only: if days
    -- renumber, "I leave at 6am on day 4" stays attached to day 4.
    CREATE TABLE IF NOT EXISTS day_plans (
      day_number INTEGER PRIMARY KEY,
      start_time TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Towns/cities near the route, for naming miles ("DeRidder, LA" not "Mile 456").
    CREATE TABLE IF NOT EXISTS route_places (
      id TEXT PRIMARY KEY,             -- osm node ref
      name TEXT NOT NULL,
      place_type TEXT NOT NULL,        -- city | town | village
      population INTEGER,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      route_mile REAL NOT NULL,
      off_route_mi REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_places_mile ON route_places(route_mile);

    -- Plans are append-only: every auto-build or replan writes a new revision
    -- and flips 'active'. History is never rewritten (brief §4, §14).
    CREATE TABLE IF NOT EXISTS plan_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      reason TEXT NOT NULL,            -- initial-auto | replan-after-day-N | manual
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS planned_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES plan_revisions(id),
      day_number INTEGER NOT NULL,
      start_mile REAL NOT NULL,
      end_mile REAL NOT NULL,
      start_name TEXT,
      end_name TEXT,
      overnight_resource_id TEXT REFERENCES resources(id),
      status TEXT NOT NULL DEFAULT 'planned', -- planned|completed|modified|skipped
      flags TEXT NOT NULL DEFAULT '[]',       -- JSON: no_anchor, too_long, very_short...
      notes TEXT,
      UNIQUE (revision_id, day_number)
    );
    -- What actually happened, one row per ridden day. Never overwritten by replans.
    CREATE TABLE IF NOT EXISTS actual_days (
      day_number INTEGER PRIMARY KEY,
      date TEXT,
      start_mile REAL NOT NULL,
      end_mile REAL NOT NULL,
      end_name TEXT,
      notes TEXT,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id TEXT NOT NULL REFERENCES resources(id),
      provider TEXT NOT NULL,          -- osm | overture | ridb | manual
      provider_ref TEXT NOT NULL,
      source_url TEXT,
      retrieved_at TEXT NOT NULL,
      confidence TEXT NOT NULL,
      UNIQUE (provider, provider_ref)
    );
  `);
  applyMigrations(db);
  return db;
}
