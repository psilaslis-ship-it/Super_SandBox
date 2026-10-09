const $ = selector => document.querySelector(selector);
const authPanel = $('#auth-panel');
const dashboard = $('#dashboard');
const authForm = $('#auth-form');
const databaseList = $('#database-list');
const appsList = $('#apps-list');
const promptSelect = $('#prompt-database');
const promptBox = $('#ai-prompt');
const keyDialog = $('#key-dialog');
let setupRequired = false;
let databases = [];
let publishedApps = 0;
let portalLimits = { maxDatabases: 20, maxApps: 20, mysqlAvailable: false };
let promptRequest = 0;
let visibleSecretDatabaseId = null;
let visibleSecretKeyId = null;
const copyLabels = new WeakMap();
const copyTimers = new WeakMap();

function updateQuotaButtons(appCount) {
  $('#database-form button[type=submit]').disabled = databases.length >= portalLimits.maxDatabases || !portalLimits.mysqlAvailable;
  $('#empty-database-form button[type=submit]').disabled = databases.length >= portalLimits.maxDatabases || !portalLimits.mysqlAvailable;
  if (appCount !== undefined) $('#upload-form button[type=submit]').disabled = appCount >= portalLimits.maxApps;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Não foi possível concluir a operação.');
  return payload;
}

function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setBusy(button, status, message, form) {
  button.disabled = true;
  button.classList.add('is-busy');
  if (form) {
    form.setAttribute('aria-busy', 'true');
    const fileInput = form.querySelector('input[type=file]');
    if (fileInput) fileInput.disabled = true;
  }
  if (status) {
    status.textContent = message;
    status.classList.add('is-busy');
  }
}

function clearBusy(button, status, form) {
  button.disabled = false;
  button.classList.remove('is-busy');
  if (form) {
    form.removeAttribute('aria-busy');
    const fileInput = form.querySelector('input[type=file]');
    if (fileInput) fileInput.disabled = false;
  }
  if (status) status.classList.remove('is-busy');
}

function showListLoading(list, message) {
  list.textContent = message;
  list.classList.add('is-loading');
}

function copyWithSelection(value) {
  const field = document.createElement('textarea');
  const previousFocus = document.activeElement;
  field.value = value;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(field);
  field.focus();
  field.select();
  try { return document.execCommand('copy'); }
  finally {
    field.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}

function copyFeedback(button, message) {
  if (!copyLabels.has(button)) copyLabels.set(button, button.textContent);
  clearTimeout(copyTimers.get(button));
  button.textContent = message;
  copyTimers.set(button, setTimeout(() => { button.textContent = copyLabels.get(button); }, 2500));
}

async function copy(value, button, source) {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); copied = true; }
    catch { /* Tenta a cópia por seleção em páginas HTTP da rede local. */ }
  }
  if (!copied) {
    try { copied = copyWithSelection(value); }
    catch { /* O navegador bloqueou também a alternativa. */ }
  }
  if (copied) return copyFeedback(button, 'Copiado!');
  if (source) {
    if (source.select) source.select();
    else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  copyFeedback(button, 'Use Ctrl+C');
}

