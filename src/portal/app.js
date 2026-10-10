const $ = selector => document.querySelector(selector);
const authPanel = $('#auth-panel');
const dashboard = $('#dashboard');
const authForm = $('#auth-form');
const databaseList = $('#database-list');
const appsList = $('#apps-list');
const promptSelect = $('#prompt-database');
const promptBox = $('#ai-prompt');
const keyDialog = $('#key-dialog');
const actionDialog = $('#action-dialog');
const sidebar = $('#portal-sidebar');
const navToggle = $('#nav-toggle');
const sidebarBackdrop = $('#sidebar-backdrop');
const navLinks = [...document.querySelectorAll('[data-nav-section]')];
let activeDialog = null;
let setupRequired = false;
let databases = [];
let publishedApps = 0;
let publishedAppNames = new Set();
let portalLimits = { maxDatabases: 20, maxApps: 20, mysqlAvailable: false };
let promptRequest = 0;
let visibleSecretDatabaseId = null;
let visibleSecretKeyId = null;
const copyLabels = new WeakMap();
const copyTimers = new WeakMap();

function setMenuOpen(open, restoreFocus = false) {
  document.body.classList.toggle('nav-open', open);
  sidebar.inert = window.innerWidth <= 900 && !open;
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  sidebarBackdrop.hidden = !open;
  if (open) navLinks[0].focus();
  else if (restoreFocus) navToggle.focus();
}

function selectView(id, updateAddress = false) {
  const current = navLinks.find(link => link.dataset.navSection === id) || navLinks[0];
  for (const link of navLinks) {
    const selected = link === current;
    link.classList.toggle('is-active', selected);
    document.getElementById(link.dataset.navSection).hidden = !selected;
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#current-section-label').textContent = current.lastElementChild.textContent;
  if (updateAddress && location.hash !== `#${current.dataset.navSection}`) {
    history.pushState(null, '', `#${current.dataset.navSection}`);
  }
  window.scrollTo(0, 0);
}

navToggle.addEventListener('click', () => setMenuOpen(!document.body.classList.contains('nav-open')));
sidebarBackdrop.addEventListener('click', () => setMenuOpen(false, true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('nav-open')) setMenuOpen(false, true);
});
for (const link of navLinks) link.addEventListener('click', event => {
  event.preventDefault();
  selectView(link.dataset.navSection, true);
  if (document.body.classList.contains('nav-open')) {
    setMenuOpen(false);
    const section = document.getElementById(link.dataset.navSection);
    section.tabIndex = -1;
    section.focus({ preventScroll: true });
  }
});
window.addEventListener('popstate', () => { if (!dashboard.hidden) selectView(location.hash.slice(1)); });
window.addEventListener('hashchange', () => { if (!dashboard.hidden) selectView(location.hash.slice(1)); });
window.addEventListener('resize', () => {
  if (window.innerWidth > 900 && document.body.classList.contains('nav-open')) setMenuOpen(false);
  sidebar.inert = window.innerWidth <= 900 && !document.body.classList.contains('nav-open');
});

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

function copyWithSelection(value, container = document.body) {
  const field = document.createElement('textarea');
  const previousFocus = document.activeElement;
  field.value = value;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0.01;font-size:16px;pointer-events:none';
  container.append(field);
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

async function copy(value, button, source, fallbackContainer = document.body) {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); copied = true; }
    catch { /* Tenta a cópia por seleção em páginas HTTP da rede local. */ }
  }
  if (!copied) {
    try { copied = copyWithSelection(value, fallbackContainer); }
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

function openDialog({ mode = 'confirm', title, message, value = '', confirmText = 'Confirmar', danger = false }) {
  if (actionDialog.open) throw new Error('Já existe uma janela aberta.');
  actionDialog.dataset.intent = danger ? 'danger' : mode;
  $('#action-dialog-symbol').textContent = mode === 'rename' ? '✎' : danger ? '!' : mode === 'notice' ? 'i' : '✓';
  $('#action-dialog-eyebrow').textContent = mode === 'rename' ? 'PERSONALIZAR CARTÃO' : mode === 'notice' ? 'AVISO' : 'CONFIRMAÇÃO';
  $('#action-dialog-title').textContent = title;
  $('#action-dialog-message').textContent = message;
  $('#action-dialog-input').hidden = mode !== 'rename';
  $('#action-dialog-label').hidden = mode !== 'rename';
  $('#action-dialog-input').value = value;
  $('#action-dialog-error').hidden = true;
  $('#action-dialog-cancel').hidden = mode === 'notice';
  $('#action-dialog-submit').textContent = confirmText;
  actionDialog.showModal();
  if (mode === 'rename') $('#action-dialog-input').focus();
  else $('#action-dialog-submit').focus();
  return new Promise(resolve => { activeDialog = { mode, resolve }; });
}

function closeActionDialog(result = null) {
  if (!activeDialog) return;
  const { resolve } = activeDialog;
  activeDialog = null;
  actionDialog.close();
  resolve(result);
}

$('#action-dialog-cancel').addEventListener('click', () => closeActionDialog());
$('#action-dialog-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!activeDialog) return;
  if (activeDialog.mode === 'rename') {
    const value = $('#action-dialog-input').value.trim();
    if (!value) {
      $('#action-dialog-error').textContent = 'Digite um nome para o cartão.';
      $('#action-dialog-error').hidden = false;
      $('#action-dialog-input').focus();
      return;
    }
    closeActionDialog(value);
  } else closeActionDialog(true);
});
actionDialog.addEventListener('close', () => {
  if (activeDialog) { activeDialog.resolve(null); activeDialog = null; }
});
actionDialog.addEventListener('click', event => { if (event.target === actionDialog) closeActionDialog(); });
const confirmAction = (title, message, confirmText = 'Confirmar', danger = false) =>
  openDialog({ title, message, confirmText, danger });
