import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

async function upload(port, endpoint, filename, bytes, cookie, method = 'POST') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method, body: form, headers: cookie ? { Cookie: cookie } : {},
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
    assert.equal(database.keys[0].canReveal, true);
    assert.equal(JSON.stringify(database).includes('sealedToken'), false);
    const revealInitialPath = `/api/databases/${database.id}/keys/${database.keys[0].id}/reveal`;
    assert.equal((await http(port, 'localhost', 'POST', revealInitialPath)).status, 401);
    assert.equal((await http(port, 'localhost', 'POST', revealInitialPath, null,
      { Cookie: ownerCookie, Origin: `http://evil.localhost:${port}` })).status, 403);
    const revealInitial = await http(port, 'localhost', 'POST', revealInitialPath, null,
      { Cookie: ownerCookie, Origin: portalOrigin });
    assert.equal(revealInitial.status, 200, revealInitial.body);
    assert.equal(JSON.parse(revealInitial.body).token, token);
    const encryptedMeta = await readFile(path.join(dataDir, 'databases', database.id, 'meta.json'), 'utf8');
    assert.ok(encryptedMeta.includes('sealedToken'));
    assert.equal(encryptedMeta.includes(token), false);
    const disposable = await upload(port, '/api/databases', 'temporario.json', Buffer.from('{"temporario":true}'), ownerCookie);
    assert.equal(disposable.status, 201);
    const disposableId = disposable.body.database.id;
    const legacyMetaPath = path.join(dataDir, 'databases', disposableId, 'meta.json');
    const legacyMeta = JSON.parse(await readFile(legacyMetaPath, 'utf8'));
    delete legacyMeta.keys[0].sealedToken;
    await writeFile(legacyMetaPath, JSON.stringify(legacyMeta));
    const legacyKeyPath = `/api/databases/${disposableId}/keys/${legacyMeta.keys[0].id}`;
    const listedLegacy = JSON.parse((await http(port, 'localhost', 'GET', `/api/databases/${disposableId}`, null,
      { Cookie: ownerCookie })).body);
    assert.equal(listedLegacy.keys[0].canReveal, false);
    assert.equal((await http(port, 'localhost', 'GET', `/api/db-access/${disposableId}`, null,
      { Authorization: `Bearer ${disposable.body.token}` })).status, 200);
    assert.equal((await http(port, 'localhost', 'POST', `${legacyKeyPath}/reveal`, null,
      { Cookie: ownerCookie, Origin: portalOrigin })).status, 409);
    assert.equal((await http(port, 'localhost', 'POST', `${legacyKeyPath}/rotate`)).status, 401);
    assert.equal((await http(port, 'localhost', 'POST', `${legacyKeyPath}/rotate`, null,
      { Cookie: ownerCookie, Origin: `http://evil.localhost:${port}` })).status, 403);
    const rotated = await http(port, 'localhost', 'POST', `${legacyKeyPath}/rotate`, null,
      { Cookie: ownerCookie, Origin: portalOrigin });
    assert.equal(rotated.status, 200, rotated.body);
    assert.equal(JSON.parse(rotated.body).key.canReveal, true);
    const replacement = JSON.parse(rotated.body).token;
    assert.notEqual(replacement, disposable.body.token);
    assert.equal((await http(port, 'localhost', 'GET', `/api/db-access/${disposableId}`, null,
      { Authorization: `Bearer ${disposable.body.token}` })).status, 401);
    assert.equal((await http(port, 'localhost', 'GET', `/api/db-access/${disposableId}`, null,
      { Authorization: `Bearer ${replacement}` })).status, 200);
    assert.equal(JSON.parse((await http(port, 'localhost', 'POST', `${legacyKeyPath}/reveal`, null,
      { Cookie: ownerCookie, Origin: portalOrigin })).body).token, replacement);
    const deletePath = `/api/databases/${disposableId}`;
    assert.equal((await http(port, 'localhost', 'DELETE', deletePath)).status, 401);
    assert.equal((await http(port, 'localhost', 'DELETE', deletePath, null,
      { Cookie: ownerCookie, Origin: `http://evil.localhost:${port}` })).status, 403);
    assert.equal((await http(port, 'localhost', 'DELETE', deletePath, null,
      { Cookie: ownerCookie, Origin: portalOrigin })).status, 200);
    assert.equal((await http(port, 'localhost', 'GET', deletePath, null, { Cookie: ownerCookie })).status, 404);
    assert.equal((await http(port, 'localhost', 'GET', `/api/db-access/${disposableId}`, null,
      { Authorization: `Bearer ${disposable.body.token}` })).status, 404);
    assert.equal((await http(port, 'localhost', 'GET', `${deletePath}/download`, null,
      { Cookie: ownerCookie })).status, 404);
    assert.equal((await http(port, 'localhost', 'DELETE', deletePath, null,
      { Cookie: ownerCookie, Origin: portalOrigin })).status, 404);
    assert.equal(JSON.parse((await http(port, 'localhost', 'GET', '/api/databases', null,
      { Cookie: ownerCookie })).body).some(item => item.id === disposableId), false);
    await assert.rejects(readFile(path.join(dataDir, 'databases', disposableId, 'data.json')), { code: 'ENOENT' });
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
    assert.equal((await http(port, 'localhost', 'PUT', dbPath, '{',
      { ...auth, 'If-Match': saved.headers.etag, 'Content-Type': 'application/json' })).status, 400);
    assert.equal((await http(port, 'localhost', 'GET', dbPath, null, auth)).body, '{"valor":2}');
    assert.equal((await http(port, 'localhost', 'PUT', dbPath, '{"valor":3}', { ...auth, 'If-Match': read.headers.etag })).status, 409);
    const keyResponse = await http(port, 'localhost', 'POST', `/api/databases/${database.id}/keys`,
      JSON.stringify({ label: 'Leitor', permission: 'read' }), { Cookie: ownerCookie, Origin: portalOrigin, 'Content-Type': 'application/json' });
    assert.equal(keyResponse.status, 201);
    const reader = JSON.parse(keyResponse.body);
    assert.equal(reader.key.canReveal, true);
    assert.equal(JSON.parse((await http(port, 'localhost', 'POST',
      `/api/databases/${database.id}/keys/${reader.key.id}/reveal`, null,
      { Cookie: ownerCookie, Origin: portalOrigin })).body).token, reader.token);
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
    const oldAppMetaPath = path.join(dataDir, 'apps', app.body.id, 'meta.json');
    const oldAppMeta = JSON.parse(await readFile(oldAppMetaPath, 'utf8'));
    delete oldAppMeta.databaseIds;
    await writeFile(oldAppMetaPath, JSON.stringify(oldAppMeta));
    const oldAppList = JSON.parse((await http(port, 'localhost', 'GET', '/api/apps', null,
      { Cookie: ownerCookie })).body);
    assert.deepEqual(oldAppList[0].databaseIds, [database.id]);
    assert.equal((await http(port, 'localhost', 'PUT', `/api/apps/${app.body.id}`)).status, 401);
    assert.equal((await http(port, 'localhost', 'PUT', `/api/apps/${app.body.id}`, null,
      { Cookie: ownerCookie, Origin: `http://evil.localhost:${port}` })).status, 403);

    const missingDatabase = `${portalOrigin}/api/db-access/ffffffffffffffff`;
    const badSite = await upload(port, '/api/apps', 'outro.zip', await zip({
      'index.html': `<script>const banco = '${missingDatabase}';</script>`,
    }), ownerCookie);
    assert.equal(badSite.status, 409, JSON.stringify(badSite.body));
    assert.match(badSite.body.error, /banco que não existe/);
    const badUpdate = await upload(port, `/api/apps/${app.body.id}`, 'site.zip', await zip({
      'index.html': `<script>const banco = '${missingDatabase}';</script>`,
    }), ownerCookie, 'PUT');
    assert.equal(badUpdate.status, 409, JSON.stringify(badUpdate.body));
    assert.equal((await http(port, appHost, 'GET', '/index.html')).body,
      '<h1>Site original</h1><script src="app.js"></script>');
    const updated = await upload(port, `/api/apps/${app.body.id}`, 'site.zip', await zip({
      'index.html': `<h1>Site atualizado</h1><script>const banco = '${database.url}';</script>`,
    }), ownerCookie, 'PUT');
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.url, app.body.url);
    assert.equal((await http(port, appHost, 'GET', '/index.html')).body,
      `<h1>Site atualizado</h1><script>const banco = '${database.url}';</script>`);
    const appsAfterUpdate = JSON.parse((await http(port, 'localhost', 'GET', '/api/apps', null,
      { Cookie: ownerCookie })).body);
    assert.equal(appsAfterUpdate.length, 1);
    assert.deepEqual(appsAfterUpdate[0].databaseIds, [database.id]);

    const largeBody = JSON.stringify({ texto: 'x'.repeat(11 * 1024 * 1024) });
    assert.ok(Buffer.byteLength(largeBody) > 10 * 1024 * 1024);
    const largeUpload = await upload(port, '/api/databases', 'grande.json', Buffer.from(largeBody), ownerCookie);
    assert.equal(largeUpload.status, 201, JSON.stringify(largeUpload.body));
    const largePath = `/api/db-access/${largeUpload.body.database.id}`;
    const largeAuth = { Authorization: `Bearer ${largeUpload.body.token}` };
    const largeRead = await http(port, 'localhost', 'GET', largePath, null, largeAuth);
    assert.equal(largeRead.status, 200);
    assert.equal(largeRead.body, largeBody);
    const largeUpdate = JSON.stringify({ texto: 'y'.repeat(11 * 1024 * 1024) });
    const largeSave = await http(port, 'localhost', 'PUT', largePath, largeUpdate,
      { ...largeAuth, 'If-Match': largeRead.headers.etag, 'Content-Type': 'application/json' });
    assert.equal(largeSave.status, 200, largeSave.body);
    assert.equal((await http(port, 'localhost', 'GET', largePath, null, largeAuth)).body, largeUpdate);
    assert.equal((await http(port, 'localhost', 'GET', `/api/databases/${largeUpload.body.database.id}/download`,
      null, { Cookie: ownerCookie })).body, largeUpdate);
    await stop();
    await start();
    assert.equal((await http(port, 'localhost', 'GET', dbPath, null, auth)).body, '{"valor":2}');
    assert.equal((await readFile(path.join(dataDir, 'databases', database.id, 'data.json'), 'utf8')), '{"valor":2}');
    assert.equal((await http(port, 'localhost', 'GET', '/api/databases', null, { Cookie: ownerCookie })).status, 401);
    const relogin = await http(port, 'localhost', 'POST', '/api/login', JSON.stringify({ password: 'senha-muito-longa-123' }),
      { Origin: portalOrigin, 'Content-Type': 'application/json' });
    assert.equal(relogin.status, 200);
    const newOwnerCookie = relogin.headers['set-cookie'][0].split(';')[0];
    assert.equal(JSON.parse((await http(port, 'localhost', 'POST', revealInitialPath, null,
      { Cookie: newOwnerCookie, Origin: portalOrigin })).body).token, token);
  } finally { await stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('modo LAN retorna URLs por IP e separa portal e aplicações por porta', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'super-sandbox-lan-'));
  const port = await freePort();
  const appPort = await freePort();
  const ip = '192.168.1.77';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: project,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PUBLIC_PORT: String(port),
      APP_PORT: String(appPort), PUBLIC_APP_PORT: String(appPort), PUBLIC_HOST: ip, MAX_JSON_MB: '1' },
    stdio: 'pipe',
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error('Servidor LAN encerrou antes de iniciar.');
      try { ready = (await http(port, ip, 'GET', '/health')).status === 200; }
      catch { /* aguardando */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const origin = `http://${ip}:${port}`;
    const setup = await http(port, ip, 'POST', '/api/setup', JSON.stringify({ password: 'senha-de-teste-123' }),
      { Origin: origin, 'Content-Type': 'application/json' });
    assert.equal(setup.status, 201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    assert.equal(JSON.parse((await http(port, ip, 'GET', '/api/session')).body).maxJsonMb, 1);
    const tooLarge = await upload(port, '/api/databases', 'grande.json',
      Buffer.from(JSON.stringify({ texto: 'x'.repeat(1024 * 1024) })), cookie);
    assert.equal(tooLarge.status, 413);
    const database = await upload(port, '/api/databases', 'dados.json', Buffer.from('{"valor":1}'), cookie);
    assert.equal(database.status, 201);
    assert.equal(database.body.database.url, `${origin}/api/db-access/${database.body.database.id}`);
    const app = await upload(port, '/api/apps', 'site.zip', await zip({
      'site/index.html': '<h1>Site LAN</h1><script src="assets/app.js"></script>',
      'site/assets/app.js': 'window.ok = true;',
    }), cookie);
    assert.equal(app.status, 201);
    const base = `/apps/${app.body.id}`;
    assert.equal(app.body.url, `http://${ip}:${appPort}${base}/`);
    assert.equal((await http(appPort, ip, 'GET', base)).headers.location, `${base}/`);
    assert.equal((await http(appPort, ip, 'GET', `${base}/`)).headers.location, `${base}/index.html`);
    assert.equal((await http(appPort, ip, 'GET', `${base}/index.html`)).body,
      '<h1>Site LAN</h1><script src="assets/app.js"></script>');
    assert.equal((await http(appPort, ip, 'GET', `${base}/assets/app.js`)).body, 'window.ok = true;');
    assert.equal((await http(appPort, ip, 'GET', '/api/databases', null, { Cookie: cookie })).status, 404);
    const db = await http(port, ip, 'GET', `/api/db-access/${database.body.database.id}`, null,
      { Authorization: `Bearer ${database.body.token}`, Origin: `http://${ip}:${appPort}` });
    assert.equal(db.status, 200);
    assert.equal(db.headers['access-control-allow-origin'], '*');
    const tooLargePut = await http(port, ip, 'PUT', `/api/db-access/${database.body.database.id}`,
      JSON.stringify({ texto: 'x'.repeat(1024 * 1024) }),
      { Authorization: `Bearer ${database.body.token}`, 'If-Match': db.headers.etag,
        'Content-Type': 'application/json', Origin: `http://${ip}:${appPort}` });
    assert.equal(tooLargePut.status, 413);
    assert.equal(tooLargePut.headers['access-control-allow-origin'], '*');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('limites do .env valem para bancos e sites, com erro claro sem MySQL', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'super-sandbox-limits-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: project, env: { ...process.env, MYSQL_HOST: '', DATA_DIR: dataDir, PORT: String(port),
      PUBLIC_PORT: String(port), MAX_DATABASES: '1', MAX_APPS: '1' }, stdio: 'pipe',
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error('Servidor encerrou antes de iniciar.');
      try { ready = (await http(port, 'localhost', 'GET', '/health')).status === 200; }
      catch { /* aguardando */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const session = JSON.parse((await http(port, 'localhost', 'GET', '/api/session')).body);
    assert.equal(session.maxDatabases, 1);
    assert.equal(session.maxApps, 1);
    assert.equal(session.mysqlAvailable, false);
    const setup = await http(port, 'localhost', 'POST', '/api/setup', JSON.stringify({ password: 'senha-de-teste-123' }),
      { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' });
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const mysql = await http(port, 'localhost', 'POST', '/api/databases/mysql', JSON.stringify({ name: 'Novo' }),
      { Cookie: cookie, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' });
    assert.equal(mysql.status, 503);
    const firstDb = await upload(port, '/api/databases', 'primeiro.json', Buffer.from('{}'), cookie);
    assert.equal(firstDb.status, 201);
    const secondDb = await upload(port, '/api/databases', 'segundo.json', Buffer.from('{}'), cookie);
    assert.equal(secondDb.status, 409);
    const site = await zip({ 'index.html': '<h1>Site</h1>' });
    const firstSite = await upload(port, '/api/apps', 'primeiro.zip', site, cookie);
    assert.equal(firstSite.status, 201);
    assert.equal((await upload(port, '/api/apps', 'segundo.zip', site, cookie)).status, 409);
    assert.equal((await http(port, 'localhost', 'DELETE', `/api/apps/${firstSite.body.id}`)).status, 401);
    assert.equal((await http(port, 'localhost', 'DELETE', `/api/apps/${firstSite.body.id}`, null,
      { Cookie: cookie, Origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await upload(port, '/api/apps', 'terceiro.zip', site, cookie)).status, 201);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(dataDir, { recursive: true, force: true });
  }
});
