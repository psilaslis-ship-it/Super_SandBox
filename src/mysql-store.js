import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { parser } from 'stream-json';
import Assembler from 'stream-json/assembler.js';
import { readFile } from 'node:fs/promises';
import { parseMigration, migrationHash, migrationStatement, physicalTableName, SqlMigrationError } from './sql-migrations.js';

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
      await pool.execute(`CREATE TABLE IF NOT EXISTS ss_schema_migrations (
        db_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        statement_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (db_id, statement_hash)
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
    await pool.execute('DELETE FROM ss_schema_migrations WHERE db_id=?', [dbId]);
    const prefix = `ssu_${dbId}_`;
    const [rows] = await pool.execute(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME, ?) = ?`, [prefix.length, prefix]);
    for (const row of rows) await pool.execute(`DROP TABLE IF EXISTS \`${row.name.replaceAll('`', '``')}\``);
  }

  const quote = name => `\`${String(name).replaceAll('`', '``')}\``;
  const tableInfo = async (dbId, onlyName = null, includeCounts = true) => {
    await ready();
    const prefix = `ssu_${dbId}_`;
    const [rows] = await pool.execute(`SELECT TABLE_NAME AS physical FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME, ?) = ? ${onlyName === null ? '' : 'AND TABLE_NAME=?'} ORDER BY TABLE_NAME`,
      onlyName === null ? [prefix.length, prefix] : [prefix.length, prefix, physicalTableName(dbId, onlyName)]);
    return Promise.all(rows.map(async row => {
      const name = row.physical.slice(prefix.length);
      const physical = quote(row.physical);
      const [columns] = await pool.execute(`SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
        IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, ORDINAL_POSITION AS position
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [row.physical]);
      let count = null;
      if (includeCounts) {
        const [counts] = await pool.execute(`SELECT COUNT(*) AS count FROM ${physical}`);
        count = Number(counts[0].count);
      }
      return { name, physical: row.physical, columns: columns.filter(col => !col.name.startsWith('_ss_')),
        count };
    }));
  };

  async function sqlTables(dbId) {
    return (await tableInfo(dbId)).map(({ name, columns, count }) => ({
      name, columns: columns.map(({ name, dataType, columnType, nullable, defaultValue }) =>
        ({ name, dataType, columnType, nullable: nullable === 'YES', defaultValue })), count,
    }));
  }

  async function applySqlFile(dbId, file, fileName = 'atualizacao.sql') {
    await ready();
    const source = await readFile(file, 'utf8');
    const migration = parseMigration(source);
    const fileHash = migrationHash(source);
    let applied = 0;
    let skipped = 0;
    for (const item of migration) {
      const sql = migrationStatement(item, dbId);
      const statementHash = migrationHash(sql);
      const [existing] = await pool.execute('SELECT 1 FROM ss_schema_migrations WHERE db_id=? AND statement_hash=?',
        [dbId, statementHash]);
      if (existing.length) { skipped++; continue; }
      try { await pool.execute(sql); }
      catch (error) {
        if (['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_DUP_ENTRY', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR',
          'ER_DUP_KEY', 'ER_TOO_LONG_IDENT'].includes(error.code)) {
          throw new StoreError(409, 'Uma alteração não pôde ser aplicada porque a tabela, coluna ou índice já existe ou não corresponde aos dados. As alterações concluídas antes desse ponto permanecem aplicadas; corrija o arquivo e envie-o novamente.');
        }
        throw error;
      }
      await pool.execute('INSERT INTO ss_schema_migrations (db_id, statement_hash, file_name) VALUES (?, ?, ?)',
        [dbId, statementHash, path.basename(fileName).slice(0, 255)]);
      applied++;
    }
    return { fileHash, applied, skipped, tables: await sqlTables(dbId) };
  }

  function sqlPhysical(dbId, tableName) {
    if (typeof tableName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(tableName)) {
      throw new StoreError(404, 'Tabela não encontrada.');
    }
    return quote(physicalTableName(dbId, tableName));
  }

  async function sqlTable(dbId, tableName) {
    const tables = await tableInfo(dbId, tableName, false);
    const item = tables.find(table => table.name === tableName);
    if (!item) throw new StoreError(404, 'Tabela não encontrada neste banco.');
    return item;
  }

  function sqlItem(row, columns) {
    const data = {};
    for (const column of columns) data[column.name] = row[column.name];
    return { id: String(row._ss_id), data, etag: `"${row._ss_version}"` };
  }

  async function sqlRows(dbId, tableName, cursor = 0, limit = 50) {
    const table = await sqlTable(dbId, tableName);
    const selected = ['`_ss_id`', '`_ss_version`', ...table.columns.map(column => quote(column.name))].join(', ');
    const [rows] = await pool.execute(`SELECT ${selected} FROM ${sqlPhysical(dbId, tableName)}
      WHERE _ss_id>? ORDER BY _ss_id LIMIT ?`, [cursor, limit + 1]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { items: page.map(row => sqlItem(row, table.columns)),
      nextCursor: hasMore ? Number(page.at(-1)._ss_id) : null };
  }

  async function sqlRecord(dbId, tableName, recordId) {
    const table = await sqlTable(dbId, tableName);
    const selected = ['`_ss_id`', '`_ss_version`', ...table.columns.map(column => quote(column.name))].join(', ');
    const [rows] = await pool.execute(`SELECT ${selected} FROM ${sqlPhysical(dbId, tableName)} WHERE _ss_id=?`, [recordId]);
    if (!rows.length) throw new StoreError(404, 'Registro não encontrado.');
    return sqlItem(rows[0], table.columns);
  }

  function sqlValues(table, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreError(400, 'Envie um objeto JSON para este registro.');
    const allowed = new Map(table.columns.map(column => [column.name, column]));
    const keys = Object.keys(data);
    if (!keys.length || keys.some(key => !allowed.has(key))) throw new StoreError(400, 'Os campos enviados não correspondem à estrutura desta tabela.');
    return { keys, values: keys.map(key => {
      const value = data[key];
      return allowed.get(key).dataType === 'json' && value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    }) };
  }

  async function addSqlRow(dbId, tableName, data) {
    const table = await sqlTable(dbId, tableName);
    const { keys, values } = sqlValues(table, data);
    const columns = keys.map(quote).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const [result] = await pool.execute(`INSERT INTO ${sqlPhysical(dbId, tableName)} (${columns}) VALUES (${placeholders})`, values);
    return sqlRecord(dbId, tableName, String(result.insertId));
  }

  async function updateSqlRow(dbId, tableName, recordId, data, etag) {
    const version = /^"([1-9]\d*)"$/.exec(etag || '')?.[1];
    if (!version) throw new StoreError(428, 'Leia o registro antes de salvar e envie o ETag recebido.');
    const table = await sqlTable(dbId, tableName);
    const { keys, values } = sqlValues(table, data);
    const set = keys.map(key => `${quote(key)}=?`).join(', ');
    const [result] = await pool.execute(`UPDATE ${sqlPhysical(dbId, tableName)} SET ${set}, _ss_version=_ss_version+1
      WHERE _ss_id=? AND _ss_version=?`, [...values, recordId, version]);
    if (!result.affectedRows) { await sqlRecord(dbId, tableName, recordId); throw new StoreError(409, 'O registro mudou. Recarregue antes de salvar.'); }
    return sqlRecord(dbId, tableName, recordId);
  }

  async function deleteSqlRow(dbId, tableName, recordId, etag) {
    const version = /^"([1-9]\d*)"$/.exec(etag || '')?.[1];
    if (!version) throw new StoreError(428, 'Leia o registro antes de apagar e envie o ETag recebido.');
    const [result] = await pool.execute(`DELETE FROM ${sqlPhysical(dbId, tableName)} WHERE _ss_id=? AND _ss_version=?`,
      [recordId, version]);
    if (!result.affectedRows) { await sqlRecord(dbId, tableName, recordId); throw new StoreError(409, 'O registro mudou. Recarregue antes de apagar.'); }
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
    updateRecord, deleteRecord, deleteDatabase, importFile, sqlTables, applySqlFile, sqlRows,
    addSqlRow, sqlRecord, updateSqlRow, deleteSqlRow, close: () => pool.end() };
}
