import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { isIP } from 'node:net';
import { once } from 'node:events';
import Busboy from 'busboy';
import yauzl from 'yauzl';
import { verifyFile } from 'stream-json/file/verifier.js';
import { createMysqlStore } from './mysql-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const portalDir = path.join(here, 'portal');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const appsDir = path.join(dataDir, 'apps');
const databasesDir = path.join(dataDir, 'databases');
const tmpDir = path.join(dataDir, 'tmp');
const ownerFile = path.join(dataDir, 'owner.json');
const port = Number(process.env.PORT || 8080);
const appPort = Number(process.env.APP_PORT || 8081);
const domain = (process.env.PUBLIC_BASE_DOMAIN || 'localhost').toLowerCase();
const publicHost = (process.env.PUBLIC_HOST || domain).toLowerCase();
const lanMode = publicHost !== domain;
if (lanMode && isIP(publicHost) !== 4) throw new Error('PUBLIC_HOST deve ser um endereço IPv4 no modo de rede local.');
const scheme = process.env.PUBLIC_SCHEME || 'http';
const publicPort = process.env.PUBLIC_PORT || String(port);
const publicAppPort = process.env.PUBLIC_APP_PORT || String(appPort);
const maxZipBytes = 50 * 1024 * 1024;
const maxExtractedBytes = 250 * 1024 * 1024;
const maxJsonMb = Number(process.env.MAX_JSON_MB || 512);
if (!Number.isSafeInteger(maxJsonMb) || maxJsonMb < 1 || !Number.isSafeInteger(maxJsonMb * 1024 * 1024)) {
  throw new Error('MAX_JSON_MB deve ser um inteiro positivo válido.');
}
const maxJsonBytes = maxJsonMb * 1024 * 1024;
const maxSqlMb = Number(process.env.MAX_SQL_MB || 5);
if (!Number.isSafeInteger(maxSqlMb) || maxSqlMb < 1 || maxSqlMb > 50) throw new Error('MAX_SQL_MB deve ser um inteiro entre 1 e 50.');
const maxSqlBytes = maxSqlMb * 1024 * 1024;
function positiveLimit(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} deve ser um inteiro positivo.`);
  return value;
}
const maxDatabases = positiveLimit('MAX_DATABASES', 20);
const maxApps = positiveLimit('MAX_APPS', 20);
const mysqlPassword = process.env.MYSQL_PASSWORD_FILE
  ? fs.readFileSync(process.env.MYSQL_PASSWORD_FILE, 'utf8').trim()
  : process.env.MYSQL_PASSWORD;
const mysqlStore = createMysqlStore(process.env.MYSQL_HOST ? {
  host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT,
  user: process.env.MYSQL_USER || 'sandbox', password: mysqlPassword,
  database: process.env.MYSQL_DATABASE || 'sandbox',
} : null);
const maxEntries = 2000;
const sessions = new Map();
const loginFailures = new Map();
const dbLocks = new Map();
const dbCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Allow-Private-Network': 'true',
  'Cache-Control': 'no-store',
};

const mime = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function appUrl(id) {
  if (lanMode) return `${scheme}://${publicHost}:${publicAppPort}/apps/${id}/`;
  const suffix = (scheme === 'http' && publicPort === '80') ||
    (scheme === 'https' && publicPort === '443') ? '' : `:${publicPort}`;
  return `${scheme}://${id}.${domain}${suffix}/`;
}

function portalOrigin(host = publicHost) {
  const suffix = (scheme === 'http' && publicPort === '80') ||
    (scheme === 'https' && publicPort === '443') ? '' : `:${publicPort}`;
  return `${scheme}://${host}${suffix}`;
}

function databaseUrl(id) { return `${portalOrigin()}/api/db-access/${id}`; }

function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }

function tokenEncryptionKey(password, salt) {
  return scryptSync(password, `${salt}:database-keys-v1`, 32);
}

