import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createMysqlStore } from '../src/mysql-store.js';

test('MySQL real: importa e altera registros com isolamento e controle de versão',
  { skip: !process.env.MYSQL_TEST_HOST }, async () => {
    const store = createMysqlStore({ host: process.env.MYSQL_TEST_HOST,
      port: process.env.MYSQL_TEST_PORT || 3306,
      user: process.env.MYSQL_TEST_USER || 'sandbox',
      password: process.env.MYSQL_TEST_PASSWORD_FILE
        ? (await readFile(process.env.MYSQL_TEST_PASSWORD_FILE, 'utf8')).trim()
        : process.env.MYSQL_TEST_PASSWORD,
      database: process.env.MYSQL_TEST_DATABASE || 'sandbox' });
    const dbId = randomBytes(8).toString('hex');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ss-mysql-live-'));
    const file = path.join(dir, 'dados.json');
    try {
      await writeFile(file, JSON.stringify({ produtos: [{ nome: 'A', valor: 10 }, { nome: 'B' }],
        configuracao: { moeda: 'BRL' }, vazio: [] }));
      const summary = await store.importFile(dbId, file);
      assert.deepEqual(summary, { collections: 3, records: 3, rootType: 'object' });
      const groups = await store.collections(dbId);
      assert.deepEqual(groups.map(item => [item.name, item.kind, item.count]), [
        ['produtos', 'list', 2], ['configuracao', 'single', 1], ['vazio', 'list', 0],
      ]);
      const firstPage = await store.records(dbId, groups[0].id, 0, 1);
      assert.equal(firstPage.items.length, 1);
      assert.ok(firstPage.nextCursor);
      assert.equal((await store.records(dbId, groups[0].id, firstPage.nextCursor, 1)).items[0].data.nome, 'B');
      const item = firstPage.items[0];
      const updated = await store.updateRecord(dbId, groups[0].id, item.id,
        JSON.stringify({ nome: 'A', valor: 11 }), item.etag);
      assert.equal(updated.data.valor, 11);
      await assert.rejects(store.updateRecord(dbId, groups[0].id, item.id, '{}', item.etag),
        error => error.status === 409);
      const created = await store.addRecord(dbId, groups[0].id, JSON.stringify({ nome: 'C' }));
      assert.equal((await store.record(dbId, groups[0].id, created.id)).data.nome, 'C');
      await store.deleteRecord(dbId, groups[0].id, created.id, created.etag);
      await assert.rejects(store.record(dbId, groups[0].id, created.id), error => error.status === 404);
    } finally {
      await store.deleteDatabase(dbId);
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
