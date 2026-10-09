# Contexto de desenvolvimento — Super Sandbox

Leia este arquivo antes de alterar o projeto. Ele resume as decisões que precisam continuar válidas; detalhes de uso estão no `README.md` e a instalação local no Debian em `docs/debian-local.md`.

## Objetivo e fluxo

Portal Docker local com **dois envios independentes**: (1) cadastrar um JSON como banco persistente e emitir uma chave; (2) publicar um ZIP com o site HTML/CSS/JS, que já contém o endereço público do banco, mas **nunca** o JSON nem a chave. A aplicação deve acessar o mesmo banco enquanto roda localmente (`file://` ou servidor local) e após a publicação. O portal gera uma instrução para o Claude Code; **o texto dessa instrução não deve mencionar o nome do portal**.

## Mapa do código

- `src/server.js`: servidor HTTP Node.js, autenticação, bancos, upload/extração de ZIPs e arquivos estáticos. Sem framework web; dependências de produção: `busboy` e `yauzl`.
- `src/portal/`: interface administrativa HTML/CSS/JS, sem build nem recursos externos.
- `test/integration.test.js`: teste integrado de autenticação, chaves, CORS, leitura/gravação, conflito, ZIP e reinício.
- `examples/contador/`: cliente mínimo da API; não contém chave ou JSON.
- `compose.yaml` e `Dockerfile`: execução Docker. `package-lock.json` deve acompanhar mudanças em dependências.

## Contratos que não podem regredir

- Padrão: portal em `localhost:8080`, cada site em `<id>.localhost:8080`, com portas vinculadas a `127.0.0.1`. Modo LAN opt-in: `.env` local e ignorado pelo Git com `BIND_IP` e `PUBLIC_HOST` iguais ao IPv4 do Debian; portal em `IP:8080` e sites em `IP:8081/apps/<id>/`. Não grave IP real no repositório. A porta separada impede que sites usem a origem da administração. No modo LAN, recursos do site devem usar caminhos relativos; apps compartilham a origem da porta 8081.
- Dados em `DATA_DIR` (`/data` no contêiner), com `owner.json`, `databases/<id>/data.json` e `apps/<id>/site`. O volume Docker preserva bancos, chaves e aplicações. Não versionar dados reais, senhas ou chaves.
- Administração exige senha de proprietário, cookie `HttpOnly`/`SameSite=Strict` e verificação de `Origin` para mutações. Chaves por banco são aleatórias, armazenadas como hash, exibidas somente na criação, com permissão `read` ou `write` e revogação. A exclusão de banco exige sessão do proprietário e confirmação na interface; remove o JSON e todas as chaves. Sites publicados continuam servidos, mas deixam de acessar esse banco.
- API do banco: `GET /api/db-access/<id>` com `Authorization: Bearer <chave>` retorna JSON e `ETag`; `PUT` exige a mesma autorização, `Content-Type: application/json` e `If-Match` com o último `ETag`. Conflito retorna `409`; sem `If-Match`, `428`. CORS permite a aplicação local/publicada, mas **nunca substitui a autenticação pela chave**. Gravação deve continuar atômica.
- JSONs grandes: limite padrão 512 MB, configurável por `MAX_JSON_MB` no `.env`; upload, validação, GET, download e PUT devem usar fluxo e manter memória do servidor limitada. Preserve o `ETag` coerente com os bytes servidos mesmo durante gravações concorrentes. O navegador pode exigir mais memória para `response.json()`.
- ZIP do site: pelo menos um HTML, sem `db_global`; preservar estrutura e conteúdo enviados. Validar caminhos, links simbólicos e limites antes de publicar. Não servir arquivos `db_global` de uploads antigos.
- A chave deve ser pedida ao usuário em tempo de execução; não deve aparecer no ZIP, em URL, HTML, JS ou configuração distribuída. Como código JS arbitrário pode ler uma chave digitada nele, não prometa segurança contra uma aplicação maliciosa.

## Trabalho e verificação

Faça mudanças pequenas e mantenha `README.md`, o exemplo e o guia Debian alinhados quando contratos ou comandos mudarem. Para mudanças no servidor/API, amplie o teste integrado com um cenário observável, depois execute `npm test` nos modos padrão e LAN. Verifique sintaxe com `node --check src/server.js` e, ao alterar a interface, `node --check src/portal/app.js`. Execute Docker quando estiver disponível; caso contrário, declare claramente que o contêiner não foi testado. Antes de enviar ao GitHub, confira `git status`, arquivos staged e resultados dos testes. Não use force push e não inclua o volume de dados nem o `.env` local.
