import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('MySQL real: importação, API com chaves, exportação e banco vazio',
  { skip: !process.env.MYSQL_TEST_HOST }, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ss-mysql-api-'));
    const port = await freePort();
    const password = process.env.MYSQL_TEST_PASSWORD_FILE
      ? (await readFile(process.env.MYSQL_TEST_PASSWORD_FILE, 'utf8')).trim()
      : process.env.MYSQL_TEST_PASSWORD;
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: project,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PUBLIC_PORT: String(port),
        MYSQL_HOST: process.env.MYSQL_TEST_HOST, MYSQL_PORT: process.env.MYSQL_TEST_PORT || '3306',
        MYSQL_USER: process.env.MYSQL_TEST_USER || 'sandbox',
        MYSQL_PASSWORD: password, MYSQL_PASSWORD_FILE: '',
        MYSQL_DATABASE: process.env.MYSQL_TEST_DATABASE || 'sandbox' },
      stdio: 'pipe',
    });
    const base = `http://localhost:${port}`;
    const createdIds = [];
    let cookie = '';
    async function api(route, options = {}) {
      return fetch(base + route, { ...options, headers: { Cookie: cookie, ...(options.headers || {}) } });
    }
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error('Servidor MySQL encerrou antes de iniciar.');
        try { ready = (await fetch(base + '/health')).ok; }
        catch { /* aguardando */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(ready, true);
      const setup = await api('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-de-teste-123' }) });
      assert.equal(setup.status, 201);
      cookie = setup.headers.get('set-cookie').split(';')[0];
      const form = new FormData();
      form.append('file', new Blob([JSON.stringify({ produtos: [{ nome: 'A' }, { nome: 'B' }],
        configuracao: { moeda: 'BRL' }, vazio: [] })]), 'dados.json');
      const imported = await api('/api/databases/import', { method: 'POST', body: form });
      assert.equal(imported.status, 201, await imported.clone().text());
      const { database, token } = await imported.json();
      createdIds.push(database.id);
      assert.equal(database.kind, 'mysql');
      assert.equal(database.summary.records, 3);
      const structure = await (await api(`/api/databases/${database.id}/structure`)).json();
      assert.deepEqual(structure.collections.map(group => group.name), ['produtos', 'configuracao', 'vazio']);
      const endpoint = `/api/db-access/${database.id}`;
      assert.equal((await api(endpoint + '/collections')).status, 401);
      const auth = { Authorization: `Bearer ${token}` };
      assert.equal((await api(endpoint + '/collections', { method: 'OPTIONS' })).status, 204);
      const groupId = structure.collections[0].id;
      const first = await (await api(`${endpoint}/collections/${groupId}/records?limit=1`, { headers: auth })).json();
      assert.equal(first.items[0].data.nome, 'A');
      assert.ok(first.nextCursor);
      const second = await (await api(`${endpoint}/collections/${groupId}/records?limit=1&cursor=${first.nextCursor}`,
        { headers: auth })).json();
      assert.equal(second.items[0].data.nome, 'B');
      const itemPath = `${endpoint}/collections/${groupId}/records/${first.items[0].id}`;
      const update = await api(itemPath, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json',
        'If-Match': first.items[0].etag }, body: JSON.stringify({ nome: 'A+' }) });
      assert.equal(update.status, 200, await update.clone().text());
      assert.equal((await api(itemPath, { method: 'PUT', headers: { ...auth, 'If-Match': first.items[0].etag },
        body: '{}' })).status, 409);
      const exported = await api(`/api/databases/${database.id}/download`);
      assert.equal(exported.status, 200);
      assert.deepEqual(await exported.json(), { produtos: [{ nome: 'A+' }, { nome: 'B' }],
        configuracao: { moeda: 'BRL' }, vazio: [] });
      const empty = await api('/api/databases/mysql', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Novo' }) });
      assert.equal(empty.status, 201, await empty.clone().text());
      const emptyDb = (await empty.json()).database;
      createdIds.push(emptyDb.id);
      const emptyStructure = await (await api(`/api/databases/${emptyDb.id}/structure`)).json();
      assert.deepEqual(emptyStructure.collections.map(group => group.name), ['Dados']);
    } finally {
      for (const id of createdIds) await api(`/api/databases/${id}`, { method: 'DELETE' }).catch(() => {});
      if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      await rm(dataDir, { recursive: true, force: true });
    }
  });