function sealToken(token, encryptionKey, databaseId, keyId) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(`${databaseId}:${keyId}`));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { nonce: nonce.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function unsealToken(sealed, encryptionKey, databaseId, keyId, expectedHash) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(sealed.nonce, 'base64'));
    decipher.setAAD(Buffer.from(`${databaseId}:${keyId}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const token = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    if (hashToken(token) !== expectedHash) throw new Error('Chave inconsistente.');
    return token;
  } catch { throw new HttpError(409, 'Não foi possível recuperar esta chave. Gere uma nova para este acesso.'); }
}

function cookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? match[1] : '';
}

function currentSession(req) {
  const token = cookie(req, 'ss_session');
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  return session;
}

function requireOwner(req) {
  const session = currentSession(req);
  if (!session) throw new HttpError(401, 'Entre no portal para continuar.');
  return session;
}

function checkOrigin(req, host) {
  const origin = req.headers.origin;
  if (origin && origin !== portalOrigin(host)) throw new HttpError(403, 'Origem não permitida.');
}

function setSessionCookie(res, value, maxAge) {
  const secure = scheme === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ss_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

async function ownerRecord() {
  try { return JSON.parse(await fsp.readFile(ownerFile, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function passwordHash(password, salt) { return scryptSync(password, salt, 64).toString('hex'); }

function newSession(res, password, salt) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + 12 * 60 * 60 * 1000, encryptionKey: tokenEncryptionKey(password, salt) });
  setSessionCookie(res, token, 12 * 60 * 60);
}

function safePath(root, urlPath, decode = true) {
  let decoded;
  try { decoded = decode ? decodeURIComponent(urlPath) : urlPath; }
  catch { throw new HttpError(400, 'Caminho inválido.'); }
  if (decoded.includes('\\') || decoded.includes('\0')) throw new HttpError(400, 'Caminho inválido.');
  const target = path.resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(403, 'Caminho fora da aplicação.');
  return target;
}

function validZipName(name) {
  if (!name || name.startsWith('/') || name.startsWith('\\') || name.includes('\\') ||
      name.includes('\0') || name.includes(':') || name.split('/').some(p => p === '..' || p === '.')) {
    throw new HttpError(400, 'O ZIP contém um caminho inseguro.');
  }
  return name;
}

async function extractZip(zipPath, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  const zip = await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true }, (err, file) => err ? reject(err) : resolve(file));
  });
  let count = 0;
  let total = 0;
  try {
    await new Promise((resolve, reject) => {
      let failed = false;
      const fail = err => { if (!failed) { failed = true; zip.close(); reject(err); } };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', async entry => {
        try {
          if (++count > maxEntries) throw new HttpError(400, 'O ZIP tem arquivos demais.');
          const name = validZipName(entry.fileName);
          total += entry.uncompressedSize;
          if (total > maxExtractedBytes) throw new HttpError(400, 'O ZIP descompactado excede 250 MB.');
          const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixMode === 0o120000) throw new HttpError(400, 'Links simbólicos não são permitidos no ZIP.');
          const destination = safePath(targetDir, '/' + name, false);
          if (name.endsWith('/')) await fsp.mkdir(destination, { recursive: true });
          else {
            await fsp.mkdir(path.dirname(destination), { recursive: true });
            const source = await new Promise((resolveStream, rejectStream) => {
              zip.openReadStream(entry, (err, stream) => err ? rejectStream(err) : resolveStream(stream));
            });
            await pipeline(source, fs.createWriteStream(destination, { flags: 'wx' }));
          }
          zip.readEntry();
        } catch (err) { fail(err); }
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

async function walk(dir, base = dir, results = []) {
  for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) await walk(full, base, results);
    else if (item.isFile()) results.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return results;
}

async function inspectSite(extractDir) {
  let siteRoot = extractDir;
  while (true) {
    const items = await fsp.readdir(siteRoot, { withFileTypes: true });
    if (items.length !== 1 || !items[0].isDirectory()) break;
    siteRoot = path.join(siteRoot, items[0].name);
  }
  const files = await walk(siteRoot);
  if (files.some(f => f.split('/').includes('db_global'))) {
    throw new HttpError(400, 'Envie o banco JSON separadamente; retire db_global do ZIP do site.');
  }
  const html = files.filter(f => /\.html?$/i.test(f));
  if (!html.length) throw new HttpError(400, 'O ZIP precisa conter um arquivo HTML.');
  html.sort((a, b) => {
    const score = f => (f.toLowerCase() === 'index.html' ? -100 : /(^|\/)index\.html$/i.test(f) ? -50 : 0) + f.split('/').length;
    return score(a) - score(b) || a.localeCompare(b);
  });
  return { root: path.relative(extractDir, siteRoot), entry: html[0] };
}

async function receiveFile(req, destination, extension, maxBytes) {
  return new Promise((resolve, reject) => {
    let fileSeen = false;
    let failed = false;
    let deferredError = null;
    let originalName = '';
    let outputDone = Promise.resolve();
    const fail = err => { if (!failed) { failed = true; reject(err); } };
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 0 } }); }
    catch { return fail(new HttpError(400, 'Envie um formulário com um arquivo.')); }
    parser.on('file', (field, stream, info) => {
      if (field !== 'file' || fileSeen) { stream.resume(); return fail(new HttpError(400, 'Envie um único arquivo no campo file.')); }
      fileSeen = true;
      originalName = path.basename(info.filename || `arquivo${extension}`);
      if (!originalName.toLowerCase().endsWith(extension)) { stream.resume(); return fail(new HttpError(400, `Selecione um arquivo ${extension}.`)); }
      stream.on('limit', () => { deferredError = new HttpError(413, `O arquivo excede ${Math.round(maxBytes / 1024 / 1024)} MB.`); });
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      outputDone = new Promise((done, outputFailed) => {
        output.on('finish', done);
        output.on('error', outputFailed);
      });
      stream.pipe(output);
      output.on('error', fail);
      stream.on('error', fail);
    });
    parser.on('filesLimit', () => fail(new HttpError(400, 'Envie apenas um arquivo.')));
    parser.on('fieldsLimit', () => fail(new HttpError(400, 'Campos extras não são aceitos.')));
    parser.on('error', fail);
    req.on('aborted', () => fail(new HttpError(400, 'Upload interrompido.')));
    parser.on('close', async () => {
      if (!failed) {
        if (!fileSeen) return fail(new HttpError(400, 'O arquivo não foi recebido por completo.'));
        try { await outputDone; if (deferredError) fail(deferredError); else resolve(originalName); }
        catch (err) { fail(err); }
      }
    });
    req.pipe(parser);
  });
}

async function upload(req, res) {
  const id = randomBytes(8).toString('hex');
  const tempZip = path.join(tmpDir, `${id}.zip`);
  const tempApp = path.join(tmpDir, id);
  try {
    const filename = await receiveFile(req, tempZip, '.zip', maxZipBytes);
    try { await extractZip(tempZip, path.join(tempApp, 'site')); }
    catch (err) { throw err instanceof HttpError ? err : new HttpError(400, 'O arquivo ZIP é inválido ou está corrompido.'); }
    const site = await inspectSite(path.join(tempApp, 'site'));
    const meta = { id, name: filename.replace(/\.zip$/i, ''), createdAt: new Date().toISOString(), ...site };
    await fsp.writeFile(path.join(tempApp, 'meta.json'), JSON.stringify(meta, null, 2));
    await withDbLock('catalog:apps', async () => {
      if ((await listApps()).length >= maxApps) throw new HttpError(409, `Limite de ${maxApps} sites atingido.`);
      await fsp.rename(tempApp, path.join(appsDir, id));
    });
    json(res, 201, { ...meta, url: appUrl(id) });
  } finally {
    await Promise.allSettled([fsp.rm(tempZip, { force: true }), fsp.rm(tempApp, { recursive: true, force: true })]);
  }
}

async function getApp(id) {
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(appsDir, id, 'meta.json'), 'utf8'));
    return { meta, root: path.resolve(appsDir, id, 'site', meta.root) };
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'Aplicação não encontrada.');
    throw err;
  }
}

async function listApps() {
  const ids = await fsp.readdir(appsDir);
  const apps = await Promise.all(ids.filter(id => /^[a-f0-9]{16}$/.test(id)).map(async id => {
    try { const { meta } = await getApp(id); return { ...meta, url: appUrl(id) }; }
    catch { return null; }
  }));
  return apps.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function atomicWrite(target, body) {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try { await fsp.writeFile(temp, body, { flag: 'wx' }); await fsp.rename(temp, target); }
  finally { await fsp.rm(temp, { force: true }); }
}

async function validateJsonFile(file) {
  try { await verifyFile(file); }
  catch { throw new HttpError(400, 'O conteúdo enviado não é um JSON válido.'); }
}

async function fileEtag(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `"${hash.digest('hex')}"`;
}

async function receiveJsonBody(req, destination) {
  if (Number(req.headers['content-length']) > maxJsonBytes) throw new HttpError(413, `O JSON excede ${maxJsonMb} MB.`);
  let size = 0;
  let exceeded = false;
  const limiter = new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > maxJsonBytes) exceeded = true;
      done(null, exceeded ? undefined : chunk);
    },
  });
  await pipeline(req, limiter, fs.createWriteStream(destination, { flags: 'wx' }));
  if (exceeded) throw new HttpError(413, `O JSON excede ${maxJsonMb} MB.`);
}

async function withDbLock(id, work) {
  const previous = dbLocks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  dbLocks.set(id, current);
  await previous;
  try { return await work(); }
  finally { release(); if (dbLocks.get(id) === current) dbLocks.delete(id); }
}

function parseJson(body) {
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido.'); }
}

async function authRoute(req, res, pathname) {
  if (pathname === '/api/session' && req.method === 'GET') {
    return json(res, 200, { setupRequired: !(await ownerRecord()), authenticated: !!currentSession(req),
      maxJsonMb, maxSqlMb, maxDatabases, maxApps, mysqlAvailable: !!mysqlStore });
  }
  if (pathname === '/api/setup' && req.method === 'POST') {
    if (await ownerRecord()) throw new HttpError(409, 'O proprietário já foi configurado.');
    const { password } = parseJson(await readBody(req, 65536));
    if (typeof password !== 'string' || password.length < 12) throw new HttpError(400, 'Use uma senha com pelo menos 12 caracteres.');
    const salt = randomBytes(16).toString('hex');
    try { await fsp.writeFile(ownerFile, JSON.stringify({ salt, hash: passwordHash(password, salt) }), { flag: 'wx', mode: 0o600 }); }
    catch (err) { if (err.code === 'EEXIST') throw new HttpError(409, 'O proprietário já foi configurado.'); throw err; }
    newSession(res, password, salt);
    return json(res, 201, { ok: true });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const address = req.socket.remoteAddress || 'local';
    const attempts = loginFailures.get(address);
    if (attempts && attempts.count >= 5 && attempts.until > Date.now()) throw new HttpError(429, 'Aguarde antes de tentar novamente.');
    const owner = await ownerRecord();
    if (!owner) throw new HttpError(400, 'Configure o proprietário primeiro.');
    const { password } = parseJson(await readBody(req, 65536));
    const actual = passwordHash(typeof password === 'string' ? password : '', owner.salt);
    if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(owner.hash, 'hex'))) {
      const next = attempts && attempts.until > Date.now() ? attempts.count + 1 : 1;
      loginFailures.set(address, { count: next, until: Date.now() + 15 * 60 * 1000 });
      throw new HttpError(401, 'Senha incorreta.');
    }
    loginFailures.delete(address);
    newSession(res, password, owner.salt);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    sessions.delete(cookie(req, 'ss_session'));
    setSessionCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  throw new HttpError(405, 'Método não permitido.');
}

function publicDatabase(meta) {
  return {
    id: meta.id, name: meta.name, createdAt: meta.createdAt,
    kind: meta.kind || 'json', source: meta.source || 'legacy', summary: meta.summary || null,
    url: databaseUrl(meta.id),
    keys: meta.keys.map(({ id, label, permission, createdAt, sealedToken }) => ({ id, label, permission, createdAt, canReveal: !!sealedToken })),
  };
}

async function getDatabase(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HttpError(404, 'Banco não encontrado.');
  const dir = path.join(databasesDir, id);
  try { return { dir, meta: JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')) }; }
  catch (err) { if (err.code === 'ENOENT') throw new HttpError(404, 'Banco não encontrado.'); throw err; }
}

async function listDatabases() {
  const ids = await fsp.readdir(databasesDir);
  const items = await Promise.all(ids.filter(id => /^[a-f0-9]{16}$/.test(id)).map(async id => {
    try { return publicDatabase((await getDatabase(id)).meta); }
    catch { return null; }
  }));
  return items.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function uploadDatabase(req, res, session) {
  const id = randomBytes(8).toString('hex');
  const tempFile = path.join(tmpDir, `${id}.json`);
  const tempDir = path.join(tmpDir, id);
  try {
    const filename = await receiveFile(req, tempFile, '.json', maxJsonBytes);
    await validateJsonFile(tempFile);
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const keyId = randomBytes(6).toString('hex');
    const meta = { id, name: filename, createdAt: now, keys: [{
      id: keyId, label: 'Chave inicial', permission: 'write',
      hash: hashToken(token), sealedToken: sealToken(token, session.encryptionKey, id, keyId), createdAt: now,
    }] };
    await fsp.mkdir(tempDir);
    await fsp.rename(tempFile, path.join(tempDir, 'data.json'));
    await fsp.writeFile(path.join(tempDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await withDbLock('catalog:databases', async () => {
      if ((await listDatabases()).length >= maxDatabases) throw new HttpError(409, `Limite de ${maxDatabases} bancos atingido.`);
      await fsp.rename(tempDir, path.join(databasesDir, id));
    });
    return json(res, 201, { database: publicDatabase(meta), token });
  } finally {
    await Promise.allSettled([fsp.rm(tempFile, { force: true }), fsp.rm(tempDir, { recursive: true, force: true })]);
  }
}

function requireMysql() {
  if (!mysqlStore) throw new HttpError(503, 'O serviço de dados ainda não está disponível. Inicie o portal com o MySQL.');
  return mysqlStore;
}

function initialDatabaseMeta(id, name, session, source, summary = null) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const keyId = randomBytes(6).toString('hex');
  const meta = { id, name, kind: 'mysql', source, summary, createdAt: now, keys: [{
    id: keyId, label: 'Chave inicial', permission: 'write', hash: hashToken(token),
    sealedToken: sealToken(token, session.encryptionKey, id, keyId), createdAt: now,
  }] };
  return { meta, token };
}

async function createMysqlDatabase(req, res, session, imported) {
  const store = requireMysql();
  const id = randomBytes(8).toString('hex');
  const tempFile = path.join(tmpDir, `${id}.json`);
  const tempDir = path.join(tmpDir, id);
  let committed = false;
  try {
    let name;
    let summary = null;
    if (imported) {
      name = await receiveFile(req, tempFile, '.json', maxJsonBytes);
      await validateJsonFile(tempFile);
      summary = await store.importFile(id, tempFile);
    } else {
      const input = parseJson(await readBody(req, 65536));
      name = input.name;
      if (typeof name !== 'string' || !name.trim() || name.length > 100) {
        throw new HttpError(400, 'Dê um nome de até 100 caracteres para seus dados.');
      }
      name = name.trim();
      summary = { collections: 0, records: 0, rootType: 'object' };
    }
    const { meta, token } = initialDatabaseMeta(id, name, session, imported ? 'imported' : 'empty', summary);
    await fsp.mkdir(tempDir);
    await fsp.writeFile(path.join(tempDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await withDbLock('catalog:databases', async () => {
      if ((await listDatabases()).length >= maxDatabases) throw new HttpError(409, `Limite de ${maxDatabases} bancos atingido.`);
      await fsp.rename(tempDir, path.join(databasesDir, id));
      committed = true;
    });
    return json(res, 201, { database: publicDatabase(meta), token });
  } finally {
    if (!committed) await store.deleteDatabase(id).catch(error => console.error('Falha ao limpar banco incompleto:', error));
    await Promise.allSettled([fsp.rm(tempFile, { force: true }), fsp.rm(tempDir, { recursive: true, force: true })]);
  }
}

async function exportMysqlDatabase(res, meta) {
  const store = requireMysql();
  const groups = await store.collections(meta.id);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${meta.id}.json"`, 'Cache-Control': 'no-store' });
  async function write(chunk) { if (!res.write(chunk)) await once(res, 'drain'); }
  async function writeGroup(group) {
    if (group.kind === 'list') await write('[');
    let cursor = 0;
    let first = true;
    do {
      const page = await store.records(meta.id, group.id, cursor, 100);
      for (const item of page.items) {
        if (!first) await write(',');
        await write(JSON.stringify(item.data));
        first = false;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (group.kind === 'list') await write(']');
    else if (first) await write('null');
  }
  if (meta.summary?.rootType === 'array' || meta.summary?.rootType === 'scalar') {
    if (groups[0]) await writeGroup(groups[0]);
    else await write(meta.summary.rootType === 'array' ? '[]' : 'null');
  } else {
    await write('{');
    for (let i = 0; i < groups.length; i++) {
      if (i) await write(',');
      await write(`${JSON.stringify(groups[i].name)}:`);
      await writeGroup(groups[i]);
    }
    await write('}');
  }
  res.end();
}

async function updateMysqlSchema(req, res, meta) {
  const store = requireMysql();
  const tempFile = path.join(tmpDir, `${meta.id}-${randomBytes(6).toString('hex')}.sql`);
  try {
    const filename = await receiveFile(req, tempFile, '.sql', maxSqlBytes);
    const result = await withDbLock(meta.id, async () => {
      const fresh = (await getDatabase(meta.id)).meta;
      return store.applySqlFile(meta.id, tempFile, filename);
    });
    return json(res, 200, result);
  } finally { await fsp.rm(tempFile, { force: true }); }
}

async function databaseManagement(req, res, pathname, session) {
  if (pathname === '/api/databases' && req.method === 'GET') return json(res, 200, await listDatabases());
  if (pathname === '/api/databases' && req.method === 'POST') return uploadDatabase(req, res, session);
  if (pathname === '/api/databases/import' && req.method === 'POST') return createMysqlDatabase(req, res, session, true);
  if (pathname === '/api/databases/mysql' && req.method === 'POST') return createMysqlDatabase(req, res, session, false);
  const match = /^\/api\/databases\/([a-f0-9]{16})(?:\/(download|structure|sql|keys)(?:\/([a-f0-9]{12})(?:\/(reveal|rotate))?)?)?$/.exec(pathname);
  if (!match) throw new HttpError(404, 'Endereço não encontrado.');
  const [, id, action, keyId, keyAction] = match;
  const { dir, meta } = await getDatabase(id);
  if (action === 'sql' && !keyId && req.method === 'POST') return updateMysqlSchema(req, res, meta);
  if (!action && req.method === 'GET') return json(res, 200, publicDatabase(meta));
  if (!action && req.method === 'DELETE') {
    return withDbLock(id, async () => {
      await getDatabase(id);
      if (meta.kind === 'mysql' || mysqlStore) await requireMysql().deleteDatabase(id);
      await fsp.rm(dir, { recursive: true });
      return json(res, 200, { ok: true });
    });
  }
  if (action === 'structure' && req.method === 'GET') {
    const store = requireMysql();
    return json(res, 200, { ...publicDatabase(meta), collections: await store.collections(id), tables: await store.sqlTables(id) });
  }
  if (action === 'download' && req.method === 'GET') {
    if (meta.kind === 'mysql') return exportMysqlDatabase(res, meta);
    const handle = await fsp.open(path.join(dir, 'data.json'), 'r');
    try {
      const stat = await handle.stat();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.json"`, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      await pipeline(handle.createReadStream({ start: 0, autoClose: false }), res);
    } finally { await handle.close(); }
    return;
  }
  if (action === 'keys' && !keyId && req.method === 'POST') {
    const { label, permission } = parseJson(await readBody(req, 65536));
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || !['read', 'write'].includes(permission)) throw new HttpError(400, 'Informe nome e permissão da chave.');
    return withDbLock(id, async () => {
      const fresh = (await getDatabase(id)).meta;
      const token = randomBytes(32).toString('base64url');
      const keyId = randomBytes(6).toString('hex');
      const key = { id: keyId, label: label.trim(), permission, hash: hashToken(token),
        sealedToken: sealToken(token, session.encryptionKey, id, keyId), createdAt: new Date().toISOString() };
      fresh.keys.push(key);
      await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(fresh, null, 2));
      return json(res, 201, { key: publicDatabase(fresh).keys.at(-1), token });
    });
  }
  if (action === 'keys' && keyId && keyAction === 'reveal' && req.method === 'POST') {
    return withDbLock(id, async () => {
      const key = (await getDatabase(id)).meta.keys.find(item => item.id === keyId);
      if (!key) throw new HttpError(404, 'Chave não encontrada.');
      if (!key.sealedToken) throw new HttpError(409, 'Esta chave antiga não pode ser recuperada. Gere uma nova para este acesso.');
      return json(res, 200, { token: unsealToken(key.sealedToken, session.encryptionKey, id, keyId, key.hash) });
    });
  }
  if (action === 'keys' && keyId && keyAction === 'rotate' && req.method === 'POST') {
    return withDbLock(id, async () => {
      const fresh = (await getDatabase(id)).meta;
      const key = fresh.keys.find(item => item.id === keyId);
      if (!key) throw new HttpError(404, 'Chave não encontrada.');
      const token = randomBytes(32).toString('base64url');
      key.hash = hashToken(token);
      key.sealedToken = sealToken(token, session.encryptionKey, id, keyId);
      key.rotatedAt = new Date().toISOString();
      await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(fresh, null, 2));
      return json(res, 200, { token, key: publicDatabase(fresh).keys.find(item => item.id === keyId) });
    });
  }
  if (action === 'keys' && keyId && !keyAction && req.method === 'DELETE') {
    return withDbLock(id, async () => {
      const fresh = (await getDatabase(id)).meta;
      if (!fresh.keys.some(key => key.id === keyId)) throw new HttpError(404, 'Chave não encontrada.');
      fresh.keys = fresh.keys.filter(key => key.id !== keyId);
      await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(fresh, null, 2));
      return json(res, 200, { ok: true });
    });
  }
  throw new HttpError(405, 'Método não permitido.');
}

