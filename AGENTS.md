# Contexto de desenvolvimento — Super Sandbox

Leia este arquivo antes de alterar o projeto. Ele resume as decisões que precisam continuar válidas; detalhes de uso estão no `README.md` e a instalação local no Debian em `docs/debian-local.md`.

## Objetivo e fluxo

Portal Docker local com **dois envios independentes**: (1) importar um JSON para MySQL preservando os dados ou criar um banco MySQL vazio, com chave individual; (2) publicar um ZIP com o site HTML/CSS/JS, que já contém o endereço público do banco, mas **nunca** o JSON nem a chave. Bancos JSON antigos continuam funcionando. A aplicação deve acessar o mesmo banco enquanto roda localmente (`file://` ou servidor local) e após a publicação. O portal gera uma instrução para o Claude Code, copiável e baixável em `.md`; **o texto dessa instrução não deve mencionar o nome do portal** e deve orientar a preservar a arquitetura, as telas e as regras do site.

## Mapa do código

- `src/server.js`: servidor HTTP Node.js, autenticação, bancos, upload/extração de ZIPs e arquivos estáticos. Sem framework web.
- `src/mysql-store.js`: importação JSON em fluxo, schema MySQL, grupos, itens e paginação. Dependências de produção: `busboy`, `yauzl`, `stream-json`, `mysql2`.
- `src/portal/`: interface administrativa HTML/CSS/JS, sem build nem recursos externos.
- `test/integration.test.js`: teste integrado de autenticação, chaves, CORS, leitura/gravação, conflito, ZIP e reinício.
- `examples/contador/`: cliente mínimo da API; não contém chave ou JSON.
- `compose.yaml` e `Dockerfile`: execução Docker. `package-lock.json` deve acompanhar mudanças em dependências.

## Contratos que não podem regredir

- Padrão: portal em `localhost:8080`, cada site em `<id>.localhost:8080`, com portas vinculadas a `127.0.0.1`. Modo LAN opt-in: `.env` local e ignorado pelo Git com `BIND_IP` e `PUBLIC_HOST` iguais ao IPv4 do Debian; portal em `IP:8080` e sites em `IP:8081/apps/<id>/`. Não grave IP real no repositório. A porta separada impede que sites usem a origem da administração. No modo LAN, recursos do site devem usar caminhos relativos; apps compartilham a origem da porta 8081.
- Dados em `DATA_DIR` (`/data` no contêiner), com `owner.json`, `databases/<id>/meta.json`, JSON antigo em `data.json` e `apps/<id>/site`. Os registros novos ficam no volume `mysql_data`; senhas internas geradas automaticamente ficam em `mysql_secrets`. Preservar os três volumes. Não versionar dados reais, senhas ou chaves.
- Novos bancos têm `kind: mysql` e `source: imported|empty`; antigos sem `kind` são `json`. O importador transforma arrays da raiz ou propriedades em itens e guarda grupos na ordem original, permitindo exportar novamente. Cada item tem até 16 MB; limites padrão: JSON 512 MB, 200 grupos, 1 milhão de itens. `MAX_DATABASES` e `MAX_APPS` no `.env` limitam quantidades (padrão 20 cada). Aplicar cota sob lock no momento de publicar.
- Administração exige senha de proprietário, cookie `HttpOnly`/`SameSite=Strict` e verificação de `Origin` para mutações. Chaves por banco são aleatórias, com hash para autenticação e valor cifrado por AES-GCM para consulta posterior pelo proprietário autenticado; a chave de cifra deriva da senha do proprietário e não é gravada no volume. Chaves antigas sem valor cifrado não podem ser recuperadas: a rotação substitui o valor e invalida o antigo. Permissões `read`/`write` e revogação permanecem. A exclusão de banco exige sessão do proprietário e confirmação na interface; remove seus registros ou JSON e todas as chaves. Sites publicados continuam servidos, mas deixam de acessar esse banco. Sites podem ser apagados pelo proprietário para liberar a cota.
- API JSON anterior: `GET /api/db-access/<id>` retorna JSON e `ETag`; `PUT` exige `If-Match`. Nova API MySQL: `/api/db-access/<id>/collections` e `/collections/<grupo>/records`, com paginação e CRUD por item, ETag/If-Match em alterações. Ambas exigem `Authorization: Bearer <chave>`. Conflito retorna `409`; sem `If-Match`, `428`. CORS permite a aplicação local/publicada, mas **nunca substitui a autenticação pela chave**.
- JSONs grandes: limite padrão 512 MB, configurável por `MAX_JSON_MB` no `.env`; upload, validação e exportação devem usar fluxo. A API JSON antiga mantém GET/PUT em fluxo e `ETag` coerente com os bytes servidos mesmo durante gravações concorrentes. A nova API MySQL pagina registros de até 16 MB. O navegador pode exigir mais memória para manipular coleções grandes.
- ZIP do site: pelo menos um HTML, sem `db_global`; preservar estrutura e conteúdo enviados. Validar caminhos, links simbólicos e limites antes de publicar. Não servir arquivos `db_global` de uploads antigos.
- A chave deve ser pedida ao usuário em tempo de execução; não deve aparecer no ZIP, em URL, HTML, JS ou configuração distribuída. Como código JS arbitrário pode ler uma chave digitada nele, não prometa segurança contra uma aplicação maliciosa.

## Trabalho e verificação

Faça mudanças pequenas e mantenha `README.md`, o exemplo e o guia Debian alinhados quando contratos ou comandos mudarem. Para mudanças no servidor/API, amplie o teste integrado com um cenário observável, depois execute `npm test` nos modos padrão e LAN. Verifique sintaxe com `node --check src/server.js` e, ao alterar a interface, `node --check src/portal/app.js`. Execute Docker quando estiver disponível; caso contrário, declare claramente que o contêiner não foi testado. Antes de enviar ao GitHub, confira `git status`, arquivos staged e resultados dos testes. Não use force push e não inclua o volume de dados nem o `.env` local.