const showNotice = (message, title = 'Não foi possível concluir') =>
  openDialog({ mode: 'notice', title, message, confirmText: 'Entendi' });

async function renameCard(kind, item, button) {
  const isDatabase = kind === 'database';
  const displayName = item.displayName || item.name;
  const next = await openDialog({ mode: 'rename', title: isDatabase ? 'Renomear banco' : 'Renomear site',
    message: 'Este nome aparece apenas no cartão. O conteúdo e o endereço continuam iguais.',
    value: displayName, confirmText: 'Salvar nome' });
  if (next === null || next === displayName) return;
  setBusy(button);
  try {
    await api(`/api/${isDatabase ? 'databases' : 'apps'}/${item.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: next }),
    });
    if (isDatabase) await loadDatabases();
    else await loadApps();
  } catch (error) { await showNotice(error.message); }
  finally { clearBusy(button); }
}
$('#copy-token').addEventListener('click', () => copy($('#secret-token').textContent, $('#copy-token'), $('#secret-token')));
$('#key-dialog-copy').addEventListener('click', () => copy(
  $('#key-dialog-token').textContent, $('#key-dialog-copy'), $('#key-dialog-token'), keyDialog));
$('#key-dialog-close').addEventListener('click', () => keyDialog.close());
keyDialog.addEventListener('click', event => { if (event.target === keyDialog) keyDialog.close(); });
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
  const blob = new Blob(['\uFEFF', `# Instruções para adaptar o site\n\n${promptBox.value}\n`], { type: 'text/markdown;charset=utf-8' });
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
  setMenuOpen(false);
  document.body.classList.remove('is-dashboard');
  sidebar.hidden = true;
  navToggle.hidden = true;
  $('#topbar-context').hidden = true;
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
  document.body.classList.add('is-dashboard');
  sidebar.hidden = false;
  setMenuOpen(false);
  navToggle.hidden = false;
  $('#topbar-context').hidden = false;
  authPanel.hidden = true;
  dashboard.hidden = false;
  $('#logout').hidden = false;
  selectView(location.hash.slice(1));
  await loadDatabases();
  await loadApps();
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
  } catch (error) { await showNotice(error.message); }
  finally { clearBusy(button); }
});

function sitePreservationRules(db) {
  return `ESCOPO OBRIGATÓRIO: examine o projeto e identifique os fluxos que já funcionam antes de editar. Preserve telas, textos, acentos, símbolos, nomes, estrutura de arquivos, cálculos, relatórios, importação/exportação e regras de negócio. Modifique somente a integração de dados e, se necessário, o botão que escolhia especificamente o arquivo do banco. Mantenha os outros seletores de arquivo e as funções locais existentes. Faça alterações pequenas e verificáveis; não recrie nem reformate arquivos inteiros por conveniência.

CODIFICAÇÃO OBRIGATÓRIA: identifique a codificação real de cada arquivo antes de editá-lo. Se já estiver em UTF-8, preserve-a e não recodifique o arquivo inteiro. Os arquivos HTML, CSS e JavaScript publicados serão servidos como UTF-8; se algum original usar outra codificação, converta somente esse arquivo de forma controlada para UTF-8, ajuste o <meta charset> do HTML e confira visualmente todos os textos antes de entregar. Preserve ç, ã, õ, á, é, í, ó, ú e outros caracteres Unicode. Rejeite alterações que produzam caracteres corrompidos como "Ã¡" ou "�". Mantenha idênticos os arquivos que não precisam mudar.

REFERÊNCIA DO BANCO ATUAL: ${db.url}. Localize a configuração da conexão que está sendo adaptada e confira se ela usa exatamente este endereço. Substitua nessa conexão o endereço antigo, se houver; preserve referências a outros bancos usados intencionalmente e informe qualquer ambiguidade. Não altere o formato dos dados para acomodar o endereço. Cada banco tem chave própria: peça ao usuário a chave deste banco em tempo de execução e nunca grave chaves no código ou no ZIP. Se a conexão retornar 404, mostre o endereço usado para diagnóstico e confira o identificador; se retornar 401/403, trate a chave/permissão separadamente.

VALIDAÇÃO FINAL: compare o comportamento antes e depois em fluxos principais, confira o diff e verifique textos e acentos nas telas. Teste conexão, leitura e gravação com este banco quando ele estiver acessível. Informe quais arquivos mudaram, qual endereço de banco foi configurado e qualquer fluxo que não pôde ser testado. Preserve as dependências já usadas pelo projeto; não introduza novas dependências externas nem troque bibliotecas neste ajuste.`;
}

