// A better-sqlite3-shaped facade over sql.js (SQLite compiled to WASM).
//
// The planning engine is written against better-sqlite3's synchronous API and
// runs on a serverless platform where a native module for the host's
// architecture can't be relied on. sql.js is pure WASM, so the SAME engine
// code runs unchanged in the cloud. Only the surface the engine actually uses
// is implemented: prepare().get/.all/.run, exec, transaction, pragma, close.
import initSqlJs from 'sql.js';

// undefined is not bindable; better-sqlite3 rejects it too, so normalise to
// NULL rather than throwing deep inside a query.
const clean = (params) => params.map((p) => (p === undefined ? null : p));

export async function openWasmDb(buffer, { wasmPath } = {}) {
  const SQL = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : {});
  const raw = new SQL.Database(new Uint8Array(buffer));

  const lastRowId = () => {
    const r = raw.exec('SELECT last_insert_rowid()');
    return r.length ? r[0].values[0][0] : 0;
  };

  function prepare(sql) {
    // Compile once, then reset+bind per call — recompiling on every query
    // makes auto-planning (thousands of queries) crawl.
    let stmt = null;
    const compiled = () => (stmt ??= raw.prepare(sql));
    return {
      get(...params) {
        const s = compiled();
        s.reset();
        s.bind(clean(params));
        const row = s.step() ? s.getAsObject() : undefined;
        s.reset();
        return row;
      },
      all(...params) {
        const s = compiled();
        s.reset();
        s.bind(clean(params));
        const rows = [];
        while (s.step()) rows.push(s.getAsObject());
        s.reset();
        return rows;
      },
      run(...params) {
        const s = compiled();
        s.reset();
        s.bind(clean(params));
        s.step();
        s.reset();
        return { changes: raw.getRowsModified(), lastInsertRowid: lastRowId() };
      },
    };
  }

  const db = {
    prepare,
    exec: (sql) => { raw.exec(sql); },
    // WAL/busy_timeout are meaningless for an in-memory WASM database.
    pragma: () => undefined,
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const out = fn(...args);
          raw.exec('COMMIT');
          return out;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* already unwound */ }
          throw err;
        }
      };
    },
    close: () => raw.close(),
    /** Raw handle, for state export/import in the serverless wrapper. */
    _raw: raw,
  };
  return db;
}
