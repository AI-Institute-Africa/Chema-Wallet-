// Server-side API stand-in for e2e: the public memorial page is rendered on the
// Next server, which fetches the API from Node (not interceptable in the
// browser). Serves the fixture for GET /public/wallets/:slug; 404 otherwise.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const fixture = readFileSync(new URL('./tests/memorial-fixture.json', import.meta.url), 'utf8');
const slug = JSON.parse(fixture).slug;
const port = Number(process.env.PORT ?? 3199);

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === `/public/wallets/${slug}`) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(fixture);
  } else if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  } else {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
  }
}).listen(port, '127.0.0.1');
