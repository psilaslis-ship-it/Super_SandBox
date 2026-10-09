import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { parser } from 'stream-json';
import Assembler from 'stream-json/assembler.js';

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const newId = () => randomBytes(8).toString('hex');
const recordLimit = 16 * 1024 * 1024;

export async function importJsonFile(file, onCollection, onRecord) {
  let root = 'waiting';
  let property = null;
  let collection = null;
  let kind = null;
  let assembler = null;
  let collections = 0;
  let records = 0;
  let rootType = 'scalar';
  const names = new Set();

  async function addCollection(name, nextKind) {
    if (++collections > 200) throw new StoreError(400, 'O JSON contém mais de 200 grupos de dados.');
    if (names.has(name)) throw new StoreError(400, `O grupo "${name}" aparece mais de uma vez no JSON.`);
    names.add(name);
    collection = await onCollection(name, nextKind, collections);
    kind = nextKind;
  }

  async function addValue(token) {
    assembler = new Assembler();
    assembler.consume(token);
    await finishValue();
  }

  async function finishValue() {
    if (!assembler?.done) return;
    const value = assembler.current;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > recordLimit) throw new StoreError(413, 'Um item do JSON excede 16 MB. Divida esse item antes de importar.');
    if (++records > 1_000_000) throw new StoreError(400, 'O JSON contém mais de um milhão de itens.');
    await onRecord(collection, body);
    assembler = null;
    if (kind === 'single') { collection = null; kind = null; }
  }

  for await (const token of fs.createReadStream(file).pipe(parser.asStream({ streamValues: false }))) {
    if (assembler) { assembler.consume(token); await finishValue(); continue; }
    if (root === 'waiting') {
      if (token.name === 'startObject') { root = 'object'; rootType = 'object'; continue; }
      if (token.name === 'startArray') { root = 'array'; rootType = 'array'; await addCollection('Itens', 'list'); continue; }
      root = 'scalar';
      await addCollection('Conteúdo', 'single');
      await addValue(token);
      root = 'done';
      continue;
    }
    if (root === 'object') {
      if (kind === 'list') {
        if (token.name === 'endArray') { collection = null; kind = null; continue; }
        await addValue(token);
        continue;
      }
      if (property !== null) {
        const name = property;
        property = null;
        if (token.name === 'startArray') { await addCollection(name, 'list'); continue; }
        await addCollection(name, 'single');
        await addValue(token);
        continue;
      }
      if (token.name === 'keyValue') { property = token.value; continue; }
      if (token.name === 'endObject') { root = 'done'; continue; }
    }
    if (root === 'array') {
      if (token.name === 'endArray') { root = 'done'; collection = null; kind = null; continue; }
      await addValue(token);
      continue;
    }
    throw new StoreError(400, 'Estrutura do JSON não pôde ser importada.');
  }
  if (root !== 'done') throw new StoreError(400, 'O JSON está incompleto.');
  return { collections, records, rootType };
}

