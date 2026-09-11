// Local dev server: the full engine against the on-disk SQLite file.
// The deployed copy uses the same app via netlify/functions/api.js.
import { openDb } from './db.mjs';
import { createApp } from './app.mjs';

// API_PORT, not PORT — dev harnesses inject PORT for the web server.
const PORT = process.env.API_PORT || 5181;
createApp(openDb()).listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
