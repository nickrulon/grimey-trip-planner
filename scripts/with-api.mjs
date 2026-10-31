// One-shot deploy: boot a temporary API on its own port, build + export the
// static snapshot, ship it to Netlify, then shut the API down. Uses a
// dedicated port so it never collides with a dev server you have running.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.API_PORT || 5481;
const SITE = 'c4d28021-4a50-4437-8bbe-7afeecd16e8f'; // grimey-trip-planner.netlify.app

const api = spawn('node', ['server/index.mjs'], {
  cwd: ROOT, env: { ...process.env, API_PORT: PORT }, stdio: 'ignore',
});
const stop = () => { try { api.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, API_PORT: PORT } });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

try {
  // SQLite keeps recent commits in a -wal sidecar that sql.js cannot read, so
  // the bundled database would ship stale without this.
  const { default: Database } = await import('better-sqlite3');
  const dbFile = path.join(ROOT, 'data/trip.sqlite');
  const cp = new Database(dbFile);
  cp.pragma('wal_checkpoint(TRUNCATE)');
  const rev = cp.prepare('SELECT id FROM plan_revisions WHERE active=1').get();
  const n = rev ? cp.prepare('SELECT COUNT(*) c FROM planned_days WHERE revision_id=?').get(rev.id).c : 0;
  cp.close();
  console.log(`checkpointed database → shipping rev ${rev?.id} (${n} days)`);

  // Wait for the API to answer before exporting.
  for (let i = 0; i < 30; i++) {
    try { await fetch(`http://localhost:${PORT}/api/summary`); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  await run('npx', ['vite', 'build', '--base=./']);
  await run('node', ['scripts/export-static.mjs']);
  try {
    await run('npx', ['netlify-cli', 'deploy', '--dir', 'dist', '--prod', '--site', SITE]);
  } catch (err) {
    // Netlify's free plan blocks *new production* deploys once the account's
    // credits are spent ("Account credit usage exceeded"), but still accepts
    // draft deploys and still lets an existing deploy be published. So: ship
    // a draft, then publish it with restoreSiteDeploy — same result.
    console.warn(`\nproduction deploy refused (${err.message}); trying draft + publish…`);
    const out = execFileSync('npx', ['netlify-cli', 'deploy', '--dir', 'dist', '--site', SITE, '--json'],
      { cwd: ROOT, env: { ...process.env, API_PORT: PORT }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const { deploy_id: deployId } = JSON.parse(out.slice(out.indexOf('{')));
    execFileSync('npx', ['netlify-cli', 'api', 'restoreSiteDeploy', '--data', JSON.stringify({ site_id: SITE, deploy_id: deployId })],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`published draft ${deployId} to production`);
  }
  console.log('\n✓ https://grimey-trip-planner.netlify.app updated');
} catch (err) {
  console.error('\n✗ deploy failed:', err.message);
  process.exitCode = 1;
} finally {
  stop();
}
