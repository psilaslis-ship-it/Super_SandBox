# Super Sandbox

Portal Docker para preparar dados e publicar sites HTML/CSS/JavaScript em momentos separados. O portal oferece dois caminhos para os dados: importar um JSON existente para MySQL ou começar com um banco MySQL vazio. Sites antigos que usam a API de JSON integral continuam funcionando.

## Iniciar

```sh
docker compose up --build -d
```

Abra **http://localhost:8080** e crie uma senha de proprietário com pelo menos 12 caracteres. O Compose sobe o portal e um MySQL 8.4 privado, sem publicar a porta do MySQL. As senhas internas do MySQL são geradas automaticamente no primeiro início e guardadas em `mysql_secrets`. Os dados ficam em `sandbox_data` e `mysql_data`.

Por padrão, as portas 8080 e 8081 são vinculadas a `127.0.0.1`. Para acessar pelo IP do Debian, crie um `.env` local naquele servidor:

```dotenv
BIND_IP=192.168.1.50
PUBLIC_HOST=192.168.1.50
MAX_DATABASES=20
MAX_APPS=20
MAX_JSON_MB=512
```

Substitua o IP pelo IPv4 do Debian. O portal ficará em `http://IP:8080`; cada site receberá um link `http://IP:8081/apps/<id>/`. Veja [docs/debian-local.md](docs/debian-local.md) para o passo a passo. O `.env` é ignorado pelo Git. A configuração de um servidor não vira padrão para os demais.

`docker compose down` preserva os volumes. **`docker compose down -v` apaga as bases, os sites, as chaves e as senhas internas.** Faça cópias dos volumes antes de ações destrutivas.

## Fluxo de uso

1. Em **Prepare seus dados**, escolha **Já tenho meus dados** para importar um JSON ou **Começar do zero** para criar um espaço vazio.
2. O portal entrega uma chave inicial. Chaves adicionais podem ser criadas para cada pessoa ou dispositivo, com leitura ou leitura e gravação. O proprietário autenticado pode consultar, renovar e revogar as chaves.
3. Em **Adapte seu site**, escolha os dados e copie ou baixe as instruções `.md` para o assistente de IA de sua preferência. Para um banco vazio, as instruções pedem também `estrutura.sql`; envie esse arquivo na área de atualização do banco antes de usar as tabelas no site.
4. Teste localmente com a chave solicitada ao usuário no momento da conexão. Depois envie um ZIP com HTML, CSS, JavaScript e recursos locais. O portal retorna o link do site. Sites publicados podem ser apagados para liberar uma vaga da cota.

O ZIP **não deve conter** a chave, o JSON nem a pasta `db_global`. O site deve usar caminhos relativos para seus recursos. O portal não altera o conteúdo dos sites enviados. Sites com dependências externas continuam dependentes delas.

## Dados importados

O importador lê o JSON em fluxo e preserva os valores existentes. Cada propriedade da raiz vira um grupo de dados: arrays geram um registro por item; objetos e valores únicos geram um registro. Arrays ou valores na própria raiz também são aceitos. O portal registra o formato original da raiz e a ordem dos grupos para exportar novamente um JSON equivalente. O download pode refletir edições posteriores feitas pelo site.

O limite de upload é `MAX_JSON_MB` (padrão **512 MB**). Cada item individual pode ter até **16 MB**; o JSON pode conter até **200 grupos** e **1 milhão de itens**. Um objeto profundamente aninhado que exceda 16 MB em um único item precisa ser dividido antes da importação. A API da opção MySQL usa páginas de até 100 itens e gravações por item, para evitar ler e salvar o arquivo inteiro a cada alteração.

Os campos de cada item ficam em uma coluna JSON do MySQL, dentro de tabelas organizadas por banco, grupo e registro. Isso preserva estruturas arbitrárias sem impor uma remodelagem ao site. A melhora de velocidade depende de o site adaptado usar paginação e operações por item; buscas avançadas por campos específicos podem exigir índices adicionais no futuro.

O banco vazio começa sem tabelas; o arquivo `estrutura.sql` define as tabelas que a aplicação usará. Os bancos JSON cadastrados em versões anteriores continuam na modalidade antiga; não há conversão automática nem perda dos arquivos anteriores.

## Arquivos SQL

Cada banco MySQL tem seu próprio espaço de tabelas. Os nomes definidos no SQL são isolados internamente por banco; o arquivo não precisa conhecer prefixos nem credenciais. A área **Atualizar estrutura com arquivo .sql** permite aplicar a estrutura inicial e alterações posteriores. O limite padrão é 5 MB (`MAX_SQL_MB`, entre 1 e 50).

