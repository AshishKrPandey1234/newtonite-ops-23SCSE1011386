import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'ok', service: 'newtonite-ops' }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, () => {
  console.log(`Newtonite Ops API listening on http://localhost:${port}`);
});
