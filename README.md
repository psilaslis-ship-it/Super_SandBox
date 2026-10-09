# Super Sandbox

Portal Docker local para cadastrar bancos JSON e publicar sites HTML/CSS/JavaScript em momentos separados. Os arquivos ficam em um volume persistente.

## Iniciar

```sh
docker compose up --build -d
```

Abra **http://localhost:8080**. No primeiro acesso, crie uma senha de proprietário com pelo menos 12 caracteres. Ela protege o cadastro dos bancos, a emissão e revogação das chaves e o envio dos sites. A porta é publicada apenas em `127.0.0.1`, portanto o serviço fica acessível na própria máquina.

O volume `sandbox_data` preserva os dados após reiniciar ou recriar o contêiner. `docker compose down -v` remove o volume, inclusive a senha e todos os JSONs.

Para testar em um Debian na sua rede, siga o [guia de implantação local](docs/debian-local.md). O endereço do servidor não fica salvo no projeto; o acesso de outro computador usa um túnel SSH temporário.

## Fluxo

1. Cadastre um arquivo `.json` no portal. O portal mostra o endereço do banco e uma chave inicial de leitura e gravação. **A chave é mostrada somente naquele momento.**
2. Escolha o banco na seção de integração e copie a instrução para o Claude Code. Ela inclui o endereço do banco, sem incluir a chave.
3. Teste a aplicação localmente: ela deve pedir a chave ao usuário durante a execução e acessar o banco por HTTP. O JSON não precisa estar na pasta da aplicação.
4. Quando o site estiver pronto, envie um ZIP com HTML e os demais recursos. O ZIP deve conter a referência ao endereço do banco e **não** deve conter `db_global` nem a chave. O portal retorna uma URL para o site.

O proprietário pode criar chaves distintas para cada pessoa ou dispositivo, com permissão de leitura ou de leitura e gravação, e revogá-las. Uma chave dá acesso somente ao banco ao qual pertence. Quem tiver uma chave válida pode acessar esse banco; cuide dela como uma senha. Como a aplicação executa JavaScript no navegador, use somente código em que você confia e não embuta a chave em seus arquivos.

## API do banco

O endereço de cada banco tem o formato `http://localhost:8080/api/db-access/<id>`. Ele aparece no portal. A API aceita chamadas vindas de aplicações abertas por `file://`, de um servidor local ou da URL publicada; a autorização depende da chave, não da origem do navegador.

| Operação | Requisição | Resposta |
| --- | --- | --- |
| Ler | `GET`, cabeçalho `Authorization: Bearer <chave>` | JSON atual e cabeçalho `ETag` |
| Salvar | `PUT`, cabeçalhos `Authorization`, `Content-Type: application/json` e `If-Match: <ETag>`; corpo com o JSON completo | Confirmação e novo `ETag` |

Antes de salvar, leia o banco e guarde seu `ETag`. Se outra pessoa o alterar, o `PUT` retorna **409**: recarregue e resolva o conflito. Chave inválida ou revogada retorna **401**; uma chave somente de leitura recebe **403** ao tentar salvar. O limite do JSON é 10 MB. As gravações são atômicas no volume Docker.

O exemplo em `examples/contador` pede o endereço e a chave em tempo de execução. Para criar seu ZIP de site no PowerShell:

```powershell
Compress-Archive -Path examples/contador/* -DestinationPath contador.zip -Force
```

## ZIP do site

O ZIP deve ter pelo menos um HTML, pode conter outros HTMLs e pastas, e pode ter um único diretório envolvendo o site. `index.html` é usado como entrada quando existe. O portal preserva os arquivos enviados. Limites: ZIP de 50 MB, conteúdo descompactado de 250 MB e 2.000 entradas. Links simbólicos e caminhos que escapem do ZIP são rejeitados. Inclua no ZIP scripts, estilos, fontes e outros recursos necessários; referências a CDNs ou APIs externas continuam dependências do site.

Cada site recebe uma URL `http://<id>.localhost:8080/`, isolada da origem do portal e dos demais sites. Navegadores atuais reconhecem `.localhost` como endereço local. Se publicar em outro domínio, configure `PUBLIC_BASE_DOMAIN`, `PUBLIC_SCHEME` e `PUBLIC_PORT`, além do DNS e da porta. Use HTTPS ao disponibilizar o serviço para outras máquinas, pois a chave de acesso viaja no cabeçalho HTTP.

## Desenvolvimento e testes

Com Node.js 22 ou superior:

```sh
npm ci
npm start
npm test
```

Os testes integrados verificam a senha do proprietário, upload separado, chaves, permissões, revogação, CORS para a aplicação local, controle de conflitos, ZIP do site e persistência após reinício. Docker não é necessário para executar os testes Node.js.