function promptFor(db) {
  return `Adapte esta aplicação HTML/CSS/JavaScript para usar um banco JSON acessível por API HTTP, mantendo sua interface, regras de negócio e estrutura do JSON.

${sitePreservationRules(db)}

Endereço público do banco: ${db.url}
Identificador do banco: ${db.id}

Contrato da resposta:
- GET retorna o JSON original completo no corpo, sem envelope collections ou data.
- Exemplo quando a raiz original é um objeto: {"produtos":[{"id":1,"nome":"Caderno"}],"configuracao":{"moeda":"BRL"}}. Se a raiz original for uma lista, a resposta também é uma lista.
- O ETag é um cabeçalho HTTP chamado ETag, não um campo dentro do JSON. Guarde o valor exato, inclusive aspas, para enviar em If-Match.
- Antes de interpretar dados, confira response.ok. Uma resposta de erro tem o formato {"error":"mensagem"}: 401 indica chave ausente/inválida, 403 chave sem permissão de gravação, 409 conflito de edição e 413 limite de tamanho excedido.

Requisitos:
- A aplicação deve funcionar aberta localmente (inclusive por file:// ou por um servidor local) e depois de publicada em outra origem, usando o mesmo endereço de API.
- O identificador e o endereço podem ficar no código. A chave privada de acesso NÃO pode ficar no código, no ZIP, em arquivos de configuração distribuídos nem na URL. Peça ao usuário a chave quando for acessar o banco e mantenha-a apenas em memória durante a sessão.
- Na conexão, valide a chave com uma leitura GET antes de liberar a aplicação. Diferencie falha HTTP (mostre status e campo error) de falha de rede/CORS. Não transforme erro HTTP em uma mensagem genérica de estrutura de dados.
- Para ler, faça GET no endereço acima com Authorization: Bearer <chave>. A resposta é o JSON atual e traz um cabeçalho ETag.
- Para salvar, faça PUT no mesmo endereço com Authorization: Bearer <chave>, Content-Type: application/json e If-Match: <ETag da última leitura>. Envie o JSON completo diretamente no corpo. Depois de salvar, atualize o ETag com o valor recebido na resposta.
- Se o PUT retornar 409, mostre conflito de edição e ofereça recarregar os dados; não sobrescreva silenciosamente. Se retornar 401/403, peça uma chave válida ou informe que ela não tem permissão de gravação.
- Mostre sucesso somente após a gravação confirmada pela API. Trate falhas de rede e preserve as alterações ainda não salvas na tela.
- Se existir um seletor cuja única função é escolher o arquivo do banco, adapte somente essa conexão para pedir a chave. Preserve os demais seletores, importações e exportações da aplicação.
- Não inclua o arquivo JSON no ZIP da aplicação. Preserve os recursos e as dependências existentes; informe separadamente se algum recurso externo impedir o funcionamento sem internet.
- Ao testar a publicação sob um prefixo de URL, corrija somente os caminhos de recursos ou de navegação que falharem. Use caminhos relativos nas novas referências.

Implemente as mudanças no projeto, teste leitura, gravação, chave inválida e conflito de edição. Ao final, entregue um ZIP com o site pronto para publicação e liste os arquivos alterados.`;
}

function mysqlOnDemandRules(imported) {
  return `CARREGAMENTO SOB DEMANDA OBRIGATÓRIO:
- Ao conectar, consulte somente ${imported ? '/collections para descobrir nomes, tipos, IDs e quantidades dos grupos' : '/tables para descobrir nomes, colunas e quantidades das tabelas'}. Não carregue todos os registros na inicialização nem execute uma sequência automática de páginas até nextCursor=null.
- Leia apenas os dados necessários para a tela, ação ou registro solicitado. Para listas, peça uma página pequena (por exemplo, limit=25; use limit=1 quando cada registro for grande), guarde os cursores das páginas e busque a próxima somente quando o usuário avançar ou pedir mais. Use os IDs dos itens para editar ou apagar individualmente. Mantenha no navegador apenas a página visível, as alterações ainda não salvas e um cache pequeno com limite definido; descarte páginas antigas quando possível.
- Preserve os resultados e as regras de negócio existentes. Não apresente busca, filtro, ordenação, totais ou relatórios globais calculados apenas sobre uma página como se representassem o banco inteiro. A API documentada aqui não oferece busca ou agregação geral no servidor. Se algum fluxo exigir todos os registros, identifique-o e explique qual consulta ou estrutura de servidor será necessária; não resolva isso baixando o banco inteiro silenciosamente nem invente rotas que não estão documentadas.
- ${imported ? 'Uma coleção kind=single pode conter um único registro JSON muito grande. limit=1 limita a quantidade de registros, não divide o conteúdo desse registro. Se uma tela depender de partes desse valor grande, informe claramente que a API atual ainda envia o item inteiro e proponha uma separação planejada dos dados ou uma consulta de servidor, preservando os dados existentes. Não afirme que esse caso ficou paginado.' : 'Cada linha de tabela é enviada por inteiro. Se uma coluna JSON guardar um documento muito grande, a paginação de linhas não divide essa coluna; informe essa limitação e proponha uma consulta de servidor ou estrutura adequada sem alterar os dados existentes por conta própria.'}
- Valide o comportamento das telas depois da mudança: carregamento inicial, avanço de página, edição, conflito e atualização da lista. Registre no resumo final quais fluxos ficaram sob demanda e quais ainda dependem de um item grande ou de uma consulta que a API não fornece.`;
}