Para proteger os registros, os arquivos aceitam `CREATE TABLE`, `ALTER TABLE ADD COLUMN`, `ALTER TABLE RENAME COLUMN`, adição de índices e remoção de índices. Não aceitam comandos para apagar tabelas, colunas ou registros, trocar tipos existentes, criar usuários ou mudar permissões. Para colunas novas obrigatórias, informe `DEFAULT`. Cada tabela recebe um identificador interno; crie normalmente as colunas de negócio, inclusive uma coluna chamada `id`, sem `PRIMARY KEY` ou `AUTO_INCREMENT`.

As tabelas SQL são acessadas pelo site através da API protegida por chave, nunca com credenciais MySQL no navegador. Bancos importados de JSON continuam com os dados existentes nas coleções atuais; tabelas SQL adicionadas a eles são estruturas separadas e não movem esses registros automaticamente.

## API dos dados MySQL

Cada banco tem um endereço no formato `http://HOST:8080/api/db-access/<id>`. Todas as chamadas exigem `Authorization: Bearer <chave>`. A chave pertence somente a esse banco. O MySQL não é exposto ao navegador; o portal valida a chave e executa as consultas.

| Ação | Método e caminho após o endereço do banco | Corpo ou retorno |
| --- | --- | --- |
| Ver grupos | `GET /collections` | `{ "collections": [{ "id", "name", "kind", "count" }] }` |
| Criar grupo | `POST /collections` | Corpo `{ "name": "Nome" }`; requer chave de gravação |
| Listar itens | `GET /collections/<grupo>/records?limit=100&cursor=<cursor>` | `{ "items": [{ "id", "data", "etag" }], "nextCursor" }`; usar o próximo cursor até vir `null` |
| Criar item | `POST /collections/<grupo>/records` | Corpo com um valor JSON; retorna ID e ETag |
| Ler item | `GET /collections/<grupo>/records/<item>` | Valor em `data` e cabeçalho `ETag` |
| Alterar item | `PUT /collections/<grupo>/records/<item>` | Corpo JSON e `If-Match: <ETag>` |
| Apagar item | `DELETE /collections/<grupo>/records/<item>` | `If-Match: <ETag>` |

Para bancos com tabelas SQL, use `GET /tables` para listar as tabelas e colunas. Leia registros com `GET /tables/<tabela>/rows?limit=100&cursor=<cursor>`, crie com `POST` no mesmo endereço e altere ou apague em `/rows/<id>` com `If-Match`.

As rotas que alteram dados exigem chave de gravação. Conflito de edição retorna `409`; ausência do `If-Match` retorna `428`; chave inválida ou revogada retorna `401` ou `403`. CORS permite abrir o site localmente ou publicado, mas não substitui a autenticação. A chave deve ser solicitada em tempo de execução e mantida apenas em memória. Um site com JavaScript malicioso pode ler qualquer chave digitada nele: publique somente código confiável.

**Bancos JSON antigos** mantêm `GET` e `PUT` no endereço base, com o JSON inteiro e `ETag`/`If-Match`, como antes. O exemplo em `examples/contador` ainda demonstra essa modalidade.

## ZIP e publicação

O ZIP deve conter pelo menos um HTML; pode conter pastas e vários HTMLs. `index.html` é priorizado. Limites: ZIP de 50 MB, conteúdo extraído de 250 MB e até 2.000 entradas. Links simbólicos e caminhos inseguros são rejeitados. No modo local, cada site recebe `http://<id>.localhost:8080/`. No modo LAN, recebe `http://IP:8081/apps/<id>/`. A porta 8081 separa os sites da administração, mas sites publicados nessa porta compartilham a mesma origem entre si. Use apenas sites confiáveis.

Em rede local com HTTP, as chaves trafegam sem criptografia. Para uso contínuo com dados sensíveis, configure HTTPS em um proxy reverso. Não publique a porta 3306 nem as portas do portal diretamente na internet.

## Desenvolvimento

Use Node.js 22 ou superior:

```sh
npm ci
npm test
node --check src/server.js
node --check src/portal/app.js
```

Sem `MYSQL_HOST`, o servidor Node inicia para testes das bases JSON anteriores e as rotas MySQL mostram indisponibilidade. Para testar o fluxo MySQL completo, use `docker compose up --build -d`. O teste Node cobre importação/validação do JSON e os fluxos antigos. O teste `test/mysql-live.test.js` roda contra um MySQL real quando `MYSQL_TEST_HOST`, `MYSQL_TEST_USER`, `MYSQL_TEST_DATABASE` e `MYSQL_TEST_PASSWORD` (ou `MYSQL_TEST_PASSWORD_FILE`) estiverem configurados; ele usa um identificador temporário e apaga seus registros ao terminar.
