import pg from 'pg';

const { Pool } = pg;
let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export async function initDb(): Promise<void> {
  const db = getPool();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS skeleton_hunt_log (
      id     SERIAL PRIMARY KEY,
      ts     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event  TEXT NOT NULL,
      target TEXT,
      pints  INT,
      pos_x  INT,
      pos_y  INT,
      ap     INT
    )
  `);
  console.log('[db] skeleton_hunt_log ready');
}

export async function logEvent(
  event: string,
  data: { target?: string; pints?: number; pos?: { x: number; y: number }; ap?: number } = {},
): Promise<void> {
  const db = getPool();
  if (!db) return;
  try {
    await db.query(
      'INSERT INTO skeleton_hunt_log (event, target, pints, pos_x, pos_y, ap) VALUES ($1,$2,$3,$4,$5,$6)',
      [event, data.target ?? null, data.pints ?? null, data.pos?.x ?? null, data.pos?.y ?? null, data.ap ?? null],
    );
  } catch { /* best-effort */ }
}
