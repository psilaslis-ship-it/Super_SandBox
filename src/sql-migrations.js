import { createHash } from 'node:crypto';

export class SqlMigrationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const identifier = '(?:`([A-Za-z][A-Za-z0-9_]*)`|([A-Za-z][A-Za-z0-9_]*))';
const identifierValue = match => match[1] || match[2];

function statementsFrom(source) {
  const statements = [];
  let current = '';
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; else continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      current += char;
      if (char === '\\' && quote !== '`' && next) { current += next; i++; continue; }
      if (char === quote) {
        if (next === quote) { current += next; i++; }
        else quote = '';
      }
      continue;
    }
    if ((char === '-' && next === '-' && (i + 2 === source.length || /\s/.test(source[i + 2]))) || char === '#') {
      lineComment = true; if (char === '-') i++; continue;
    }
    if (char === '/' && next === '*') { blockComment = true; i++; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; current += char; continue; }
    if (char === ';') { if (current.trim()) statements.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (quote || blockComment) throw new SqlMigrationError('O arquivo SQL contém uma string ou comentário incompleto.');
  if (current.trim()) statements.push(current.trim());
  if (!statements.length) throw new SqlMigrationError('O arquivo SQL não contém comandos.');
  if (statements.length > 100) throw new SqlMigrationError('O arquivo SQL pode conter no máximo 100 alterações.');
  return statements;
}

function splitDefinitions(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\' && quote !== '`') { i++; continue; }
      if (char === quote) { if (value[i + 1] === quote) i++; else quote = ''; }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseColumn(definition) {
  const match = new RegExp(`^\\s*${identifier}\\s+([A-Za-z]+(?:\\s*\\([^)]*\\))?(?:\\s+UNSIGNED)?)\\s*(.*)$`, 'i').exec(definition);
  if (!match) throw new SqlMigrationError(`Definição de coluna inválida: ${definition.slice(0, 80)}.`);
  const name = identifierValue(match);
  if (name.toLowerCase().startsWith('_ss_')) throw new SqlMigrationError('O prefixo _ss_ é reservado para o portal.');
  const type = match[3].replace(/\s+/g, ' ').trim().toUpperCase();
  const allowedType = /^(?:VARCHAR\s*\(\s*\d{1,5}\s*\)|CHAR\s*\(\s*\d{1,4}\s*\)|TINYINT(?:\s*\(\s*1\s*\))?|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL\s*\(\s*\d{1,2}\s*,\s*\d{1,2}\s*\)|FLOAT|DOUBLE|BOOLEAN|BOOL|DATE|DATETIME|TIMESTAMP|TIME|YEAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|JSON|BLOB|MEDIUMBLOB|LONGBLOB)(?: UNSIGNED)?$/i;
  if (!allowedType.test(type)) throw new SqlMigrationError(`Tipo SQL não permitido para a coluna ${name}.`);
  let rest = match[4].trim();
  let nullable = true;
  if (/\bNOT\s+NULL\b/i.test(rest)) { nullable = false; rest = rest.replace(/\bNOT\s+NULL\b/i, '').trim(); }
  else if (/\bNULL\b/i.test(rest)) rest = rest.replace(/\bNULL\b/i, '').trim();
  let defaultValue;
  const defaultMatch = /\bDEFAULT\s+('(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE|CURRENT_TIMESTAMP(?:\(\))?)\s*/i.exec(rest);
  if (defaultMatch) { defaultValue = defaultMatch[1]; rest = (rest.slice(0, defaultMatch.index) + rest.slice(defaultMatch.index + defaultMatch[0].length)).trim(); }
  if (rest) throw new SqlMigrationError(`A definição da coluna ${name} usa uma opção não permitida (${rest.slice(0, 40)}).`);
  if (!nullable && defaultValue === undefined && !/^(?:TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|BLOB|MEDIUMBLOB|LONGBLOB|JSON)$/i.test(type)) {
    // New required columns need a default so existing rows remain valid.
    return { name, type, nullable, defaultValue, definition: `\`${name}\` ${type} NOT NULL` };
  }
  return { name, type, nullable, defaultValue,
    definition: `\`${name}\` ${type}${nullable ? ' NULL' : ' NOT NULL'}${defaultValue === undefined ? '' : ` DEFAULT ${defaultValue}`}` };
}