function mysqlPrompt(db, structure, mode = 'app') {
  const groups = structure.collections.map(group => `- ${JSON.stringify(group.name)}: ${group.kind === 'list' ? 'lista' : 'valor único'}, ${group.count} item(ns)`).join('\n');
  const tables = structure.tables.map(table => `- ${table.name}: ${table.count} registro(s); ${table.columns.map(column => `${column.name} ${column.columnType}`).join(', ')}`).join('\n');
  const imported = db.source === 'imported';
  const hasImportedJson = imported || db.kind !== 'mysql';
  const apiDetails = imported
    ? [
      'Contrato da API MySQL para dados importados de JSON:',
      '',
      '1. Valide a conex\u00e3o com GET ' + db.url + '/collections e envie Authorization: Bearer <chave>. O corpo de sucesso \u00e9 um envelope, n\u00e3o o JSON original:',
      '~~~json',
      JSON.stringify({ collections: [ { id: '0123456789abcdef', name: 'produtos', kind: 'list', count: 2 }, { id: 'fedcba9876543210', name: 'configuracao', kind: 'single', count: 1 } ] }, null, 2),
      '~~~',
      'Cada grupo cont\u00e9m um ID opaco, o nome original, o tipo (list ou single) e a quantidade de registros. Localize pelo campo name, mas use o campo id nas rotas. A resposta n\u00e3o \u00e9 uma lista direta.',
      '',
      '2. Quando a tela precisar de um grupo, leia sua primeira página em GET ' + db.url + '/collections/<id>/records?limit=25. Resposta paginada de exemplo:',
      '~~~json',
      JSON.stringify({ items: [ { id: '89abcdef01234567', data: { id: 1, nome: 'Caderno' }, etag: '"1"' } ], nextCursor: null }, null, 2),
      '~~~',
      'Se nextCursor n\u00e3o for null, busque a pr\u00f3xima p\u00e1gina com &cursor=<nextCursor> somente quando o usu\u00e1rio pedir mais dados. N\u00e3o percorra todas as p\u00e1ginas automaticamente. data \u00e9 o valor original e pode ser objeto, lista, texto, n\u00famero, booleano ou null. O id externo e o etag pertencem ao servi\u00e7o; n\u00e3o substitua um campo id existente dentro de data.',
      '',
      '3. Esta API n\u00e3o devolve o documento JSON original inteiro. Ela devolve os metadados dos grupos em /collections e os registros solicitados em /records. Adapte apenas os dados solicitados ao modelo da tela atual, mantendo a interface e as regras de neg\u00f3cio. kind=list indica um grupo com v\u00e1rios registros; kind=single indica um valor. count:0 representa um grupo vazio, n\u00e3o uma falha. Se faltarem grupos que a aplica\u00e7\u00e3o exigir, mostre os nomes ausentes.',
      '',
      '4. Para criar, envie POST para ' + db.url + '/collections/<id>/records com Content-Type: application/json. O corpo recebe diretamente o valor do registro, sem envelope data. Exemplo do corpo enviado:',
      '~~~json',
      JSON.stringify({ id: 1, nome: 'Caderno' }, null, 2),
      '~~~',
      'Para editar, use PUT em ' + db.url + '/collections/<id>/records/<recordId> com o mesmo formato de corpo e If-Match igual ao etag do item lido. POST retorna HTTP 201; cria\u00e7\u00e3o e edi\u00e7\u00e3o retornam um item neste envelope:',
      '~~~json',
      JSON.stringify({ id: '89abcdef01234567', data: { id: 1, nome: 'Caderno' }, etag: '"2"' }, null, 2),
      '~~~',
      'Para remover, use DELETE na rota do item com If-Match e etag do registro; a resposta \u00e9 {ok:true}. Cada chamada altera um registro. Preserve os IDs/ETags externos e atualize somente os itens modificados.'
    ].join('\n')
    : [
      'Contrato da API de tabelas SQL:',
      '',
      'GET ' + db.url + '/tables retorna um envelope com tabelas e colunas:',
      '~~~json',
      JSON.stringify({ tables: [ { name: 'produtos', columns: [ { name: 'nome', dataType: 'varchar', columnType: 'varchar(120)', nullable: false, defaultValue: null } ], count: 1 } ] }, null, 2),
      '~~~',
      'Quando a tela precisar dos registros de uma tabela, GET ' + db.url + '/tables/<tabela>/rows?limit=25 retorna a primeira p\u00e1gina com items e nextCursor. Busque a pr\u00f3xima com &cursor=<nextCursor> somente quando o usu\u00e1rio pedir mais dados. Cada item tem id, data e etag; use id externo nas rotas e preserve os campos que estiverem dentro de data.',
      '~~~json',
      JSON.stringify({ items: [ { id: '1', data: { nome: 'Caderno' }, etag: '"1"' } ], nextCursor: null }, null, 2),
      '~~~',
      'POST em /tables/<tabela>/rows recebe no corpo um objeto JSON puro com colunas da tabela, sem envelope data, e retorna HTTP 201 com id, data e etag. PUT em /tables/<tabela>/rows/<id> recebe o objeto de colunas puro e If-Match com o etag lido; a resposta cont\u00e9m id, data e o novo etag. DELETE na mesma rota exige If-Match e retorna {ok:true}. IDs externos s\u00e3o strings e podem ser diferentes do campo id de neg\u00f3cio.'
    ].join('\n');
  if (mode === 'schema') {
    return `Crie um arquivo SQL para ${tables ? 'atualizar a estrutura existente' : 'criar a estrutura inicial'} deste banco, preservando todos os registros atuais. O arquivo será aplicado por uma ferramenta que isola cada banco.

Endereço de referência: ${db.url}
Grupos de dados existentes: ${groups || '- Nenhum grupo.'}
Tabelas e colunas atuais: ${tables || '- Ainda não existem tabelas personalizadas.'}

Entregue um arquivo chamado ${tables ? 'atualizacao.sql' : 'estrutura.sql'} contendo apenas comandos compatíveis com MySQL para criação de tabelas e alterações estruturais seguras. Use nomes lógicos simples para tabelas e colunas (letras, números e _; nome de tabela com até 40 caracteres). Tipos aceitos: VARCHAR, CHAR, TINYINT, SMALLINT, MEDIUMINT, INT, BIGINT, DECIMAL, FLOAT, DOUBLE, BOOLEAN, DATE, DATETIME, TIMESTAMP, TIME, YEAR, TEXT, MEDIUMTEXT, LONGTEXT, JSON e BLOB.

Regras para preservar os dados:
- ${hasImportedJson ? 'Este banco contém dados importados de JSON. As tabelas SQL serão adicionais; mantenha os grupos e registros importados intactos e não tente convertê-los automaticamente.' : 'Mantenha as tabelas e registros existentes intactos.'}
- Não use DROP TABLE, DROP COLUMN, TRUNCATE, DELETE, UPDATE de dados, USE, CREATE DATABASE, usuários, permissões, procedures, triggers ou comandos fora da estrutura das tabelas.
- Em tabelas existentes, faça alterações aditivas: ADD COLUMN, ADD INDEX/UNIQUE INDEX, RENAME COLUMN ou DROP INDEX. Ao adicionar coluna NOT NULL, informe DEFAULT para que os registros existentes continuem válidos.
- Não altere o tipo de uma coluna existente nem remova colunas. Se uma mudança exigir conversão de dados, explique a migração separadamente em vez de incluir um comando que possa truncar ou descartar valores.
- Não declare PRIMARY KEY nem AUTO_INCREMENT: o serviço acrescenta um identificador interno a cada registro. Uma coluna de negócio chamada id pode ser criada normalmente.
- Não use nomes de tabelas prefixados com o identificador do banco; o portal aplica o isolamento automaticamente.
- Inclua comentários curtos no SQL para explicar cada alteração. Não inclua instruções de execução fora do arquivo.

Confira que o SQL contém apenas estrutura, sem dados de acesso ou chaves. Preserve as tabelas e os campos que já existem. Não modifique os arquivos HTML, CSS ou JavaScript nesta tarefa. Retorne o arquivo ${tables ? 'atualizacao.sql' : 'estrutura.sql'} e um resumo das mudanças.`;
  }

  if (!imported && structure.tables.length === 0) {
    return `Adapte esta aplicação HTML/CSS/JavaScript mantendo sua arquitetura, telas, navegação, formato dos objetos e regras de negócio. Altere somente o acesso aos dados e o fluxo de conexão.

${sitePreservationRules(db)}

Antes de concluir, crie um arquivo estrutura.sql com as tabelas e colunas necessárias para a aplicação. Use nomes simples de tabela e coluna. Não inclua PRIMARY KEY, AUTO_INCREMENT, DROP, DELETE, TRUNCATE, usuários, permissões ou comandos de conexão; o serviço adiciona IDs internos e aplica o SQL isolado para este banco. Para novas colunas obrigatórias, defina DEFAULT.

Endereço da API: ${db.url}
O usuário aplicará estrutura.sql na área de atualização deste banco antes de usar as tabelas.

Para acessar os dados, todas as requisições usam Authorization: Bearer <chave>. Solicite a chave na tela de conexão e mantenha-a apenas em memória. Nunca a inclua no código, ZIP, URL ou armazenamento local.

API de tabelas:
- GET ${db.url}/tables lista tabelas e colunas.
- GET ${db.url}/tables/<tabela>/rows?limit=25 lista a primeira página; use &cursor=<nextCursor> apenas quando o usuário pedir a próxima. Cada item contém id, data e etag.
- POST ${db.url}/tables/<tabela>/rows cria um registro JSON.
- PUT ${db.url}/tables/<tabela>/rows/<id> altera o registro usando If-Match: <etag anterior>.
- DELETE ${db.url}/tables/<tabela>/rows/<id> apaga um registro usando If-Match.

${apiDetails}

${mysqlOnDemandRules(false)}

Antes de interpretar qualquer resposta, confira response.ok. Respostas de erro usam o formato {\"error\":\"mensagem\"}: 401 chave ausente/inv\u00e1lida; 403 sem permiss\u00e3o; 404 URL, banco ou grupo inexistente; 409 conflito de grava\u00e7\u00e3o; 413 limite excedido. Se fetch falhar sem resposta HTTP, informe falha de rede/CORS e preserve os dados ainda n\u00e3o salvos.

Trate 409 como conflito e recarregue antes de salvar novamente. Trate 401/403 solicitando uma chave válida ou informando a permissão. Mostre sucesso apenas após confirmação da API. Preserve as alterações locais quando a rede falhar.

O site deve funcionar aberto localmente (inclusive file://) e depois de publicado. Corrija somente caminhos de recursos locais que falharem sob o prefixo de publicação e use caminhos relativos nas novas referências. Não inclua o JSON original, arquivos SQL nem a chave no ZIP. Preserve os demais recursos e as dependências existentes; informe separadamente se algum recurso externo impedir o funcionamento sem internet.

Implemente e teste a aplicação usando a API documentada. Descreva os arquivos alterados e entregue o ZIP do site e estrutura.sql como arquivos separados. O SQL deve ser enviado pela opção de atualização do banco, nunca dentro do ZIP.`;
  }

  return `Adapte esta aplicação HTML/CSS/JavaScript para usar os dados deste banco MySQL por meio da API HTTP. Preserve as telas, regras de negócio, fluxo e formato atual dos dados. Altere apenas a camada que lê e salva.

${sitePreservationRules(db)}

Endereço da API: ${db.url}
Origem dos dados: ${imported ? 'JSON importado, organizado em grupos' : 'banco com estrutura SQL'}.
Formato da raiz do JSON de origem (refer\u00eancia do formato do site; n\u00e3o \u00e9 formato de resposta da API): ${db.summary?.rootType || 'object'}.
Grupos existentes:
${groups || '- Nenhum grupo.'}
Tabelas personalizadas:
${tables || '- Nenhuma.'}

${imported ? `Use as coleções já importadas: GET ${db.url}/collections e GET/POST/PUT/DELETE em /collections/<id>/records. Adapte cada registro solicitado ao formato que a tela já espera, sem reconstruir o JSON completo no navegador. Mantenha IDs e ETags para alterar somente itens modificados. Não mova nem descarte os dados importados.` : `Use as tabelas SQL existentes pela API: GET ${db.url}/tables; GET ${db.url}/tables/<tabela>/rows?limit=25 para a primeira página; POST na mesma rota para criar; PUT ou DELETE em /rows/<id> com If-Match: <etag>.`}

${apiDetails}

${mysqlOnDemandRules(imported)}

Antes de interpretar qualquer resposta, confira response.ok. Respostas de erro usam o formato {"error":"mensagem"}: 401 chave ausente/inv\u00e1lida; 403 sem permiss\u00e3o; 404 URL, banco ou grupo inexistente; 409 conflito de grava\u00e7\u00e3o; 413 limite excedido. Se fetch falhar sem resposta HTTP, informe falha de rede/CORS e preserve os dados ainda n\u00e3o salvos.

Todas as requisições enviam Authorization: Bearer <chave>. Peça a chave ao usuário no momento de conectar e mantenha-a apenas em memória. Nunca grave a chave no código, ZIP, URL ou armazenamento local. Em 409 recarregue e apresente o conflito; em 401/403 solicite uma chave com permissão adequada. Preserve alterações não salvas se a rede falhar.

${imported
  ? `Os dados importados do JSON já estão disponíveis pela API de coleções no MySQL. Não gere estrutura.sql para esses dados e não converta os grupos em tabelas SQL. Se a aplicação realmente precisar de tabelas SQL adicionais, gere um arquivo separado apenas para essa necessidade e explique que ele deve ser enviado pela opção “Atualizar estrutura com arquivo .sql” no banco. Nunca inclua arquivos SQL no ZIP do site.`
  : `Use as tabelas existentes. Gere um arquivo SQL separado somente se a aplicação realmente precisar de novas tabelas ou colunas; nesse caso, inclua apenas comandos aditivos que preservem os dados, sem comandos destrutivos. O usuário enviará esse arquivo pela opção de atualização do banco; nunca o inclua no ZIP do site.`}

Mantenha a aplicação funcionando localmente (inclusive file://) e publicada, usando o mesmo endereço. Corrija somente caminhos que falharem sob o prefixo de publicação e use caminhos relativos nas novas referências. Não inclua JSON, arquivos SQL nem chave no ZIP e preserve as dependências existentes. Implemente, teste e entregue somente o ZIP do site para publicação${imported ? '.' : ' e o arquivo SQL separado, se houver estrutura a aplicar.'}`;
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
    $('#overview-database-count').textContent = databases.length;
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
  info.append(textNode('strong', db.displayName || db.name), textNode('small', `${db.kind === 'mysql' ? (db.source === 'imported' ? 'Dados importados' : 'Espaço novo') : 'Arquivo JSON'} · ${new Date(db.createdAt).toLocaleString('pt-BR')}`));
  const actions = textNode('div', '', 'record-actions');
  const rename = textNode('button', 'Renomear');
  rename.type = 'button'; rename.addEventListener('click', () => renameCard('database', db, rename));
  const endpoint = textNode('p', db.url, 'endpoint');
  const copyButton = textNode('button', 'Copiar endereço');
  copyButton.type = 'button'; copyButton.addEventListener('click', () => copy(db.url, copyButton, endpoint));
  const download = textNode('a', 'Baixar JSON');
  download.href = `/api/databases/${db.id}/download`;
  const remove = textNode('button', 'Apagar banco', 'danger-button');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!await confirmAction('Apagar banco?', `"${db.displayName || db.name}" e todas as suas chaves serão excluídos. Sites que usam esses dados perderão o acesso. Esta ação não pode ser desfeita.`, 'Apagar banco', true)) return;
    setBusy(remove);
    try {
      await api(`/api/databases/${db.id}`, { method: 'DELETE' });
      hideSecretForDatabase(db.id);
      await loadDatabases();
      await loadApps();
      $('#database-status').textContent = `Banco ${db.name} apagado.`;
    } catch (error) { await showNotice(error.message); }
    finally { clearBusy(remove); }
  });
  actions.append(copyButton, download, rename, remove); head.append(info, actions);
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
      if (!await confirmAction('Aplicar atualização?', `O arquivo "${file.name}" atualizará a estrutura de "${db.displayName || db.name}". O portal aceita apenas alterações estruturais sem comandos para apagar dados.`, 'Aplicar atualização')) return;
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
    } catch (error) { await showNotice(error.message); }
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
      if (!key.canReveal && !await confirmAction('Gerar nova chave?', `A chave antiga de ${key.label} não pode ser recuperada. A nova chave invalidará a anterior; os sites que a usam precisarão ser atualizados.`, 'Gerar nova chave', true)) return;
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
      } catch (error) { await showNotice(error.message); }
      finally { clearBusy(reveal); }
    });
    const revoke = textNode('button', 'Revogar'); revoke.type = 'button';
    revoke.addEventListener('click', async () => {
      if (!await confirmAction('Revogar chave?', `O acesso de ${key.label} será interrompido.`, 'Revogar chave', true)) return;
      setBusy(revoke);
      try {
        await api(`/api/databases/${db.id}/keys/${key.id}`, { method: 'DELETE' });
        hideSecretForDatabase(db.id, key.id);
        await loadDatabases();
      }
      catch (error) { await showNotice(error.message); }
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
    $('#overview-site-count').textContent = apps.length;
    publishedApps = apps.length;
    publishedAppNames = new Set(apps.map(app => app.name));
    $('#apps-count').textContent = `${apps.length} de ${portalLimits.maxApps} disponíveis`;
    updateQuotaButtons(apps.length);
    appsList.replaceChildren();
    if (!apps.length) { appsList.append(textNode('p', 'Nenhuma aplicação publicada ainda.', 'empty')); return; }
    for (const app of apps) {
      const record = textNode('article', '', 'record');
      const head = textNode('div', '', 'record-head');
      const info = document.createElement('div');
      info.append(textNode('strong', app.displayName || app.name), textNode('small', new Date(app.createdAt).toLocaleString('pt-BR')));
      if (app.databaseIds?.length) {
        const missing = app.databaseIds.filter(id => !databases.some(db => db.id === id));
        const connected = app.databaseIds.filter(id => !missing.includes(id))
          .map(id => databases.find(db => db.id === id).name);
        if (connected.length) info.append(textNode('small', `Referência encontrada para: ${connected.join(', ')}`));
        if (missing.length) info.append(textNode('small', `Atenção: encontramos no site um endereço de banco ausente (${missing.join(', ')}). Confira a conexão do site.`, 'status'));
      }
      const actions = textNode('div', '', 'record-actions');
      const copyButton = textNode('button', 'Copiar URL'); copyButton.type = 'button';
      copyButton.addEventListener('click', () => copy(app.url, copyButton));
      const open = textNode('a', 'Abrir'); open.href = app.url; open.target = '_blank'; open.rel = 'noopener';
      const rename = textNode('button', 'Renomear'); rename.type = 'button';
      rename.addEventListener('click', () => renameCard('app', app, rename));
      const remove = textNode('button', 'Apagar site', 'danger-button'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!await confirmAction('Apagar site?', `"${app.displayName || app.name}" será excluído e seu link deixará de funcionar. Esta ação não pode ser desfeita.`, 'Apagar site', true)) return;
        setBusy(remove);
        try { await api(`/api/apps/${app.id}`, { method: 'DELETE' }); await loadApps(); }
        catch (error) { await showNotice(error.message); }
        finally { clearBusy(remove); }
      });
      const update = textNode('details', '', 'sql-update');
      const updateSummary = textNode('summary', 'Atualizar este site (mantém o link)');
      const updateForm = textNode('form', '', 'sql-form');
      const updateInput = document.createElement('input');
      updateInput.type = 'file'; updateInput.accept = '.zip,application/zip'; updateInput.required = true; updateInput.hidden = true;
      updateInput.id = `site-update-${app.id}`;
      const updateDrop = textNode('label', '', 'file-drop'); updateDrop.htmlFor = updateInput.id;
      const updateIcon = textNode('span', '↑', 'upload-icon'); updateIcon.setAttribute('aria-hidden', 'true');
      const updateLabel = textNode('strong', 'Clique ou arraste o novo ZIP aqui');
      updateDrop.append(updateIcon, updateLabel, textNode('small', 'Até 50 MB'));
      updateDrop.addEventListener('dragover', event => {
        if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); updateDrop.classList.add('is-dragover'); }
      });
      updateDrop.addEventListener('dragleave', () => updateDrop.classList.remove('is-dragover'));
      updateDrop.addEventListener('drop', event => {
        event.preventDefault(); updateDrop.classList.remove('is-dragover');
        if (updateForm.getAttribute('aria-busy') === 'true' || event.dataTransfer.files.length !== 1) return;
        updateInput.files = event.dataTransfer.files;
        updateLabel.textContent = updateInput.files[0].name;
      });
      updateInput.addEventListener('change', () => { updateLabel.textContent = updateInput.files[0]?.name || 'Clique ou arraste o novo ZIP aqui'; });
      const updateStatus = textNode('span', 'O endereço atual do site será mantido.', 'status');
      const updateButton = textNode('button', 'Atualizar site'); updateButton.type = 'submit';
      const updateBottom = textNode('div', '', 'form-bottom'); updateBottom.append(updateStatus, updateButton);
      updateForm.append(updateDrop, updateInput, updateBottom);
      updateForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (updateForm.getAttribute('aria-busy') === 'true') return;
        const file = updateInput.files[0]; if (!file) return;
        if (!file.name.toLowerCase().endsWith('.zip')) { updateStatus.textContent = 'Selecione um arquivo ZIP.'; return; }
        setBusy(updateButton, updateStatus, 'Atualizando este site…', updateForm);
        try {
          const form = new FormData(); form.append('file', file);
          const updated = await api(`/api/apps/${app.id}`, { method: 'PUT', body: form });
          const missing = updated.databaseIds?.filter(id => !databases.some(db => db.id === id)) || [];
          $('#upload-status').textContent = missing.length
            ? `Site "${app.name}" atualizado com o mesmo link. Confira o aviso de banco ausente no cartão.`
            : `Site "${app.name}" atualizado. O link foi mantido.`;
          await loadApps();
        } catch (error) { updateStatus.textContent = error.message; }
        finally { clearBusy(updateButton, updateStatus, updateForm); }
      });
      update.append(updateSummary, updateForm);
      actions.append(copyButton, open, rename, remove); head.append(info, actions); record.append(head, update);
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
  if (uploadForm.getAttribute('aria-busy') === 'true') return;
  const file = $('#database-file').files[0]; if (!file) return;
  if (databases.some(db => db.name === file.name) &&
      !await confirmAction('Criar outro banco?', `Já existe um banco com o arquivo "${file.name}". Um novo envio criará outro banco, com endereço e chave diferentes.`, 'Criar outro')) return;
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
  if (form.getAttribute('aria-busy') === 'true') return;
  const name = $('#empty-database-name').value.trim();
  if (databases.some(db => db.name === name) &&
      !await confirmAction('Criar outro banco?', `Já existe um banco chamado "${name}". O novo banco terá endereço e chave diferentes.`, 'Criar outro')) return;
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
  if (uploadForm.getAttribute('aria-busy') === 'true') return;
  const file = $('#zip-file').files[0]; if (!file) return;
  const siteName = file.name.replace(/\.zip$/i, '');
  if (publishedAppNames.has(siteName) &&
      !await confirmAction('Publicar outra cópia?', `Já existe um site chamado "${siteName}". O novo envio criará outro site, com outro link.`, 'Publicar cópia')) return;
  const button = uploadForm.querySelector('button[type=submit]');
  const status = $('#upload-status');
  setBusy(button, status, 'Enviando e validando o ZIP…', uploadForm);
  $('#upload-result').hidden = true;
  try {
    const form = new FormData(); form.append('file', file);
    const app = await api('/api/apps', { method: 'POST', body: form });
    const missing = app.databaseIds?.filter(id => !databases.some(db => db.id === id)) || [];
    status.textContent = missing.length
      ? 'Site publicado. Encontramos nele uma referência a um banco ausente; confira o aviso no cartão.'
      : 'Aplicação publicada.';
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