async function databaseAccess(req, res, pathname) {
  const match = /^\/api\/db-access\/([a-f0-9]{16})(.*)$/.exec(pathname);
  if (!match) throw new HttpError(404, 'Endereço não encontrado.');
  const cors = dbCors;
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Método não permitido.');
  const [, id, suffix] = match;
  const collectionMatch = /^\/collections(?:\/([a-f0-9]{16})(?:\/records(?:\/([a-f0-9]{16}))?)?)?$/.exec(suffix);
  const [, collectionId, recordId] = collectionMatch || [];
  const tableMatch = /^\/tables(?:\/([A-Za-z][A-Za-z0-9_]{0,39})(?:\/rows(?:\/(\d+))?)?)?$/.exec(suffix);
  const [, tableName, sqlRecordId] = tableMatch || [];
  const { dir, meta } = await getDatabase(id);
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
  const key = bearer && meta.keys.find(item => item.hash === hashToken(bearer[1]));
  if (!key) return json(res, 401, { error: 'Chave de acesso inválida.' }, cors);
  if (req.method !== 'GET' && key.permission !== 'write') return json(res, 403, { error: 'Chave somente de leitura.' }, cors);
  if (meta.kind === 'mysql' || suffix.startsWith('/tables')) {
    const store = requireMysql();
    async function operation() {
      if (suffix === '/tables' && req.method === 'GET') return json(res, 200, { tables: await store.sqlTables(id) }, cors);
      if (tableName && suffix.endsWith('/rows') && req.method === 'GET') {
        const url = new URL(req.url, 'http://internal');
        const cursor = Number(url.searchParams.get('cursor') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new HttpError(400, 'Paginação inválida. Use limit entre 1 e 100.');
        }
        return json(res, 200, await store.sqlRows(id, tableName, cursor, limit), cors);
      }
      if (tableName && suffix.endsWith('/rows') && req.method === 'POST') {
        const body = await readBody(req, 16 * 1024 * 1024);
        return json(res, 201, await store.addSqlRow(id, tableName, parseJson(body)), cors);
      }
      if (tableName && sqlRecordId && req.method === 'GET') {
        const item = await store.sqlRecord(id, tableName, sqlRecordId);
        return json(res, 200, item, { ...cors, ETag: item.etag });
      }
      if (tableName && sqlRecordId && req.method === 'PUT') {
        const item = await store.updateSqlRow(id, tableName, sqlRecordId,
          parseJson(await readBody(req, 16 * 1024 * 1024)), req.headers['if-match']);
        return json(res, 200, item, { ...cors, ETag: item.etag });
      }
      if (tableName && sqlRecordId && req.method === 'DELETE') {
        await store.deleteSqlRow(id, tableName, sqlRecordId, req.headers['if-match']);
        return json(res, 200, { ok: true }, cors);
      }
      if ((suffix === '' || suffix === '/collections') && req.method === 'GET') {
        return json(res, 200, { collections: await store.collections(id) }, cors);
      }
      if (suffix === '/collections' && req.method === 'POST') {
        const { name } = parseJson(await readBody(req, 65536));
        if ((await store.collections(id)).length >= 200) throw new HttpError(409, 'Limite de grupos de dados atingido.');
        const group = await store.addCollection(id, name);
        return json(res, 201, group, cors);
      }
      if (collectionId && !suffix.includes('/records') && req.method === 'GET') {
        return json(res, 200, await store.collection(id, collectionId), cors);
      }
      if (collectionId && suffix.endsWith('/records') && req.method === 'GET') {
        const url = new URL(req.url, 'http://internal');
        const cursor = Number(url.searchParams.get('cursor') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new HttpError(400, 'Paginação inválida. Use limit entre 1 e 100.');
        }
        return json(res, 200, await store.records(id, collectionId, cursor, limit), cors);
      }
      if (collectionId && suffix.endsWith('/records') && req.method === 'POST') {
        const body = await readBody(req, 16 * 1024 * 1024);
        parseJson(body);
        return json(res, 201, await store.addRecord(id, collectionId, body.toString('utf8')), cors);
      }
      if (collectionId && recordId && req.method === 'GET') {
        const item = await store.record(id, collectionId, recordId);
        return json(res, 200, item, { ...cors, ETag: item.etag });
      }
      if (collectionId && recordId && req.method === 'PUT') {
        const body = await readBody(req, 16 * 1024 * 1024);
        parseJson(body);
        const item = await store.updateRecord(id, collectionId, recordId, body.toString('utf8'), req.headers['if-match']);
        return json(res, 200, item, { ...cors, ETag: item.etag });
      }
      if (collectionId && recordId && req.method === 'DELETE') {
        await store.deleteRecord(id, collectionId, recordId, req.headers['if-match']);
        return json(res, 200, { ok: true }, cors);
      }
      throw new HttpError(405, 'Método não permitido.');
    }
    if (req.method === 'GET') return operation();
    return withDbLock(id, async () => {
      const fresh = (await getDatabase(id)).meta;
      if (!fresh.keys.some(item => item.hash === key.hash && item.permission === 'write')) {
        return json(res, 403, { error: 'Chave revogada.' }, cors);
      }
      return operation();
    });
  }
  if (suffix !== '' || req.method === 'POST' || req.method === 'DELETE') throw new HttpError(404, 'Endereço não encontrado.');
  if (req.method === 'GET') {
    const handle = await fsp.open(path.join(dir, 'data.json'), 'r');
    try {
      const stat = await handle.stat();
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      if (res.destroyed) return;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': stat.size,
        ETag: `"${hash.digest('hex')}"`, 'X-Content-Type-Options': 'nosniff' });
      await pipeline(handle.createReadStream({ start: 0, autoClose: false }), res);
    } finally { await handle.close(); }
    return;
  }
  if (!req.headers['if-match']) return json(res, 428, { error: 'Leia o banco antes de salvar e envie If-Match com o ETag recebido.' }, cors);
  const temp = path.join(dir, `data.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await receiveJsonBody(req, temp);
    await validateJsonFile(temp);
    const nextEtag = await fileEtag(temp);
    return await withDbLock(id, async () => {
      const fresh = (await getDatabase(id)).meta;
      if (!fresh.keys.some(item => item.hash === key.hash && item.permission === 'write')) return json(res, 403, { error: 'Chave revogada.' }, cors);
      if (req.headers['if-match'] !== await fileEtag(path.join(dir, 'data.json'))) return json(res, 409, { error: 'O banco mudou. Recarregue os dados antes de salvar.' }, cors);
      await fsp.rename(temp, path.join(dir, 'data.json'));
      return json(res, 200, { ok: true }, { ...cors, ETag: nextEtag });
    });
  } finally { await fsp.rm(temp, { force: true }); }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, `O conteúdo excede ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveFile(req, res, root, pathname, portal = false) {
  let target = safePath(root, pathname);
  let stat;
  try { stat = await fsp.stat(target); }
  catch (err) { if (err.code === 'ENOENT') throw new HttpError(404, 'Arquivo não encontrado.'); throw err; }
  if (stat.isDirectory()) {
    target = path.join(target, 'index.html');
    try { stat = await fsp.stat(target); }
    catch (err) { if (err.code === 'ENOENT') throw new HttpError(404, 'Página não encontrada.'); throw err; }
  }
  if (!stat.isFile()) throw new HttpError(404, 'Arquivo não encontrado.');
  const headers = {
    'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  if (portal) {
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    headers['Referrer-Policy'] = 'no-referrer';
  }
  let start = 0;
  let end = stat.size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match) throw new HttpError(416, 'Intervalo inválido.');
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) { start = Math.max(0, stat.size - Number(match[2])); end = stat.size - 1; }
    if (start > end || end >= stat.size) throw new HttpError(416, 'Intervalo inválido.');
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(req.headers.range ? 206 : 200, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  fs.createReadStream(target, { start, end }).pipe(res);
}

