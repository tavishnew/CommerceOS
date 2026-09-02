import pg from 'pg';
const p = new pg.Pool({connectionString: 'postgres://commerce:commerce@localhost:5432/commerce0s'});
const r = await p.query("SELECT id, status, human_approved_at, workspace_id, amount, policy_decision FROM orders WHERE workspace_id LIKE 'ws_auto_%' OR workspace_id LIKE 'ws_req_%' OR id = (SELECT MAX(id) FROM orders) ORDER BY id DESC LIMIT 10");
console.log(JSON.stringify(r.rows, null, 2));
await p.end();
