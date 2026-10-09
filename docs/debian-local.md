# Testar em um servidor Debian local

Este procedimento mantém o serviço disponível apenas na própria máquina Debian. Para abrir o portal em outro computador da rede, use um túnel SSH temporário. Nenhum IP ou nome do servidor é gravado no repositório.

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

O último comando deve retornar `{"ok":true}`. O `compose.yaml` publica `127.0.0.1:8080:8080`; por isso, o portal não fica diretamente exposto na rede.

## 3. Abrir de outro computador

No computador onde está o navegador, abra um terminal e mantenha este comando em execução:

```bash
ssh -N -L 8080:127.0.0.1:8080 USUARIO@IP_DO_DEBIAN
```

Substitua `USUARIO` e `IP_DO_DEBIAN` somente no comando. Depois, abra **http://localhost:8080** no navegador desse computador. As URLs das aplicações usam `<id>.localhost:8080` e passam pelo mesmo túnel. Ao fechar o terminal ou interromper o comando, o acesso remoto termina.

Se estiver navegando diretamente no Debian, abra `http://localhost:8080` sem túnel.

No primeiro acesso, crie a senha de proprietário. Cadastre um JSON, copie a chave de acesso exibida e, depois, publique um ZIP do site sem o JSON e sem a chave.

## 4. Verificar, atualizar e parar

Execute estes comandos na pasta `Super_SandBox` do Debian:

```bash
sudo docker compose logs -f super-sandbox
```

Pressione `Ctrl+C` para sair dos logs sem parar o serviço. Para atualizar o código:

```bash
git pull --ff-only
sudo docker compose up --build -d
```

Para parar os contêineres mantendo bancos, chaves e senha:

```bash
sudo docker compose down
```

Não use `down -v` se quiser preservar esses dados: essa opção apaga o volume.