function blocksLegacyDatabase(pathname) {
  return pathname.split('/').some(segment => {
    try { return decodeURIComponent(segment).toLowerCase() === 'db_global'; }
    catch { return false; }
  });
}

async function serveUploadedApp(req, res, id, rootPath, base = '') {
  const { meta, root } = await getApp(id);
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
  if (rootPath === '/') {
    res.writeHead(302, { Location: `${base}/${meta.entry.split('/').map(encodeURIComponent).join('/')}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (blocksLegacyDatabase(rootPath)) throw new HttpError(403, 'Bancos devem ser acessados pela API autenticada.');
  return serveFile(req, res, root, rootPath);
}

async function handler(req, res, listener = 'portal') {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const pathname = new URL(req.url, 'http://internal').pathname;
  if (listener === 'apps') {
    if (!lanMode || ![publicHost, domain, '127.0.0.1'].includes(host)) throw new HttpError(404, 'Endereço não encontrado.');
    const match = /^\/apps\/([a-f0-9]{16})(\/.*)?$/.exec(pathname);
    if (!match) throw new HttpError(404, 'Aplicação não encontrada.');
    const [, id, rest] = match;
    if (!rest) {
      res.writeHead(302, { Location: `/apps/${id}/`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return serveUploadedApp(req, res, id, rest, `/apps/${id}`);
  }
  if (host === domain || host === publicHost || host === '127.0.0.1') {
    if (pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (pathname.startsWith('/api/db-access/')) return databaseAccess(req, res, pathname);
    if (['/api/session', '/api/setup', '/api/login', '/api/logout'].includes(pathname)) {
      if (req.method !== 'GET') checkOrigin(req, host);
      return authRoute(req, res, pathname);
    }
    if (pathname.startsWith('/api/databases')) {
      const session = requireOwner(req);
      if (req.method !== 'GET') checkOrigin(req, host);
      return databaseManagement(req, res, pathname, session);
    }
    if (pathname === '/api/apps') {
      requireOwner(req);
      if (req.method === 'GET') return json(res, 200, await listApps());
      if (req.method === 'POST') { checkOrigin(req, host); return upload(req, res); }
      throw new HttpError(405, 'Método não permitido.');
    }
    const appManagement = /^\/api\/apps\/([a-f0-9]{16})$/.exec(pathname);
    if (appManagement) {
      requireOwner(req);
      if (req.method !== 'DELETE') throw new HttpError(405, 'Método não permitido.');
      checkOrigin(req, host);
      return withDbLock('catalog:apps', async () => {
        await getApp(appManagement[1]);
        await fsp.rm(path.join(appsDir, appManagement[1]), { recursive: true });
        return json(res, 200, { ok: true });
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
    return serveFile(req, res, portalDir, pathname, true);
  }
  const suffix = `.${domain}`;
  const id = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HttpError(404, 'Endereço não encontrado.');
  return serveUploadedApp(req, res, id, pathname);
}

await Promise.all([fsp.mkdir(appsDir, { recursive: true }), fsp.mkdir(databasesDir, { recursive: true }), fsp.mkdir(tmpDir, { recursive: true })]);
if (mysqlStore) await mysqlStore.ready();
function serverFor(listener) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res, listener)).catch(err => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Erro interno.' : err.message },
      listener === 'portal' && req.url?.startsWith('/api/db-access/') ? dbCors : {});
    else res.destroy();
    });
  });
  server.requestTimeout = 30 * 60 * 1000;
  return server;
}
serverFor('portal').listen(port, '0.0.0.0', () => console.log(`Portal em ${portalOrigin()}`));
if (lanMode) serverFor('apps').listen(appPort, '0.0.0.0', () => console.log(`Aplicações em ${scheme}://${publicHost}:${publicAppPort}`));