function showSecret(token, title, databaseId, keyId) {
  $('#secret-title').textContent = title;
  $('#secret-token').textContent = token;
  visibleSecretDatabaseId = databaseId;
  visibleSecretKeyId = keyId;
  $('#secret-result').hidden = false;
  $('#secret-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideSecretForDatabase(databaseId, keyId) {
  if (visibleSecretDatabaseId !== databaseId || (keyId && visibleSecretKeyId !== keyId)) return;
  $('#secret-result').hidden = true;
  $('#secret-token').textContent = '';
  visibleSecretDatabaseId = null;
  visibleSecretKeyId = null;
}
function showKeyDialog(token, title, description) {
  $('#key-dialog-title').textContent = title;
  $('#key-dialog-description').textContent = description;
  $('#key-dialog-token').textContent = token;
  keyDialog.showModal();
}
$('#copy-token').addEventListener('click', () => copy($('#secret-token').textContent, $('#copy-token'), $('#secret-token')));
$('#key-dialog-copy').addEventListener('click', () => copy($('#key-dialog-token').textContent, $('#key-dialog-copy'), $('#key-dialog-token')));
$('#key-dialog-close').addEventListener('click', () => keyDialog.close());
keyDialog.addEventListener('cancel', event => event.preventDefault());
keyDialog.addEventListener('close', () => {
  $('#key-dialog-token').textContent = '';
  const button = $('#key-dialog-copy');
  clearTimeout(copyTimers.get(button));
  button.textContent = 'Copiar chave';
});
$('#copy-result').addEventListener('click', () => copy($('#result-url').href, $('#copy-result'), $('#result-url')));
$('#copy-prompt').addEventListener('click', () => copy(promptBox.value, $('#copy-prompt'), promptBox));
$('#download-prompt').addEventListener('click', () => {
  if (!promptBox.value) return;
  const blob = new Blob([`# Instruções para adaptar o site\n\n${promptBox.value}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `instrucoes-${promptSelect.value}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function showAuth(setup) {
  $('#startup-loading').hidden = true;
  setupRequired = setup;
  authPanel.hidden = false;
  dashboard.hidden = true;
  $('#logout').hidden = true;
  $('#auth-title').textContent = setup ? 'Criar acesso' : 'Entrar';
  $('#auth-description').textContent = setup
    ? 'Crie uma senha de proprietário para proteger os bancos e gerenciar quem recebe chaves de acesso.'
    : 'Entre para gerenciar bancos de dados e aplicações.';
  $('#auth-button').textContent = setup ? 'Criar acesso' : 'Entrar';
  $('#password').autocomplete = setup ? 'new-password' : 'current-password';
  $('#confirm-label').hidden = !setup;
  $('#confirm-password').hidden = !setup;
  $('#confirm-password').required = setup;
  $('#auth-status').textContent = '';
}

async function showDashboard() {
  $('#startup-loading').hidden = true;
  authPanel.hidden = true;
  dashboard.hidden = false;
  $('#logout').hidden = false;
  await Promise.all([loadDatabases(), loadApps()]);
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('#password').value;
  if (setupRequired && password !== $('#confirm-password').value) {
    $('#auth-status').textContent = 'As senhas não coincidem.';
    return;
  }
  const button = $('#auth-button');
  const status = $('#auth-status');
  setBusy(button, status, setupRequired ? 'Criando acesso…' : 'Entrando…', authForm);
  try {
    await api(setupRequired ? '/api/setup' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    authForm.reset();
    await showDashboard();
  } catch (error) { status.textContent = error.message; }
  finally { clearBusy(button, status, authForm); }
});

$('#logout').addEventListener('click', async () => {
  const button = $('#logout');
  setBusy(button);
  try {
    await api('/api/logout', { method: 'POST' });
    $('#secret-result').hidden = true;
    $('#secret-token').textContent = '';
    visibleSecretDatabaseId = null;
    visibleSecretKeyId = null;
    showAuth(false);
  } catch (error) { alert(error.message); }
  finally { clearBusy(button); }
});

function promptFor(db) {
  return `Adapte esta aplicação HTML/CSS/JavaScript para usar um banco JSON acessível por API HTTP, mantendo sua interface, regras de negócio e estrutura do JSON.

Endereço público do banco: ${db.url}
Identificador do banco: ${db.id}

Requisitos:
- A aplicação deve funcionar aberta localmente (inclusive por file:// ou por um servidor local) e depois de publicada em outra origem, usando o mesmo endereço de API.
- O identificador e o endereço podem ficar no código. A chave privada de acesso NÃO pode ficar no código, no ZIP, em arquivos de configuração distribuídos nem na URL. Peça ao usuário a chave quando for acessar o banco e mantenha-a apenas em memória durante a sessão.
- Para ler, faça GET no endereço acima com Authorization: Bearer <chave>. A resposta é o JSON atual e traz um cabeçalho ETag.
- Para salvar, faça PUT no mesmo endereço com Authorization: Bearer <chave>, Content-Type: application/json e If-Match: <ETag da última leitura>. Envie o JSON completo diretamente no corpo. Depois de salvar, atualize o ETag com o valor recebido na resposta.
- Se o PUT retornar 409, mostre conflito de edição e ofereça recarregar os dados; não sobrescreva silenciosamente. Se retornar 401/403, peça uma chave válida ou informe que ela não tem permissão de gravação.
- Mostre sucesso somente após a gravação confirmada pela API. Trate falhas de rede e preserve as alterações ainda não salvas na tela.
- Substitua o antigo seletor de arquivo/pasta local por uma ação “Conectar ao banco” que peça a chave ao usuário. Não tente escolher uma pasta do contêiner pelo seletor nativo de arquivos.
- Não inclua o arquivo JSON no ZIP da aplicação. Inclua localmente todos os outros recursos usados pelo site; não dependa de CDN ou serviços externos.
- Use caminhos relativos para HTML, JavaScript, CSS, imagens e navegação interna. O site pode ser publicado sob um prefixo de URL; não use caminhos de recurso começando por /.

Implemente as mudanças no projeto, teste leitura, gravação, chave inválida e conflito de edição. Ao final, entregue um ZIP com o site pronto para publicação e liste os arquivos alterados.`;
}

function mysqlPrompt(db, structure, mode = 'app') {
  const groups = structure.collections.map(group => `- ${JSON.stringify(group.name)}: ${group.kind === 'list' ? 'lista' : 'valor único'}, ${group.count} item(ns)`).join('\n');
  const tables = structure.tables.map(table => `- ${table.name}: ${table.count} registro(s); ${table.columns.map(column => `${column.name} ${column.columnType}`).join(', ')}`).join('\n');
  const imported = db.source === 'imported';
  const legacyJson = db.kind !== 'mysql';
  if (mode === 'schema') {
    return `Crie um arquivo SQL para ${tables ? 'atualizar a estrutura existente' : 'criar a estrutura inicial'} deste banco, preservando todos os registros atuais. O arquivo será aplicado por uma ferramenta que isola cada banco.

Endereço de referência: ${db.url}
Grupos de dados existentes: ${groups || '- Nenhum grupo.'}
Tabelas e colunas atuais: ${tables || '- Ainda não existem tabelas personalizadas.'}

Entregue um arquivo chamado ${tables ? 'atualizacao.sql' : 'estrutura.sql'} contendo apenas comandos compatíveis com MySQL para criação de tabelas e alterações estruturais seguras. Use nomes lógicos simples para tabelas e colunas (letras, números e _; nome de tabela com até 40 caracteres). Tipos aceitos: VARCHAR, CHAR, TINYINT, SMALLINT, MEDIUMINT, INT, BIGINT, DECIMAL, FLOAT, DOUBLE, BOOLEAN, DATE, DATETIME, TIMESTAMP, TIME, YEAR, TEXT, MEDIUMTEXT, LONGTEXT, JSON e BLOB.

Regras para preservar os dados:
- ${legacyJson ? 'Este banco começou como JSON. As tabelas SQL serão adicionais; mantenha os grupos e registros JSON existentes intactos e não tente convertê-los automaticamente.' : 'Mantenha as tabelas e registros existentes intactos.'}
- Não use DROP TABLE, DROP COLUMN, TRUNCATE, DELETE, UPDATE de dados, USE, CREATE DATABASE, usuários, permissões, procedures, triggers ou comandos fora da estrutura das tabelas.
- Em tabelas existentes, faça alterações aditivas: ADD COLUMN, ADD INDEX/UNIQUE INDEX, RENAME COLUMN ou DROP INDEX. Ao adicionar coluna NOT NULL, informe DEFAULT para que os registros existentes continuem válidos.
- Não altere o tipo de uma coluna existente nem remova colunas. Se uma mudança exigir conversão de dados, explique a migração separadamente em vez de incluir um comando que possa truncar ou descartar valores.
- Não declare PRIMARY KEY nem AUTO_INCREMENT: o serviço acrescenta um identificador interno a cada registro. Uma coluna de negócio chamada id pode ser criada normalmente.
- Não use nomes de tabelas prefixados com o identificador do banco; o portal aplica o isolamento automaticamente.
- Inclua comentários curtos no SQL para explicar cada alteração. Não inclua instruções de execução fora do arquivo.

Confira que o SQL contém apenas estrutura, sem dados de acesso ou chaves. Preserve as tabelas e os campos que já existem. Retorne o arquivo ${tables ? 'atualizacao.sql' : 'estrutura.sql'} e um resumo das mudanças.`;
  }

  if (!imported && structure.tables.length === 0) {
    return `Adapte esta aplicação HTML/CSS/JavaScript mantendo sua arquitetura, telas, navegação, formato dos objetos e regras de negócio. Altere somente o acesso aos dados e o fluxo de conexão.

Antes de concluir, crie um arquivo estrutura.sql com as tabelas e colunas necessárias para a aplicação. Use nomes simples de tabela e coluna. Não inclua PRIMARY KEY, AUTO_INCREMENT, DROP, DELETE, TRUNCATE, usuários, permissões ou comandos de conexão; o serviço adiciona IDs internos e aplica o SQL isolado para este banco. Para novas colunas obrigatórias, defina DEFAULT.

Endereço da API: ${db.url}
O usuário aplicará estrutura.sql na área de atualização deste banco antes de usar as tabelas.

Para acessar os dados, todas as requisições usam Authorization: Bearer <chave>. Solicite a chave na tela de conexão e mantenha-a apenas em memória. Nunca a inclua no código, ZIP, URL ou armazenamento local.

API de tabelas:
- GET ${db.url}/tables lista tabelas e colunas.
- GET ${db.url}/tables/<tabela>/rows?limit=100&cursor=<cursor> lista registros paginados; cada item contém id, data e etag.
- POST ${db.url}/tables/<tabela>/rows cria um registro JSON.
- PUT ${db.url}/tables/<tabela>/rows/<id> altera o registro usando If-Match: <etag anterior>.
- DELETE ${db.url}/tables/<tabela>/rows/<id> apaga um registro usando If-Match.

Trate 409 como conflito e recarregue antes de salvar novamente. Trate 401/403 solicitando uma chave válida ou informando a permissão. Mostre sucesso apenas após confirmação da API. Preserve as alterações locais quando a rede falhar.

O site deve funcionar aberto localmente (inclusive file://) e depois de publicado. Use caminhos relativos para recursos. Não inclua o JSON original, arquivos SQL nem a chave no ZIP. Inclua os demais recursos localmente e evite dependências externas.

Implemente e teste a aplicação usando a API documentada. Descreva os arquivos alterados e entregue um ZIP pronto para publicação, junto com estrutura.sql.`;
  }

  return `Adapte esta aplicação HTML/CSS/JavaScript para usar os dados deste banco MySQL por meio da API HTTP. Preserve as telas, regras de negócio, fluxo e formato atual dos dados. Altere apenas a camada que lê e salva.

Endereço da API: ${db.url}
Origem dos dados: ${imported ? 'JSON importado, organizado em grupos' : 'banco com estrutura SQL'}.
Formato original da raiz: ${db.summary?.rootType || 'object'}.
Grupos existentes:
${groups || '- Nenhum grupo.'}
Tabelas personalizadas:
${tables || '- Nenhuma.'}

${imported ? `Continue usando as coleções já importadas: GET ${db.url}/collections e GET/POST/PUT/DELETE em /collections/<id>/records. Reconstrua a estrutura do JSON original em memória e mantenha IDs e ETags para alterar somente itens modificados. Não mova nem descarte os dados importados.` : `Use as tabelas SQL existentes pela API: GET ${db.url}/tables; GET ${db.url}/tables/<tabela>/rows?limit=100&cursor=<cursor>; POST na mesma rota para criar; PUT ou DELETE em /rows/<id> com If-Match: <etag>.`}

Todas as requisições enviam Authorization: Bearer <chave>. Peça a chave ao usuário no momento de conectar e mantenha-a apenas em memória. Nunca grave a chave no código, ZIP, URL ou armazenamento local. Em 409 recarregue e apresente o conflito; em 401/403 solicite uma chave com permissão adequada. Preserve alterações não salvas se a rede falhar.

Gere um arquivo estrutura.sql que descreva a estrutura atual. Se a aplicação precisar de novas tabelas ou colunas, inclua no final uma seção separada chamada “Migração estrutural sugerida” com comandos aditivos que preservem os dados. Não inclua comandos destrutivos. O arquivo poderá ser enviado na opção de atualização do banco.

Mantenha a aplicação funcionando localmente (inclusive file://) e publicada, usando o mesmo endereço. Use caminhos relativos, não inclua JSON nem chave no ZIP e evite recursos externos. Implemente, teste e entregue um ZIP pronto para publicação junto com estrutura.sql.`;
}

async function updatePrompt() {
  const request = ++promptRequest;
  const db = databases.find(item => item.id === promptSelect.value);
  promptBox.value = '';
  $('#copy-prompt').disabled = true;
  $('#download-prompt').disabled = true;
  if (!db) return;
  if (db.kind === 'mysql' || $('#prompt-mode').value === 'schema') {
    promptBox.value = 'Preparando instruções…';
    try {
      const structure = await api(`/api/databases/${db.id}/structure`);
      if (request !== promptRequest) return;
      promptBox.value = mysqlPrompt(db, structure, $('#prompt-mode').value);
    } catch (error) { if (request === promptRequest) promptBox.value = error.message; return; }
  } else promptBox.value = promptFor(db);
  $('#copy-prompt').disabled = false;
  $('#download-prompt').disabled = false;
}
promptSelect.addEventListener('change', updatePrompt);
$('#prompt-mode').addEventListener('change', updatePrompt);

async function loadDatabases() {
  showListLoading(databaseList, 'Carregando bancos…');
  try {
    databases = await api('/api/databases');
    $('#database-count').textContent = `${databases.length} de ${portalLimits.maxDatabases} disponíveis`;
    updateQuotaButtons();
    const selected = promptSelect.value;
    promptSelect.replaceChildren(new Option('Selecione um banco', ''));
    for (const db of databases) promptSelect.add(new Option(db.name, db.id));
    promptSelect.value = databases.some(db => db.id === selected) ? selected : '';
    $('#prompt-mode').disabled = !promptSelect.value || !portalLimits.mysqlAvailable;
    if ($('#prompt-mode').disabled) $('#prompt-mode').value = 'app';
    updatePrompt();
    databaseList.replaceChildren();
    if (!databases.length) { databaseList.append(textNode('p', 'Nenhum banco cadastrado ainda.', 'empty')); return; }
    for (const db of databases) databaseList.append(renderDatabase(db));
  } catch (error) { databaseList.textContent = error.message; }
  finally { databaseList.classList.remove('is-loading'); }
}

function renderDatabase(db) {
  const record = textNode('article', '', 'record');
  const head = textNode('div', '', 'record-head');
  const info = document.createElement('div');
  info.append(textNode('strong', db.name), textNode('small', `${db.kind === 'mysql' ? (db.source === 'imported' ? 'Dados importados' : 'Espaço novo') : 'Arquivo JSON'} · ${new Date(db.createdAt).toLocaleString('pt-BR')}`));
  const actions = textNode('div', '', 'record-actions');
  const endpoint = textNode('p', db.url, 'endpoint');
  const copyButton = textNode('button', 'Copiar endereço');
  copyButton.type = 'button'; copyButton.addEventListener('click', () => copy(db.url, copyButton, endpoint));
  const download = textNode('a', 'Baixar JSON');
  download.href = `/api/databases/${db.id}/download`;
  const remove = textNode('button', 'Apagar banco', 'danger-button');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!confirm(`Apagar os dados "${db.name}"? Todos os registros e chaves serão excluídos. Sites que usam estes dados perderão o acesso. Esta ação não pode ser desfeita.`)) return;
    setBusy(remove);
    try {
      await api(`/api/databases/${db.id}`, { method: 'DELETE' });
      hideSecretForDatabase(db.id);
      await loadDatabases();
      $('#database-status').textContent = `Banco ${db.name} apagado.`;
    } catch (error) { alert(error.message); }
    finally { clearBusy(remove); }
  });
  actions.append(copyButton, download, remove); head.append(info, actions);
  let sqlSection = null;
  if (db.kind === 'mysql' || portalLimits.mysqlAvailable) {
    sqlSection = textNode('details', '', 'sql-update');
    const summary = textNode('summary', 'Atualizar estrutura com arquivo .sql');
    const description = textNode('p', 'Envie uma atualização gerada pelo seu assistente de IA. O portal aplica alterações estruturais e preserva os registros.');
    const sqlForm = textNode('form', '', 'sql-form');
    const fileInput = document.createElement('input');
    fileInput.id = `sql-file-${db.id}`; fileInput.type = 'file'; fileInput.accept = '.sql,text/plain'; fileInput.required = true;
    fileInput.hidden = true;
    const drop = textNode('label', '', 'file-drop');
    drop.htmlFor = fileInput.id;
    const icon = textNode('span', '↑', 'upload-icon'); icon.setAttribute('aria-hidden', 'true');
    const fileLabel = textNode('strong', 'Clique ou arraste um arquivo .sql aqui');
    const fileLimit = textNode('small', `Até ${portalLimits.maxSqlMb || 5} MB`);
    drop.append(icon, fileLabel, fileLimit);
    drop.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); drop.classList.add('is-dragover'); } });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop.addEventListener('drop', event => {
      event.preventDefault(); drop.classList.remove('is-dragover');
      if (sqlForm.getAttribute('aria-busy') === 'true' || event.dataTransfer.files.length !== 1) return;
      fileInput.files = event.dataTransfer.files;
      fileLabel.textContent = fileInput.files[0].name;
      sqlStatus.textContent = 'Arquivo pronto para aplicar.';
    });
    fileInput.addEventListener('change', () => {
      fileLabel.textContent = fileInput.files[0]?.name || 'Clique ou arraste um arquivo .sql aqui';
    });
    const submit = textNode('button', 'Aplicar atualização'); submit.type = 'submit';
    const sqlStatus = textNode('span', 'Somente alterações de estrutura são aceitas.', 'status');
    const sqlBottom = textNode('div', '', 'form-bottom'); sqlBottom.append(sqlStatus, submit);
    sqlForm.append(drop, fileInput, sqlBottom);
    sqlForm.addEventListener('submit', async event => {
      event.preventDefault();
      const file = fileInput.files[0]; if (!file) return;
      if (!file.name.toLowerCase().endsWith('.sql')) { sqlStatus.textContent = 'Selecione um arquivo .sql.'; return; }
      if (!confirm(`Aplicar a atualização "${file.name}" em "${db.name}"? O portal aceita apenas alterações estruturais sem comandos para apagar dados.`)) return;
      setBusy(submit, sqlStatus, 'Aplicando a atualização…', sqlForm);
      try {
        const formData = new FormData(); formData.append('file', file);
        const result = await api(`/api/databases/${db.id}/sql`, { method: 'POST', body: formData });
        sqlStatus.textContent = `Atualização concluída: ${result.applied} alteração(ões) aplicada(s), ${result.skipped} já existente(s).`;
        await loadDatabases();
        if (promptSelect.value === db.id) updatePrompt();
      } catch (error) { sqlStatus.textContent = error.message; }
      finally { clearBusy(submit, sqlStatus, sqlForm); }
    });
    sqlSection.append(summary, description, sqlForm);
  }
  const keySection = textNode('div', '', 'key-section');
  keySection.append(textNode('h4', 'Chaves de acesso'));
  const form = textNode('form', '', 'key-form');
  const label = document.createElement('input'); label.placeholder = 'Nome da pessoa ou dispositivo'; label.required = true; label.maxLength = 80;
  const permission = document.createElement('select');
  permission.add(new Option('Leitura e gravação', 'write'));
  permission.add(new Option('Somente leitura', 'read'));
  const create = textNode('button', 'Criar chave'); create.type = 'submit';
  form.append(label, permission, create);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(create);
    create.setAttribute('aria-label', 'Criando chave');
    try {
      const payload = await api(`/api/databases/${db.id}/keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.value, permission: permission.value }),
      });
      await loadDatabases();
      showKeyDialog(payload.token, `Chave criada para ${payload.key.label}`,
        'Copie e guarde esta chave. Você poderá consultá-la novamente após entrar no portal.');
    } catch (error) { alert(error.message); }
    finally { clearBusy(create); create.removeAttribute('aria-label'); }
  });
  const keys = textNode('div', '', 'key-list');
  for (const key of db.keys) {
    const row = textNode('div', '', 'key-item');
    row.append(textNode('span', `${key.label} · ${key.permission === 'write' ? 'leitura e gravação' : 'somente leitura'}`));
    const keyActions = textNode('div', '', 'key-actions');
    const reveal = textNode('button', key.canReveal ? 'Ver chave' : 'Gerar nova chave');
    reveal.type = 'button';
    reveal.addEventListener('click', async () => {
      if (!key.canReveal && !confirm(`A chave antiga de ${key.label} não pode ser recuperada. Gerar uma nova vai invalidar a anterior. Aplicações que usam essa chave precisarão ser atualizadas. Continuar?`)) return;
      setBusy(reveal);
      try {
        const action = key.canReveal ? 'reveal' : 'rotate';
        const payload = await api(`/api/databases/${db.id}/keys/${key.id}/${action}`, { method: 'POST' });
        if (!key.canReveal) {
          hideSecretForDatabase(db.id, key.id);
          await loadDatabases();
        }
        showKeyDialog(payload.token,
          key.canReveal ? `Chave de ${key.label}` : `Nova chave para ${key.label}`,
          key.canReveal
            ? 'Copie esta chave. Ela também poderá ser consultada novamente após entrar no portal.'
            : 'A chave anterior deixou de funcionar. Atualize os acessos que usavam a chave antiga.');
      } catch (error) { alert(error.message); }
      finally { clearBusy(reveal); }
    });
    const revoke = textNode('button', 'Revogar'); revoke.type = 'button';
    revoke.addEventListener('click', async () => {
      if (!confirm(`Revogar a chave de ${key.label}? O acesso será interrompido.`)) return;
      setBusy(revoke);
      try {
        await api(`/api/databases/${db.id}/keys/${key.id}`, { method: 'DELETE' });
        hideSecretForDatabase(db.id, key.id);
        await loadDatabases();
      }
      catch (error) { alert(error.message); }
      finally { clearBusy(revoke); }
    });
    keyActions.append(reveal, revoke);
    row.append(keyActions); keys.append(row);
  }
  keySection.append(form, keys);
  record.append(head, endpoint);
  if (sqlSection) record.append(sqlSection);
  record.append(keySection);
  return record;
}

async function loadApps() {
  showListLoading(appsList, 'Carregando aplicações…');
  try {
    const apps = await api('/api/apps');
    publishedApps = apps.length;
    $('#apps-count').textContent = `${apps.length} de ${portalLimits.maxApps} disponíveis`;
    updateQuotaButtons(apps.length);
    appsList.replaceChildren();
    if (!apps.length) { appsList.append(textNode('p', 'Nenhuma aplicação publicada ainda.', 'empty')); return; }
    for (const app of apps) {
      const record = textNode('article', '', 'record');
      const head = textNode('div', '', 'record-head');
      const info = document.createElement('div');
      info.append(textNode('strong', app.name), textNode('small', new Date(app.createdAt).toLocaleString('pt-BR')));
      const actions = textNode('div', '', 'record-actions');
      const copyButton = textNode('button', 'Copiar URL'); copyButton.type = 'button';
      copyButton.addEventListener('click', () => copy(app.url, copyButton));
      const open = textNode('a', 'Abrir'); open.href = app.url; open.target = '_blank'; open.rel = 'noopener';
      const remove = textNode('button', 'Apagar site', 'danger-button'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm(`Apagar o site "${app.name}"? O link deixará de funcionar. Esta ação não pode ser desfeita.`)) return;
        setBusy(remove);
        try { await api(`/api/apps/${app.id}`, { method: 'DELETE' }); await loadApps(); }
        catch (error) { alert(error.message); }
        finally { clearBusy(remove); }
      });
      actions.append(copyButton, open, remove); head.append(info, actions); record.append(head);
      appsList.append(record);
    }
  } catch (error) { appsList.textContent = error.message; }
  finally { appsList.classList.remove('is-loading'); }
}

for (const [input, label, status, extension, empty] of [
  [$('#database-file'), $('#database-file-label'), $('#database-status'), '.json', 'Clique ou arraste seu arquivo JSON aqui'],
  [$('#zip-file'), $('#zip-file-label'), $('#upload-status'), '.zip', 'Clique ou arraste seu site em ZIP aqui'],
]) {
  const dropzone = input.previousElementSibling;
  const initialStatus = status.textContent;
  let dragDepth = 0;

  function updateSelection() {
    const file = input.files[0];
    if (file && !file.name.toLowerCase().endsWith(extension)) {
      input.value = '';
      label.textContent = empty;
      status.textContent = `Selecione um arquivo ${extension.toUpperCase()}.`;
      return;
    }
    label.textContent = file?.name || empty;
    status.textContent = file ? `${file.name} pronto para envio.` : initialStatus;
  }

  input.addEventListener('change', updateSelection);
  dropzone.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropzone.classList.remove('is-dragover');
  });
  dropzone.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragover');
    if (input.closest('form').getAttribute('aria-busy') === 'true') return;
    if (event.dataTransfer.files.length !== 1) {
      input.value = '';
      label.textContent = empty;
      status.textContent = 'Arraste apenas um arquivo por vez.';
      return;
    }
    input.files = event.dataTransfer.files;
    updateSelection();
  });
}

for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
});

function chooseDataPath(path) {
  const importing = path === 'import';
  $('#database-form').hidden = !importing;
  $('#empty-database-form').hidden = importing;
  $('#choice-import').classList.toggle('is-selected', importing);
  $('#choice-empty').classList.toggle('is-selected', !importing);
  $('#choice-import').setAttribute('aria-pressed', String(importing));
  $('#choice-empty').setAttribute('aria-pressed', String(!importing));
}
$('#choice-import').addEventListener('click', () => chooseDataPath('import'));
$('#choice-empty').addEventListener('click', () => chooseDataPath('empty'));

$('#database-form').addEventListener('submit', async event => {
  event.preventDefault();
  const uploadForm = event.currentTarget;
  const file = $('#database-file').files[0]; if (!file) return;
  const button = uploadForm.querySelector('button[type=submit]');
  const status = $('#database-status');
  setBusy(button, status, 'Enviando e organizando seus dados… Isso pode levar alguns minutos.', uploadForm);
  try {
    const form = new FormData(); form.append('file', file);
    const payload = await api('/api/databases/import', { method: 'POST', body: form });
    status.textContent = 'Dados importados com sucesso.';
    showSecret(payload.token, `Chave inicial de ${payload.database.name}`, payload.database.id, payload.database.keys[0].id);
    uploadForm.reset(); $('#database-file-label').textContent = 'Clique ou arraste seu arquivo JSON aqui';
    await loadDatabases();
    promptSelect.value = payload.database.id; updatePrompt();
  } catch (error) { status.textContent = error.message; }
  finally { clearBusy(button, status, uploadForm); updateQuotaButtons(); }
});

$('#empty-database-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  const status = $('#empty-database-status');
  setBusy(button, status, 'Criando seu espaço de dados…', form);
  try {
    const payload = await api('/api/databases/mysql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#empty-database-name').value }),
    });
    status.textContent = 'Espaço criado com sucesso.';
    showSecret(payload.token, `Chave inicial de ${payload.database.name}`, payload.database.id, payload.database.keys[0].id);
    form.reset();
    await loadDatabases();
    promptSelect.value = payload.database.id; updatePrompt();
  } catch (error) { status.textContent = error.message; }
  finally { clearBusy(button, status, form); updateQuotaButtons(); }
});

$('#upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const uploadForm = event.currentTarget;
  const file = $('#zip-file').files[0]; if (!file) return;
  const button = uploadForm.querySelector('button[type=submit]');
  const status = $('#upload-status');
  setBusy(button, status, 'Enviando e validando o ZIP…', uploadForm);
  $('#upload-result').hidden = true;
  try {
    const form = new FormData(); form.append('file', file);
    const app = await api('/api/apps', { method: 'POST', body: form });
    status.textContent = 'Aplicação publicada.';
    $('#result-name').textContent = app.name;
    $('#result-url').href = app.url; $('#result-url').textContent = app.url;
    $('#upload-result').hidden = false;
    uploadForm.reset(); $('#zip-file-label').textContent = 'Clique ou arraste seu site em ZIP aqui';
    await loadApps();
  } catch (error) { status.textContent = error.message; }
  finally { clearBusy(button, status, uploadForm); updateQuotaButtons(publishedApps); }
});

api('/api/session').then(session => {
  portalLimits = session;
  $('#database-file-limit').textContent = `Até ${session.maxJsonMb} MB`;
  if (!session.mysqlAvailable) {
    $('#database-status').textContent = 'O serviço de dados está indisponível. Verifique a instalação.';
    $('#empty-database-status').textContent = 'O serviço de dados está indisponível. Verifique a instalação.';
  }
  if (session.authenticated) return showDashboard();
  showAuth(session.setupRequired);
}).catch(error => { showAuth(false); $('#auth-status').textContent = error.message; });
