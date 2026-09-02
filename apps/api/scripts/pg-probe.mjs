import pg from 'pg';
const cfg = {
  host: 'localhost',
  port: 5432,
  user: 'commerce',
  password: 'commerce',
  database: 'commerce0s',
  connectionTimeoutMillis: 3000,
};
try {
  const c = new pg.Client(cfg);
  await c.connect();
  const r = await c.query('SELECT current_user, current_database()');
  console.log('CONNECTED:', JSON.stringify(r.rows[0]));
  await c.end();
} catch (e) {
  console.log('FAIL:', e.message);
  // Try alternate users
  for (const u of ['postgres', 'admin']) {
    try {
      const c2 = new pg.Client({ ...cfg, user: u, password: u });
      await c2.connect();
      const r = await c2.query('SELECT current_user, current_database()');
      console.log(`CONNECTED as ${u}:`, JSON.stringify(r.rows[0]));
      await c2.end();
      break;
    } catch (e2) {
      console.log(`FAIL as ${u}:`, e2.message);
    }
  }
}