function parseCreate(statement) {
  const match = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s*\\(([\\s\\S]*)\\)\\s*(?:ENGINE\\s*=\\s*InnoDB)?\\s*(?:DEFAULT\\s+CHARSET\\s*=\\s*utf8mb4)?\\s*$`, 'i').exec(statement);
  if (!match) return null;
  const name = identifierValue(match);
  if (name.length > 40) throw new SqlMigrationError(`O nome da tabela ${name} deve ter até 40 caracteres.`);
  const columns = splitDefinitions(match[3]).map(parseColumn);
  if (!columns.length) throw new SqlMigrationError(`A tabela ${name} precisa ter colunas.`);
  if (columns.length > 100) throw new SqlMigrationError(`A tabela ${name} excede 100 colunas.`);
  if (new Set(columns.map(item => item.name.toLowerCase())).size !== columns.length) throw new SqlMigrationError(`A tabela ${name} repete uma coluna.`);
  return { kind: 'create-table', table: name, columns };
}

function parseAlter(statement) {
  const addColumn = new RegExp(`^ALTER\\s+TABLE\\s+${identifier}\\s+ADD\\s+(?:COLUMN\\s+)?([\\s\\S]+)$`, 'i').exec(statement);
  if (addColumn) {
    const column = parseColumn(addColumn[3]);
    return { kind: 'add-column', table: identifierValue(addColumn), column };
  }
  const rename = new RegExp(`^ALTER\\s+TABLE\\s+${identifier}\\s+RENAME\\s+COLUMN\\s+${identifier}\\s+TO\\s+${identifier}$`, 'i').exec(statement);
  if (rename) return { kind: 'rename-column', table: identifierValue(rename), from: rename[3] || rename[4], to: rename[5] || rename[6] };
  const index = new RegExp(`^ALTER\\s+TABLE\\s+${identifier}\\s+ADD\\s+(?:(UNIQUE)\\s+)?(?:INDEX|KEY)\\s+${identifier}\\s*\\(([^)]+)\\)$`, 'i').exec(statement);
  if (index) return { kind: 'add-index', table: identifierValue(index), unique: !!index[3], name: index[4] || index[5], columns: splitDefinitions(index[6]).map(name => parseIdentifier(name)) };
  const dropIndex = new RegExp(`^ALTER\\s+TABLE\\s+${identifier}\\s+DROP\\s+(?:INDEX|KEY)\\s+${identifier}$`, 'i').exec(statement);
  if (dropIndex) return { kind: 'drop-index', table: identifierValue(dropIndex), name: dropIndex[3] || dropIndex[4] };
  return null;
}

function parseIdentifier(value) {
  const match = new RegExp(`^\\s*${identifier}\\s*$`).exec(value);
  if (!match) throw new SqlMigrationError(`Identificador inválido: ${value.slice(0, 40)}.`);
  return identifierValue(match);
}

function parseIndex(statement) {
  const match = new RegExp(`^CREATE\\s+(?:(UNIQUE)\\s+)?INDEX\\s+${identifier}\\s+ON\\s+${identifier}\\s*\\(([^)]+)\\)$`, 'i').exec(statement);
  if (!match) return null;
  return { kind: 'add-index', unique: !!match[1], name: match[2] || match[3], table: match[4] || match[5],
    columns: splitDefinitions(match[6]).map(parseIdentifier) };
}

export function parseMigration(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 5 * 1024 * 1024) {
    throw new SqlMigrationError('O arquivo SQL pode ter no máximo 5 MB.');
  }
  source = source.replace(/^\uFEFF/, '');
  const parsed = statementsFrom(source).map(statement =>
    parseCreate(statement) || parseAlter(statement) || parseIndex(statement));
  if (parsed.some(item => !item)) {
    throw new SqlMigrationError('Use somente CREATE TABLE, ALTER TABLE ADD/RENAME COLUMN, ALTER TABLE ADD/DROP INDEX e CREATE [UNIQUE] INDEX. Comandos que apagam dados ou alteram usuários não são aceitos.');
  }
  for (const item of parsed) {
    if (item.table.length > 40 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(item.table)) throw new SqlMigrationError('Nome de tabela inválido ou muito longo.');
    if (item.kind === 'add-index' && (!item.name || item.name.length > 40 || item.columns.length > 16)) throw new SqlMigrationError('Nome ou quantidade de colunas do índice inválida.');
  }
  return parsed;
}

export function migrationHash(source) { return createHash('sha256').update(source).digest('hex'); }

export function physicalTableName(dbId, tableName) { return `ssu_${dbId}_${tableName}`; }

export function migrationStatement(item, dbId) {
  const table = `\`${physicalTableName(dbId, item.table)}\``;
  if (item.kind === 'create-table') {
    const columns = item.columns.map(column => column.definition);
    columns.push('`_ss_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '`_ss_version` BIGINT UNSIGNED NOT NULL DEFAULT 1', 'PRIMARY KEY (`_ss_id`)');
    return `CREATE TABLE IF NOT EXISTS ${table} (${columns.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  }
  if (item.kind === 'add-column') return `ALTER TABLE ${table} ADD COLUMN \`${item.column.name}\` ${item.column.definition.slice(item.column.name.length + 3)}`;
  if (item.kind === 'rename-column') return `ALTER TABLE ${table} RENAME COLUMN \`${item.from}\` TO \`${item.to}\``;
  if (item.kind === 'add-index') return `CREATE ${item.unique ? 'UNIQUE ' : ''}INDEX \`${item.name}\` ON ${table} (${item.columns.map(name => `\`${name}\``).join(', ')})`;
  if (item.kind === 'drop-index') return `ALTER TABLE ${table} DROP INDEX \`${item.name}\``;
  throw new SqlMigrationError('Alteração SQL não reconhecida.');
}

