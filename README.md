# Super Sandbox

Portal Docker local para cadastrar bancos JSON e publicar sites HTML/CSS/JavaScript em momentos separados. Os arquivos ficam em um volume persistente.

## Iniciar

```sh
docker compose up --build -d
```

Abra **http://localhost:8080**. No primeiro acesso, crie uma senha de proprietário com pelo menos 12 caracteres. Ela protege o cadastro dos bancos, a emissão e revogação das chaves e o envio dos sites. Por padrão, as portas são publicadas apenas em `127.0.0.1`.

Para abrir diretamente pelo IP do Debian na rede local, crie um `.env` **somente naquele servidor**:

```dotenv
BIND_IP=192.168.1.50
PUBLIC_HOST=192.168.1.50
```

Troque o IP pelo endereço real da máquina e reinicie com `docker compose up --build -d`. Acesse `http://IP:8080` para o portal; os sites publicados recebem URLs `http://IP:8081/apps/<id>/`. O arquivo `.env` é ignorado pelo Git. Veja o [guia Debian](docs/debian-local.md) para os comandos completos. A instalação padrão continua vinculada a `127.0.0.1`.

O volume `sandbox_data` preserva os dados após reiniciar ou recriar o contêiner. `docker compose down -v` remove o volume, inclusive a senha e todos os JSONs.

Para testar em um Debian na sua rede, siga o [guia de implantação local](docs/debian-local.md). Ele também explica a alternativa de túnel SSH, que não expõe portas à rede.

## Fluxo

1. Cadastre um arquivo `.json` no portal. O portal mostra o endereço do banco e uma chave inicial de leitura e gravação. **A chave é mostrada somente naquele momento.**
2. Escolha o banco na seção de integração e copie a instrução para o Claude Code. Ela inclui o endereço do banco, sem incluir a chave.
3. Teste a aplicação localmente: ela deve pedir a chave ao usuário durante a execução e acessar o banco por HTTP. O JSON não precisa estar na pasta da aplicação.
4. Quando o site estiver pronto, envie um ZIP com HTML e os demais recursos. O ZIP deve conter a referência ao endereço do banco e **não** deve conter `db_global` nem a chave. O portal retorna uma URL para o site.

O proprietário pode criar chaves distintas para cada pessoa ou dispositivo, com permissão de leitura ou de leitura e gravação, e revogá-las. Uma chave dá acesso somente ao banco ao qual pertence. Quem tiver uma chave válida pode acessar esse banco; cuide dela como uma senha. Como a aplicação executa JavaScript no navegador, use somente código em que você confia e não embuta a chave em seus arquivos.

## API do banco

O endereço de cada banco tem o formato `http://HOST:8080/api/db-access/<id>`, onde `HOST` é `localhost` no modo padrão ou o IP configurado no modo LAN. Ele aparece no portal. A API aceita chamadas vindas de aplicações abertas por `file://`, de um servidor local ou da URL publicada; a autorização depende da chave, não da origem do navegador.

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

No modo padrão, cada site recebe `http://<id>.localhost:8080/`. No modo LAN, recebe `http://IP:8081/apps/<id>/`. A porta 8081 mantém os sites em uma origem diferente da administração; no modo LAN, os sites compartilham essa origem entre si, portanto publique apenas aplicações confiáveis. O prefixo `/apps/<id>/` exige caminhos **relativos** para scripts, estilos, imagens e navegação interna. Referências absolutas começando por `/` precisam ser ajustadas no site antes do upload. Se um site já foi gerado com `localhost` fixo no endereço do banco, atualize essa referência para o endereço exibido no portal e envie um novo ZIP. Em rede local, as chaves viajam por HTTP sem criptografia; use uma rede confiável ou HTTPS para uso contínuo.

## Desenvolvimento e testes

Com Node.js 22 ou superior:

```sh
npm ci
npm start
npm test
```

Os testes integrados verificam a senha do proprietário, upload separado, chaves, permissões, revogação, CORS para a aplicação local, controle de conflitos, ZIP do site e persistência após reinício. Docker não é necessário para executar os testes Node.js.
