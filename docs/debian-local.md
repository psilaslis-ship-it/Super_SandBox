# Testar em um servidor Debian na rede local

O modo padrão atende apenas a própria máquina. Para abrir o portal diretamente pelo IP do Debian na rede local, crie um `.env` somente naquele servidor. Nenhum IP ou nome do servidor é gravado no repositório.

## 1. Preparar o Debian

Entre no servidor por SSH. Se Docker Engine e o plugin Compose já funcionam, avance para a etapa 2. Caso contrário, instale os pacotes pelo repositório oficial do Docker:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker compose version
```

Se a instalação acusar conflito com pacotes Docker anteriores, siga a seção de remoção de pacotes conflitantes na [documentação oficial para Debian](https://docs.docker.com/engine/install/debian/). Este guia não troca automaticamente uma instalação Docker existente.

## 2. Baixar e iniciar o projeto

```bash
sudo apt-get update
sudo apt-get install -y git curl
git clone https://github.com/psilaslis-ship-it/Super_SandBox.git
cd Super_SandBox
sudo docker compose up --build -d
sudo docker compose ps
curl -fsS http://127.0.0.1:8080/health
```

O último comando deve retornar `{"ok":true}`. O Compose inicia também o MySQL, sem publicar a porta 3306, e cria senhas internas automaticamente. Sem `.env`, as portas do portal ficam vinculadas a `127.0.0.1`.

## 3. Abrir diretamente pelo IP na rede local

Descubra o IPv4 do Debian na sua rede:

```bash
hostname -I
```

Escolha o endereço da interface usada pelos outros computadores (exemplo: `192.168.1.50`). Na pasta do projeto, crie o `.env` local com esse endereço nos dois campos:

```bash
LAN_IP=192.168.1.50
printf 'BIND_IP=%s\nPUBLIC_HOST=%s\n' "$LAN_IP" "$LAN_IP" > .env
sudo docker compose up --build -d
sudo docker compose ps
curl -fsS "http://$LAN_IP:8080/health"
```

Troque `192.168.1.50` pelo IP real. No navegador de outro computador da mesma rede, abra **`http://IP_DO_DEBIAN:8080`**. O portal retorna URLs dos sites no formato **`http://IP_DO_DEBIAN:8081/apps/<id>/`**. As duas portas precisam estar acessíveis na rede local; não configure redirecionamento delas no roteador para a internet. A porta 8081 separa os sites da origem administrativa. Essa publicação em IP específico segue o mecanismo de [portas do Docker](https://docs.docker.com/engine/network/port-publishing/).

O `.env` está no `.gitignore` e não acompanha `git pull` ou `git push`. Se o IP do Debian mudar, atualize os dois valores e execute `sudo docker compose up -d` novamente. O endereço do banco exibido no portal também passará a usar esse IP. Sites já gerados com `localhost` fixo precisam dessa referência atualizada e de um novo ZIP. No modo LAN, os recursos do site devem usar caminhos relativos, pois ele é servido sob `/apps/<id>/`.

O limite padrão de cada JSON é 512 MB. Para outro limite, acrescente `MAX_JSON_MB=1024` ao `.env` (exemplo para 1 GB) e execute `sudo docker compose up -d`. Os limites de quantidade são `MAX_DATABASES=20` e `MAX_APPS=20`; ajuste os valores no mesmo `.env` se necessário. O limite padrão de arquivos SQL é 5 MB e pode ser ajustado com `MAX_SQL_MB` (entre 1 e 50). Um item individual do JSON importado pode ter até 16 MB. Reserve espaço livre nos volumes para os dados e arquivos temporários da importação.

Se o MySQL reiniciar com `Fatal glibc error: CPU does not support x86-64-v2`, o processador ou a máquina virtual não oferece as instruções exigidas pela imagem padrão. Em uma máquina virtual, configure o modelo de CPU para expor os recursos do processador anfitrião. Apenas para testes locais em hardware antigo, acrescente `MYSQL_IMAGE=mysql:8.4.0-oraclelinux8` ao `.env` e recrie os containers com `sudo docker compose up -d`. Essa imagem é antiga e não recebe atualizações; não a use em produção. Não remova os volumes ao trocar a imagem.

O tráfego HTTP da rede local não é criptografado. Use este modo em uma rede confiável para testes. Para acesso fora dela ou com dados sensíveis, configure HTTPS antes de compartilhar chaves.

## 4. Alternativa: túnel SSH sem abrir portas na rede

Use esta alternativa com o **modo padrão**, sem o `.env` da etapa 3. No computador onde está o navegador, abra um terminal e mantenha este comando em execução:

```bash
ssh -N -L 8080:127.0.0.1:8080 USUARIO@IP_DO_DEBIAN
```

Substitua `USUARIO` e `IP_DO_DEBIAN` somente no comando. Depois, abra **http://localhost:8080** no navegador desse computador. As URLs das aplicações usam `<id>.localhost:8080` e passam pelo mesmo túnel. Ao fechar o terminal ou interromper o comando, o acesso remoto termina.

Se estiver navegando diretamente no Debian, abra `http://localhost:8080` sem túnel.

No primeiro acesso, crie a senha de proprietário. Importe um JSON ou crie um banco vazio, copie a chave exibida e entregue a um assistente de IA de sua preferência as instruções geradas pelo portal. Depois, publique o ZIP do site sem o JSON e sem a chave.

## 5. Verificar, atualizar e parar

Execute estes comandos na pasta `Super_SandBox` do Debian:

```bash
sudo docker compose logs -f super-sandbox
```

Pressione `Ctrl+C` para sair dos logs sem parar o serviço. Para atualizar o código:

```bash
git pull --ff-only
sudo docker compose up --build -d
```

Para parar os contêineres mantendo bancos, sites, chaves e senhas:

```bash
sudo docker compose down
```

Não use `down -v` se quiser preservar esses dados: essa opção apaga os volumes `sandbox_data`, `mysql_data` e `mysql_secrets`.
