import pg from "pg";

/** PGSSL=require enables TLS (needed for Render's EXTERNAL connection string; the internal one and local Docker do not need it). */
export function createPool(url: string): pg.Pool {
  const ssl = process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString: url, max: 5, ssl });
}
