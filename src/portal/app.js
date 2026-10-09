const $ = selector => document.querySelector(selector);
const authPanel = $('#auth-panel');
const dashboard = $('#dashboard');
const authForm = $('#auth-form');
const databaseList = $('#database-list');
const appsList = $('#apps-list');
const promptSelect = $('#prompt-database');
const promptBox = $('#claude-prompt');
let setupRequired = false;
let databases = [];

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

async function copy(value, button) {
  try {
    await navigator.clipboard.writeText(value);
    const before = button.textContent;
    button.textContent = 'Copiado';
    setTimeout(() => { button.textContent = before; }, 1800);
  } catch { button.textContent = 'Não foi possível copiar'; }
}

function showSecret(token, title) {
  $('#secret-title').textContent = title;
  $('#secret-token').textContent = token;
  $('#secret-result').hidden = false;
  $('#secret-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#copy-token').addEventListener('click', () => copy($('#secret-token').textContent, $('#copy-token')));
$('#copy-result').addEventListener('click', () => copy($('#result-url').href, $('#copy-result')));
$('#copy-prompt').addEventListener('click', () => copy(promptBox.value, $('#copy-prompt')));

function showAuth(setup) {
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
  button.disabled = true;
  try {
    await api(setupRequired ? '/api/setup' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    authForm.reset();
    await showDashboard();
  } catch (error) { $('#auth-status').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  $('#secret-result').hidden = true;
  $('#secret-token').textContent = '';
  showAuth(false);
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

Implemente as mudanças no projeto, teste leitura, gravação, chave inválida e conflito de edição. Ao final, entregue um ZIP com o site pronto para publicação e liste os arquivos alterados.`;
}

function updatePrompt() {
  const db = databases.find(item => item.id === promptSelect.value);
  promptBox.value = db ? promptFor(db) : '';
  $('#copy-prompt').disabled = !db;
}
promptSelect.addEventListener('change', updatePrompt);

async function loadDatabases() {
  try {
    databases = await api('/api/databases');
    $('#database-count').textContent = `${databases.length} cadastrado${databases.length === 1 ? '' : 's'}`;
    const selected = promptSelect.value;
    promptSelect.replaceChildren(new Option('Selecione um banco', ''));
    for (const db of databases) promptSelect.add(new Option(db.name, db.id));
    promptSelect.value = databases.some(db => db.id === selected) ? selected : '';
    updatePrompt();
    databaseList.replaceChildren();
    if (!databases.length) { databaseList.append(textNode('p', 'Nenhum banco cadastrado ainda.', 'empty')); return; }
    for (const db of databases) databaseList.append(renderDatabase(db));
  } catch (error) { databaseList.textContent = error.message; }
}

function renderDatabase(db) {
  const record = textNode('article', '', 'record');
  const head = textNode('div', '', 'record-head');
  const info = document.createElement('div');
  info.append(textNode('strong', db.name), textNode('small', `ID ${db.id} · ${new Date(db.createdAt).toLocaleString('pt-BR')}`));
  const actions = textNode('div', '', 'record-actions');
  const copyButton = textNode('button', 'Copiar endereço');
  copyButton.type = 'button'; copyButton.addEventListener('click', () => copy(db.url, copyButton));
  const download = textNode('a', 'Baixar JSON');
  download.href = `/api/databases/${db.id}/download`;
  actions.append(copyButton, download); head.append(info, actions);
  const endpoint = textNode('p', db.url, 'endpoint');
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
    event.preventDefault(); create.disabled = true;
    try {
      const payload = await api(`/api/databases/${db.id}/keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.value, permission: permission.value }),
      });
      showSecret(payload.token, `Chave criada para ${payload.key.label}`);
      await loadDatabases();
    } catch (error) { alert(error.message); }
    finally { create.disabled = false; }
  });
  const keys = textNode('div', '', 'key-list');
  for (const key of db.keys) {
    const row = textNode('div', '', 'key-item');
    row.append(textNode('span', `${key.label} · ${key.permission === 'write' ? 'leitura e gravação' : 'somente leitura'}`));
    const revoke = textNode('button', 'Revogar'); revoke.type = 'button';
    revoke.addEventListener('click', async () => {
      if (!confirm(`Revogar a chave de ${key.label}? O acesso será interrompido.`)) return;
      try { await api(`/api/databases/${db.id}/keys/${key.id}`, { method: 'DELETE' }); await loadDatabases(); }
      catch (error) { alert(error.message); }
    });
    row.append(revoke); keys.append(row);
  }
  keySection.append(form, keys);
  record.append(head, endpoint, keySection);
  return record;
}

async function loadApps() {
  try {
    const apps = await api('/api/apps');
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
      actions.append(copyButton, open); head.append(info, actions); record.append(head);
      appsList.append(record);
    }
  } catch (error) { appsList.textContent = error.message; }
}

for (const [input, label, empty] of [
  [$('#database-file'), $('#database-file-label'), 'Escolher arquivo JSON'],
  [$('#zip-file'), $('#zip-file-label'), 'Escolher ZIP do site'],
]) input.addEventListener('change', () => { label.textContent = input.files[0]?.name || empty; });

$('#database-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('#database-file').files[0]; if (!file) return;
  const button = event.currentTarget.querySelector('button[type=submit]'); button.disabled = true;
  $('#database-status').textContent = 'Validando e cadastrando o JSON…';
  try {
    const form = new FormData(); form.append('file', file);
    const payload = await api('/api/databases', { method: 'POST', body: form });
    $('#database-status').textContent = 'Banco cadastrado.';
    showSecret(payload.token, `Chave inicial de ${payload.database.name}`);
    event.currentTarget.reset(); $('#database-file-label').textContent = 'Escolher arquivo JSON';
    await loadDatabases();
    promptSelect.value = payload.database.id; updatePrompt();
  } catch (error) { $('#database-status').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('#zip-file').files[0]; if (!file) return;
  const button = event.currentTarget.querySelector('button[type=submit]'); button.disabled = true;
  $('#upload-result').hidden = true;
  $('#upload-status').textContent = 'Enviando e validando o ZIP…';
  try {
    const form = new FormData(); form.append('file', file);
    const app = await api('/api/apps', { method: 'POST', body: form });
    $('#upload-status').textContent = 'Aplicação publicada.';
    $('#result-name').textContent = app.name;
    $('#result-url').href = app.url; $('#result-url').textContent = app.url;
    $('#upload-result').hidden = false;
    event.currentTarget.reset(); $('#zip-file-label').textContent = 'Escolher ZIP do site';
    await loadApps();
  } catch (error) { $('#upload-status').textContent = error.message; }
  finally { button.disabled = false; }
});

api('/api/session').then(session => {
  if (session.authenticated) return showDashboard();
  showAuth(session.setupRequired);
}).catch(error => { showAuth(false); $('#auth-status').textContent = error.message; });
