import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createSessionToken, digestToken, hashPassword, verifyPassword } from './security.js';

const SESSION_DAYS = 7;
const COOKIE_NAME = 'ops_session';
const statuses = new Set(['open', 'in_progress', 'blocked', 'done']);
const priorities = new Set(['low', 'medium', 'high']);
const transitions = {
  open: new Set(['in_progress', 'blocked', 'done']),
  in_progress: new Set(['open', 'blocked', 'done']),
  blocked: new Set(['open', 'in_progress']),
  done: new Set(['open']),
};

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  response.end(JSON.stringify(body));
}

function cookieValue(request) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(value.join('='));
  }
  return null;
}

function sessionCookie(token, secure) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function getUserForSession(db, request) {
  const token = cookieValue(request);
  if (!token) return null;
  return db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .get(digestToken(token), new Date().toISOString()) ?? null;
}

function listWorkItems(db, url) {
  const clauses = [];
  const values = [];
  if (url.searchParams.has('status')) {
    const status = url.searchParams.get('status');
    if (!statuses.has(status)) throw Object.assign(new Error('Invalid status filter.'), { status: 400 });
    clauses.push('status = ?');
    values.push(status);
  }
  if (url.searchParams.has('search')) {
    clauses.push('(title LIKE ? OR description LIKE ?)');
    const term = `%${url.searchParams.get('search').slice(0, 100)}%`;
    values.push(term, term);
  }
  return db.prepare(`SELECT work_items.id, work_items.title, work_items.description, work_items.status,
      work_items.priority, work_items.created_by AS createdBy, work_items.assignee_id AS assigneeId,
      assignees.display_name AS assigneeName, work_items.created_at AS createdAt,
      work_items.updated_at AS updatedAt, work_items.version
    FROM work_items LEFT JOIN users AS assignees ON assignees.id = work_items.assignee_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY work_items.updated_at DESC, work_items.id LIMIT 200`).all(...values);
}

function validateWorkItem(input, creating) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Body must be a JSON object.'), { status: 400 });
  const result = {};
  if (creating || Object.hasOwn(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 160) {
      throw Object.assign(new Error('Title must contain 1 to 160 characters.'), { status: 400 });
    }
    result.title = input.title.trim();
  }
  if (creating || Object.hasOwn(input, 'description')) {
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 5000)) {
      throw Object.assign(new Error('Description must be 5,000 characters or fewer.'), { status: 400 });
    }
    result.description = (input.description ?? '').trim();
  }
  if (creating || Object.hasOwn(input, 'priority')) {
    const priority = input.priority ?? 'medium';
    if (!priorities.has(priority)) throw Object.assign(new Error('Priority must be low, medium, or high.'), { status: 400 });
    result.priority = priority;
  }
  if (Object.hasOwn(input, 'status')) {
    if (!statuses.has(input.status)) throw Object.assign(new Error('Invalid status.'), { status: 400 });
    result.status = input.status;
  }
  if (Object.hasOwn(input, 'assigneeId')) {
    if (input.assigneeId !== null && typeof input.assigneeId !== 'string') {
      throw Object.assign(new Error('Assignee must be a user id or null.'), { status: 400 });
    }
    result.assignee_id = input.assigneeId;
  }
  return result;
}

