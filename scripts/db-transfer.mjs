#!/usr/bin/env node
// Export a Postgres database to a JSON file, or load one back in.
//
// Written for the Neon data-transfer-quota outage: the old project's data is
// intact but unreachable until the quota resets, so this exists ready to run
// the moment it does. Also serves as a plain backup tool -- the uploaded tests
// live ONLY in the database (html_content), so losing it loses them.
//
//   node scripts/db-transfer.mjs export --url "postgres://..." --out backup.json
//   node scripts/db-transfer.mjs import --url "postgres://..." --in  backup.json
//
// import is additive and re-runnable: rows whose primary key already exists are
// skipped, never overwritten, so a half-finished run can simply be run again.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

// pg is a dependency of server/, not of the repo root where this script lives,
// so resolve it from there rather than requiring a duplicate install.
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'server', 'package.json'));
const pg = require('pg');

const { Pool } = pg;

// Order matters on import: parents before the rows that reference them.
const TABLES = [
  { name: 'users', key: 'id' },
  { name: 'tests', key: 'id' },
  { name: 'test_audio_assets', key: 'id' },
  { name: 'assignments', key: 'id' },
  { name: 'submissions', key: 'id' },
  { name: 'speaking_prompts', key: 'id' },
  { name: 'speaking_assignments', key: 'id' },
  { name: 'speaking_submissions', key: 'id' },
  { name: 'ai_settings', key: 'id' }
];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

const mode = process.argv[2];
const url = arg('--url') || process.env.DATABASE_URL;
if (!['export', 'import'].includes(mode) || !url) {
  console.error('Usage: db-transfer.mjs <export|import> --url <postgres-url> [--out file | --in file]');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB';

async function tableExists(name) {
  const r = await pool.query('SELECT to_regclass($1) AS t', [name]);
  return r.rows[0].t !== null;
}

async function doExport() {
  const outPath = arg('--out') || 'backup.json';
  const dump = { exportedAt: new Date().toISOString(), tables: {} };

  for (const { name } of TABLES) {
    if (!await tableExists(name)) {
      console.log(`  ${name}: (table absent, skipped)`);
      continue;
    }
    const { rows } = await pool.query(`SELECT * FROM ${name}`);
    dump.tables[name] = rows;
    console.log(`  ${name}: ${rows.length} rows`);
  }

  fs.writeFileSync(outPath, JSON.stringify(dump));
  console.log(`\nWrote ${outPath} (${mb(fs.statSync(outPath).size)})`);
  // Loud, because a silent empty backup is worse than no backup.
  const total = Object.values(dump.tables).reduce((a, r) => a + r.length, 0);
  if (total === 0) console.error('WARNING: exported 0 rows -- check the connection string.');
}

async function doImport() {
  const inPath = arg('--in') || 'backup.json';
  const dump = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  console.log(`Loading ${inPath} (exported ${dump.exportedAt})\n`);

  for (const { name, key } of TABLES) {
    const rows = dump.tables[name];
    if (!rows?.length) { console.log(`  ${name}: nothing to load`); continue; }
    if (!await tableExists(name)) { console.log(`  ${name}: (table absent here, skipped)`); continue; }

    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      try {
        const res = await pool.query(
          `INSERT INTO ${name} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${params})
           ON CONFLICT ("${key}") DO NOTHING`,
          cols.map(c => row[c])
        );
        if (res.rowCount > 0) inserted += 1; else skipped += 1;
      } catch (e) {
        console.error(`    ${name} ${key}=${row[key]}: ${e.message}`);
      }
    }
    console.log(`  ${name}: ${inserted} inserted, ${skipped} already present`);

    // Sequences must be advanced past the copied ids, or the next insert
    // collides with restored data.
    try {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${name}', '${key}'),
                       GREATEST((SELECT COALESCE(MAX("${key}"), 1) FROM ${name}), 1))`
      );
    } catch { /* non-serial primary key (e.g. users.id is text) -- nothing to bump */ }
  }
  console.log('\nDone.');
}

try {
  console.log(`${mode === 'export' ? 'Exporting from' : 'Importing into'} database...\n`);
  await (mode === 'export' ? doExport() : doImport());
} catch (error) {
  console.error('\nFailed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
