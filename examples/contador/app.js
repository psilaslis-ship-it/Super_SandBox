const endpointInput = document.querySelector('#endpoint');
const keyInput = document.querySelector('#key');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
const increment = document.querySelector('#increment');
let data;
let etag;
let endpoint;
let key;

document.querySelector('#connect').addEventListener('click', async () => {
  endpoint = endpointInput.value.trim();
  key = keyInput.value.trim();
  if (!endpoint || !key) { status.textContent = 'Informe o endereço e a chave.'; return; }
  try {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Chave inválida ou revogada.' : 'Não foi possível ler o banco.');
    data = await response.json();
    etag = response.headers.get('ETag');
    if (!etag || typeof data.contador !== 'number') throw new Error('O JSON precisa ter um campo contador numérico.');
    count.textContent = data.contador;
    increment.disabled = false;
    keyInput.value = '';
    status.textContent = 'Banco conectado.';
  } catch (error) { status.textContent = error.message; }
});

increment.addEventListener('click', async () => {
  if (!data) return;
  increment.disabled = true;
  try {
    const next = { ...data, contador: data.contador + 1 };
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(next),
    });
    if (response.status === 409) throw new Error('O banco mudou em outra janela. Conecte novamente antes de salvar.');
    if (!response.ok) throw new Error(response.status === 403 ? 'Esta chave não permite gravação.' : 'Não foi possível salvar.');
    data = next;
    etag = response.headers.get('ETag');
    count.textContent = data.contador;
    status.textContent = 'Alteração salva no JSON.';
  } catch (error) { status.textContent = error.message; }
  finally { increment.disabled = false; }
});
