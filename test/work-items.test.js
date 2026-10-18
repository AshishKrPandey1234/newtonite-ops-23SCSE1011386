import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { createAppServer } from '../server/index.js';
import { hashPassword } from '../server/security.js';

const db = openDatabase(':memory:');
const userId = randomUUID();
const credentials = { email: 'operator@example.test', password: 'test-password-1234' };
const { salt, hash } = hashPassword(credentials.password);
db.prepare(`INSERT INTO users (id, email, display_name, role, password_salt, password_hash, created_at)
  VALUES (?, ?, ?, 'admin', ?, ?, ?)`)
  .run(userId, credentials.email, 'Test Operator', salt, hash, new Date().toISOString());
const memberId = randomUUID();
const memberCredentials = { email: 'member@example.test', password: 'member-password-1234' };
const memberPassword = hashPassword(memberCredentials.password);
db.prepare(`INSERT INTO users (id, email, display_name, role, password_salt, password_hash, created_at)
  VALUES (?, ?, ?, 'member', ?, ?, ?)`)
  .run(memberId, memberCredentials.email, 'Test Member', memberPassword.salt, memberPassword.hash, new Date().toISOString());
const server = createAppServer({ db, secureCookies: false });
let baseUrl;
let cookie;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health, authentication, work item lifecycle, optimistic concurrency, and logout', async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'newtonite-ops' });

  const unauthorized = await fetch(`${baseUrl}/api/work-items`);
  assert.equal(unauthorized.status, 401);

  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: 'incorrect-password' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await login.json()).user.role, 'admin');

  const created = await fetch(`${baseUrl}/api/work-items`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Review nightly job', description: 'Confirm the scheduled import completed.', priority: 'high' }),
  });
  assert.equal(created.status, 201);
  const item = (await created.json()).item;
  assert.equal(item.status, 'open');
  assert.equal(item.version, 1);

  const memberLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(memberCredentials),
  });
  const memberCookie = memberLogin.headers.getSetCookie()[0].split(';')[0];
  const forbiddenUpdate = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: memberCookie },
    body: JSON.stringify({ title: 'Unauthorized edit', version: 1 }),
  });
  assert.equal(forbiddenUpdate.status, 403);

  const transitioned = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ status: 'in_progress', version: 1 }),
  });
  assert.equal(transitioned.status, 200);
  assert.equal((await transitioned.json()).item.version, 2);

  const stale = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Overwrite stale data', version: 1 }),
  });
  assert.equal(stale.status, 409);

  const completed = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ status: 'done', version: 2 }),
  });
  assert.equal(completed.status, 200);

  const invalidTransition = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ status: 'in_progress', version: 3 }),
  });
  assert.equal(invalidTransition.status, 409);

  const filtered = await fetch(`${baseUrl}/api/work-items?status=done&search=nightly`, { headers: { cookie } });
  assert.equal((await filtered.json()).items.length, 1);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
});