export function createAppServer({ db = openDatabase(), secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { status: 'ok', service: 'newtonite-ops' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const input = await readJson(request);
        const user = typeof input.email === 'string' && typeof input.password === 'string'
          ? db.prepare('SELECT * FROM users WHERE email = ?').get(input.email.trim()) : null;
        if (!user || !verifyPassword(input.password, user.password_salt, user.password_hash)) {
          json(response, 401, { error: 'Email or password is incorrect.' });
          return;
        }
        const token = createSessionToken();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString();
        db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
          .run(digestToken(token), user.id, expiresAt, now.toISOString());
        json(response, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, secureCookies) });
        return;
      }

      const user = getUserForSession(db, request);
      if (request.method === 'GET' && url.pathname === '/api/auth/me') {
        if (!user) { json(response, 401, { error: 'Authentication required.' }); return; }
        json(response, 200, { user: publicUser(user) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = cookieValue(request);
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digestToken(token));
        json(response, 200, { ok: true }, { 'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}` });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!user) { json(response, 401, { error: 'Authentication required.' }); return; }
        if (url.pathname === '/api/users' && (request.method === 'GET' || request.method === 'POST')) {
          if (user.role !== 'admin') { json(response, 403, { error: 'Only admins can manage team members.' }); return; }
          if (request.method === 'GET') {
            const users = db.prepare(`SELECT id, email, display_name AS displayName, role FROM users ORDER BY display_name, email`).all();
            json(response, 200, { users });
            return;
          }
          const input = await readJson(request);
          const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
          const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { json(response, 400, { error: 'Enter a valid email address.' }); return; }
          if (!displayName || displayName.length > 80) { json(response, 400, { error: 'Name must contain 1 to 80 characters.' }); return; }
          if (typeof input.password !== 'string' || input.password.length < 12) { json(response, 400, { error: 'Password must be at least 12 characters.' }); return; }
          if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) { json(response, 409, { error: 'A user with that email already exists.' }); return; }
          const { salt, hash } = hashPassword(input.password);
          const createdAt = new Date().toISOString();
          const member = { id: randomUUID(), email, display_name: displayName, role: 'member' };
          db.prepare(`INSERT INTO users (id, email, display_name, role, password_salt, password_hash, created_at)
            VALUES (?, ?, ?, 'member', ?, ?, ?)`)
            .run(member.id, member.email, member.display_name, salt, hash, createdAt);
          json(response, 201, { user: publicUser(member) });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/work-items') {
          json(response, 200, { items: listWorkItems(db, url) });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/work-items') {
          const item = validateWorkItem(await readJson(request), true);
          if (item.assignee_id && user.role !== 'admin') {
            json(response, 403, { error: 'Only admins can assign a work item.' });
            return;
          }
          const idempotencyKey = request.headers['idempotency-key'];
          if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) {
            json(response, 400, { error: 'Provide an Idempotency-Key header between 8 and 128 safe characters.' });
            return;
          }
          const keyHash = hashText(idempotencyKey);
          const requestHash = hashText(JSON.stringify(item));
          db.exec('BEGIN IMMEDIATE');
          try {
            const expiry = new Date(Date.now() - 30 * 86400_000).toISOString();
            const previous = db.prepare(`SELECT request_hash AS requestHash, response_status AS responseStatus,
              response_json AS responseJson, created_at AS createdAt FROM idempotency_keys WHERE user_id = ? AND key_hash = ?`)
              .get(user.id, keyHash);
            if (previous && previous.createdAt >= expiry) {
              db.exec('COMMIT');
              if (previous.requestHash !== requestHash) {
                json(response, 409, { error: 'This Idempotency-Key was already used with a different request.' });
                return;
              }
              json(response, previous.responseStatus, JSON.parse(previous.responseJson), { 'idempotency-replayed': 'true' });
              return;
            }
            if (previous) db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND key_hash = ?').run(user.id, keyHash);
            if (item.assignee_id && !db.prepare('SELECT id FROM users WHERE id = ?').get(item.assignee_id)) {
              db.exec('ROLLBACK');
              json(response, 400, { error: 'Assignee does not exist.' });
              return;
            }
            const now = new Date().toISOString();
            const id = randomUUID();
            db.prepare(`INSERT INTO work_items (id, title, description, priority, created_by, assignee_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(id, item.title, item.description, item.priority, user.id, item.assignee_id ?? null, now, now);
            const body = { item: db.prepare(`SELECT work_items.id, work_items.title, work_items.description,
              work_items.status, work_items.priority, work_items.created_by AS createdBy,
              work_items.assignee_id AS assigneeId, assignees.display_name AS assigneeName,
              work_items.created_at AS createdAt, work_items.updated_at AS updatedAt, work_items.version FROM work_items
              LEFT JOIN users AS assignees ON assignees.id = work_items.assignee_id WHERE work_items.id = ?`).get(id) };
            db.prepare(`INSERT INTO idempotency_keys (user_id, key_hash, request_hash, response_status, response_json, created_at)
              VALUES (?, ?, ?, 201, ?, ?)`)
              .run(user.id, keyHash, requestHash, JSON.stringify(body), now);
            db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(expiry);
            db.exec('COMMIT');
            json(response, 201, body);
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return;
        }
        const match = url.pathname.match(/^\/api\/work-items\/([0-9a-f-]+)$/i);
        if (request.method === 'PATCH' && match) {
          const current = db.prepare('SELECT * FROM work_items WHERE id = ?').get(match[1]);
          if (!current) { json(response, 404, { error: 'Work item not found.' }); return; }
          if (user.role !== 'admin' && current.created_by !== user.id && current.assignee_id !== user.id) {
            json(response, 403, { error: 'You may update only work items you created or are assigned to.' });
            return;
          }
          const input = await readJson(request);
          if (!Number.isInteger(input.version) || input.version !== current.version) {
            json(response, 409, { error: 'This work item changed. Reload it and try again.', currentVersion: current.version });
            return;
          }
          const update = validateWorkItem(input, false);
          if (!Object.keys(update).length) { json(response, 400, { error: 'Provide at least one field to update.' }); return; }
          if (Object.hasOwn(update, 'assignee_id') && user.role !== 'admin') {
            json(response, 403, { error: 'Only admins can change work item assignees.' });
            return;
          }
          if (update.assignee_id && !db.prepare('SELECT id FROM users WHERE id = ?').get(update.assignee_id)) {
            json(response, 400, { error: 'Assignee does not exist.' });
            return;
          }
          if (update.status && update.status !== current.status && !transitions[current.status].has(update.status)) {
            json(response, 409, { error: `Cannot move a work item from ${current.status} to ${update.status}.` });
            return;
          }
          const now = new Date().toISOString();
          const columns = Object.keys(update);
          const values = columns.map((key) => update[key]);
          const assignments = columns.map((key) => `${key} = ?`).join(', ');
          const result = db.prepare(`UPDATE work_items SET ${assignments}, updated_at = ?, version = version + 1
            WHERE id = ? AND version = ?`).run(...values, now, current.id, current.version);
          if (!result.changes) { json(response, 409, { error: 'This work item changed. Reload it and try again.' }); return; }
          const updated = db.prepare(`SELECT work_items.id, work_items.title, work_items.description,
            work_items.status, work_items.priority, work_items.created_by AS createdBy,
            work_items.assignee_id AS assigneeId, assignees.display_name AS assigneeName,
            work_items.created_at AS createdAt, work_items.updated_at AS updatedAt, work_items.version FROM work_items
            LEFT JOIN users AS assignees ON assignees.id = work_items.assignee_id WHERE work_items.id = ?`).get(current.id);
          json(response, 200, { item: updated });
          return;
        }
      }
      json(response, 404, { error: 'Not found.' });
    } catch (error) {
      json(response, error.status ?? 500, { error: error.status ? error.message : 'Internal server error.' });
      if (!error.status) console.error(error);
    }
  });
  server.on('close', () => { if (db.isOpen) db.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createAppServer();
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Newtonite Ops API listening on http://localhost:${port}`));
}
