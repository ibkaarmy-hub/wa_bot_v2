import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { createPool } from "./pool.js";

const MIGRATION_LOCK_KEY = 7_260_921; // arbitrary constant; all instances use the same key

/** Safe to run from several instances at once (Render runs old+new during a deploy): a session-level
 *  advisory lock serialises runners, and the applied-set is re-read after acquiring it. */
export async function runMigrations(pool: pg.Pool, dir = "migrations"): Promise<string[]> {
  const lock = await pool.connect();
  const done: string[] = [];
  try {
    await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await lock.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await lock.query("select name from schema_migrations")).rows.map(r => r.name as string));
    const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      try {
        await lock.query("begin");
        await lock.query(sql);
        await lock.query("insert into schema_migrations(name) values ($1)", [f]);
        await lock.query("commit");
        done.push(f);
      } catch (e) { await lock.query("rollback"); throw e; }
    }
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    lock.release();
  }
  return done;
}

// CLI entrypoint: `npm run migrate` or `node dist/adapters/postgres/migrate.js`
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = createPool(url);
  runMigrations(pool)
    .then(done => { console.log(done.length ? `applied: ${done.join(", ")}` : "no new migrations"); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