export function createMysqlStore(config) {
  if (!config?.host) return null;
  const pool = mysql.createPool({
    host: config.host, port: Number(config.port || 3306),
    user: config.user, password: config.password, database: config.database,
    waitForConnections: true, connectionLimit: 8, queueLimit: 50,
    charset: 'utf8mb4',
  });
  let schemaPromise;

  async function ready() {
    if (!schemaPromise) schemaPromise = (async () => {
      await pool.execute(`CREATE TABLE IF NOT EXISTS ss_collections (
        db_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        collection_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        name VARCHAR(255) NOT NULL,
        kind ENUM('list','single') NOT NULL,
        position INT UNSIGNED NOT NULL,
        PRIMARY KEY (db_id, collection_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await pool.execute(`CREATE TABLE IF NOT EXISTS ss_records (
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        db_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        collection_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        record_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payload JSON NOT NULL,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (seq),
        UNIQUE KEY record_identity (db_id, collection_id, record_id),
        KEY record_page (db_id, collection_id, seq),
        CONSTRAINT ss_records_collection FOREIGN KEY (db_id, collection_id)
          REFERENCES ss_collections (db_id, collection_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    })().catch(error => { schemaPromise = null; throw error; });
    return schemaPromise;
  }

  async function addCollection(dbId, name, kind = 'list', position = 0, preserveName = false) {
    await ready();
    if (typeof name !== 'string' || (!preserveName && !name.trim()) || name.length > 255 || !['list', 'single'].includes(kind)) {
      throw new StoreError(400, 'Informe um nome de até 255 caracteres para o grupo de dados.');
    }
    const savedName = preserveName ? name : name.trim();
    const [existing] = await pool.execute('SELECT 1 FROM ss_collections WHERE db_id=? AND BINARY name=BINARY ? LIMIT 1',
      [dbId, savedName]);
    if (existing.length) throw new StoreError(409, 'Já existe um grupo com esse nome.');
    const id = newId();
    await pool.execute('INSERT INTO ss_collections (db_id, collection_id, name, kind, position) VALUES (?, ?, ?, ?, ?)',
      [dbId, id, savedName, kind, position]);
    return { id, name: savedName, kind };
  }

  async function collection(dbId, collectionId) {
    await ready();
    const [rows] = await pool.execute('SELECT collection_id AS id, name, kind FROM ss_collections WHERE db_id=? AND collection_id=?',
      [dbId, collectionId]);
    if (!rows.length) throw new StoreError(404, 'Grupo de dados não encontrado.');
    return rows[0];
  }

  async function collections(dbId) {
    await ready();
    const [rows] = await pool.execute(`SELECT c.collection_id AS id, c.name, c.kind, COUNT(r.seq) AS count
      FROM ss_collections c LEFT JOIN ss_records r ON r.db_id=c.db_id AND r.collection_id=c.collection_id
      WHERE c.db_id=? GROUP BY c.db_id, c.collection_id, c.name, c.kind, c.position ORDER BY c.position`, [dbId]);
    return rows.map(row => ({ ...row, count: Number(row.count) }));
  }

  async function addRecord(dbId, collectionId, body) {
    const group = await collection(dbId, collectionId);
    if (Buffer.byteLength(body) > recordLimit) throw new StoreError(413, 'Um item pode ter no máximo 16 MB.');
    if (group.kind === 'single') {
      const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM ss_records WHERE db_id=? AND collection_id=?',
        [dbId, collectionId]);
      if (Number(rows[0].count) > 0) throw new StoreError(409, 'Este grupo já tem um valor. Atualize o item existente.');
    }
    const id = newId();
    await pool.execute('INSERT INTO ss_records (db_id, collection_id, record_id, payload) VALUES (?, ?, ?, ?)',
      [dbId, collectionId, id, body]);
    return { id, data: JSON.parse(body), etag: '"1"' };
  }

  async function records(dbId, collectionId, cursor = 0, limit = 50) {
    await collection(dbId, collectionId);
    const [rows] = await pool.execute(`SELECT seq, record_id AS id, payload AS data, version
      FROM ss_records WHERE db_id=? AND collection_id=? AND seq>? ORDER BY seq LIMIT ?`,
      [dbId, collectionId, cursor, limit + 1]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { items: page.map(row => ({ id: row.id, data: row.data, etag: `"${row.version}"` })),
      nextCursor: hasMore ? Number(page.at(-1).seq) : null };
  }

  async function record(dbId, collectionId, recordId) {
    await ready();
    const [rows] = await pool.execute(`SELECT record_id AS id, payload AS data, version FROM ss_records
      WHERE db_id=? AND collection_id=? AND record_id=?`, [dbId, collectionId, recordId]);
    if (!rows.length) throw new StoreError(404, 'Item não encontrado.');
    return { id: rows[0].id, data: rows[0].data, etag: `"${rows[0].version}"` };
  }

  async function updateRecord(dbId, collectionId, recordId, body, etag) {
    if (Buffer.byteLength(body) > recordLimit) throw new StoreError(413, 'Um item pode ter no máximo 16 MB.');
    const version = /^"([1-9]\d*)"$/.exec(etag || '')?.[1];
    if (!version) throw new StoreError(428, 'Leia o item antes de salvar e informe o ETag em If-Match.');
    await ready();
    const [result] = await pool.execute(`UPDATE ss_records SET payload=?, version=version+1
      WHERE db_id=? AND collection_id=? AND record_id=? AND version=?`,
      [body, dbId, collectionId, recordId, version]);
    if (!result.affectedRows) { await record(dbId, collectionId, recordId); throw new StoreError(409, 'O item mudou. Recarregue antes de salvar.'); }
    return { id: recordId, data: JSON.parse(body), etag: `"${BigInt(version) + 1n}"` };
  }

  async function deleteRecord(dbId, collectionId, recordId, etag) {
    const version = /^"([1-9]\d*)"$/.exec(etag || '')?.[1];
    if (!version) throw new StoreError(428, 'Leia o item antes de apagar e informe o ETag em If-Match.');
    await ready();
    const [result] = await pool.execute('DELETE FROM ss_records WHERE db_id=? AND collection_id=? AND record_id=? AND version=?',
      [dbId, collectionId, recordId, version]);
    if (!result.affectedRows) { await record(dbId, collectionId, recordId); throw new StoreError(409, 'O item mudou. Recarregue antes de apagar.'); }
  }

  async function deleteDatabase(dbId) {
    await ready();
    await pool.execute('DELETE FROM ss_collections WHERE db_id=?', [dbId]);
  }

  async function importFile(dbId, file) {
    await ready();
    let batch = [];
    let bytes = 0;
    async function flush() {
      if (!batch.length) return;
      const placeholders = batch.map(() => '(?, ?, ?, ?)').join(',');
      await pool.execute(`INSERT INTO ss_records (db_id, collection_id, record_id, payload) VALUES ${placeholders}`,
        batch.flat());
      batch = []; bytes = 0;
    }
    try {
      const summary = await importJsonFile(file,
        async (name, kind, position) => { await flush(); return addCollection(dbId, name, kind, position, true); },
        async (group, body) => {
          const size = Buffer.byteLength(body);
          if (batch.length >= 100 || bytes + size > 4 * 1024 * 1024) await flush();
          batch.push([dbId, group.id, newId(), body]);
          bytes += size;
        });
      await flush();
      return summary;
    } catch (error) { await deleteDatabase(dbId).catch(cleanupError => console.error('Falha na limpeza da importação:', cleanupError)); throw error; }
  }

  return { ready, addCollection, collections, collection, addRecord, records, record,
    updateRecord, deleteRecord, deleteDatabase, importFile, close: () => pool.end() };
}
