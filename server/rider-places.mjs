// Rider-added places (state) mirrored into resources (reference), so every
// join sees them. Deliberately dependency-free: this runs inside the
// serverless WASM function, which must never import db.mjs (native
// better-sqlite3 + a data-directory mkdir at import time — read-only there).
/** Mirror rider-added places into resources so every join (beds, stops, map)
 *  sees them. Idempotent; call after any load of shared state. */
export function syncRiderPlaces(db) {
  const rows = db.prepare(`SELECT * FROM rider_places`).all();
  const up = db.prepare(`INSERT INTO resources
      (id, category_id, name, brand, lat, lng, address, phone, website, hours,
       route_mile, off_route_mi, wifi_status, attributes_json, status, first_seen, last_verified, user_notes)
     VALUES (?,?,?,NULL,?,?,?,NULL,NULL,NULL,?,?,NULL,'{}','active',?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, category_id=excluded.category_id,
       lat=excluded.lat, lng=excluded.lng, address=excluded.address,
       route_mile=excluded.route_mile, off_route_mi=excluded.off_route_mi, user_notes=excluded.user_notes`);
  const tx = db.transaction(() => {
    for (const r of rows) up.run(r.id, r.category, r.name, r.lat, r.lng, r.address, r.route_mile, r.off_route_mi, r.created_at.slice(0, 10), r.created_at.slice(0, 10), r.notes);
  });
  tx();
  return rows.length;
}
