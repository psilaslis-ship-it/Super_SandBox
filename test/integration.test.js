import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function zip(entries) {
  const file = new yazl.ZipFile();
  for (const [name, body] of Object.entries(entries)) file.addBuffer(Buffer.from(body), name);
  file.end();
  const chunks = [];
  for await (const chunk of file.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function http(port, host, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { Host: `${host}:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function upload(port, endpoint, filename, bytes, cookie) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST', body: form, headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: response.status, body: await response.json() };
}

test('banco separado exige chave e site ZIP não expõe o JSON', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'super-sandbox-'));
  const port = await freePort();
  let child;
  async function start() {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: project, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PUBLIC_PORT: String(port) }, stdio: 'pipe',
    });
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error('Servidor encerrou antes de iniciar.');
      try { if ((await http(port, 'localhost', 'GET', '/health')).status === 200) return; }
      catch { /* aguardando */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Servidor não iniciou.');
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
  const portalOrigin = `http://localhost:${port}`;
  try {
    await start();
    assert.equal(JSON.parse((await http(port, 'localhost', 'GET', '/api/session')).body).setupRequired, true);
    assert.equal((await http(port, 'localhost', 'GET', '/api/databases')).status, 401);
    const setup = await http(port, 'localhost', 'POST', '/api/setup', JSON.stringify({ password: 'senha-muito-longa-123' }), {
      Origin: portalOrigin, 'Content-Type': 'application/json',
    });
    assert.equal(setup.status, 201, setup.body);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    assert.equal((await http(port, 'localhost', 'POST', '/api/setup', '{}', { Cookie: cookie, Origin: portalOrigin })).status, 409);
    assert.equal((await http(port, 'localhost', 'POST', '/api/logout', '', { Cookie: cookie, Origin: portalOrigin })).status, 200);
    assert.equal((await http(port, 'localhost', 'GET', '/api/databases', null, { Cookie: cookie })).status, 401);
    const login = await http(port, 'localhost', 'POST', '/api/login', JSON.stringify({ password: 'senha-muito-longa-123' }), {
      Origin: portalOrigin, 'Content-Type': 'application/json',
    });
    assert.equal(login.status, 200);
    const ownerCookie = login.headers['set-cookie'][0].split(';')[0];
    const forbiddenOrigin = await http(port, 'localhost', 'POST', '/api/databases', '', {
      Cookie: ownerCookie, Origin: `http://evil.localhost:${port}`,
    });
    assert.equal(forbiddenOrigin.status, 403);

    const badJson = await upload(port, '/api/databases', 'ruim.json', Buffer.from('{'), ownerCookie);
    assert.equal(badJson.status, 400);
    const created = await upload(port, '/api/databases', 'dados.json', Buffer.from('{"valor":1}'), ownerCookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { database, token } = created.body;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(database.url, `${portalOrigin}/api/db-access/${database.id}`);
    const dbPath = `/api/db-access/${database.id}`;
    assert.equal((await http(port, 'localhost', 'GET', dbPath)).status, 401);
    const preflight = await http(port, 'localhost', 'OPTIONS', dbPath, null, {
      Origin: 'null', 'Access-Control-Request-Method': 'PUT',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    const auth = { Authorization: `Bearer ${token}`, Origin: 'null' };
    const read = await http(port, 'localhost', 'GET', dbPath, null, auth);
    assert.equal(read.status, 200);
    assert.equal(read.body, '{"valor":1}');
    assert.ok(read.headers.etag);
    const missingVersion = await http(port, 'localhost', 'PUT', dbPath, '{"valor":2}', auth);
    assert.equal(missingVersion.status, 428);
    const saved = await http(port, 'localhost', 'PUT', dbPath, '{"valor":2}', { ...auth, 'If-Match': read.headers.etag, 'Content-Type': 'application/json' });
    assert.equal(saved.status, 200);
    assert.equal((await http(port, 'localhost', 'GET', dbPath, null, auth)).body, '{"valor":2}');
    assert.equal((await http(port, 'localhost', 'PUT', dbPath, '{"valor":3}', { ...auth, 'If-Match': read.headers.etag })).status, 409);
    const keyResponse = await http(port, 'localhost', 'POST', `/api/databases/${database.id}/keys`,
      JSON.stringify({ label: 'Leitor', permission: 'read' }), { Cookie: ownerCookie, Origin: portalOrigin, 'Content-Type': 'application/json' });
    assert.equal(keyResponse.status, 201);
    const reader = JSON.parse(keyResponse.body);
    assert.equal((await http(port, 'localhost', 'GET', dbPath, null, { Authorization: `Bearer ${reader.token}` })).status, 200);
    assert.equal((await http(port, 'localhost', 'PUT', dbPath, '{"valor":4}', {
      Authorization: `Bearer ${reader.token}`, 'If-Match': saved.headers.etag,
    })).status, 403);
    const revoked = await http(port, 'localhost', 'DELETE', `/api/databases/${database.id}/keys/${reader.key.id}`, null,
      { Cookie: ownerCookie, Origin: portalOrigin });
    assert.equal(revoked.status, 200);
    assert.equal((await http(port, 'localhost', 'GET', dbPath, null, { Authorization: `Bearer ${reader.token}` })).status, 401);

    const legacy = await upload(port, '/api/apps', 'legado.zip', await zip({
      'index.html': '<h1>Legado</h1>', 'db_global/dados.json': '{"valor":1}',
    }), ownerCookie);
    assert.equal(legacy.status, 400);
    const app = await upload(port, '/api/apps', 'site.zip', await zip({
      'site/index.html': '<h1>Site original</h1><script src="app.js"></script>',
      'site/app.js': `const banco = '${database.url}';`,
    }), ownerCookie);
    assert.equal(app.status, 201, JSON.stringify(app.body));
    const appHost = `${app.body.id}.localhost`;
    assert.equal((await http(port, appHost, 'GET', '/')).headers.location, '/index.html');
    assert.equal((await http(port, appHost, 'GET', '/index.html')).body, '<h1>Site original</h1><script src="app.js"></script>');
    assert.equal((await http(port, appHost, 'GET', '/db_global/dados.json')).status, 403);
    assert.equal((await http(port, appHost, 'PUT', '/db_global/dados.json', '{}')).status, 405);
    await stop();
    await start();
    assert.equal((await http(port, 'localhost', 'GET', dbPath, null, auth)).body, '{"valor":2}');
    assert.equal((await readFile(path.join(dataDir, 'databases', database.id, 'data.json'), 'utf8')), '{"valor":2}');
    assert.equal((await http(port, 'localhost', 'GET', '/api/databases', null, { Cookie: ownerCookie })).status, 401);
  } finally { await stop(); await rm(dataDir, { recursive: true, force: true }); }
});
