---
title: Linha de comando
description: Opções e variáveis de ambiente do comando do gateway Droidpier.
sourceHash: 90409d583761
---

<!-- verify: phase 3 -->
```sh
droidpier start [--port <port>] [--local] [--no-open] [--no-auto-update]
droidpier stop
droidpier status
droidpier logs
droidpier [--port <port>] [--local] [--no-open]
```

| Comando | Efeito |
|---|---|
| `droidpier start` | Roda o gateway em segundo plano, como LaunchAgent do macOS. Continua rodando depois que você fecha o Terminal, inicia no login e reinicia se travar. Se já estiver rodando, reinicia. Salva as opções que você passar; sem opções, mantém as salvas. Abre a página uma vez, a menos que você passe `--no-open`. Ele também se mantém atualizado: veja [Atualizações automáticas](#automatic-updates). |
| `droidpier stop` | Para o gateway em segundo plano. Ele não inicia mais no login. |
| `droidpier status` | Mostra se o gateway em segundo plano está rodando, com ID do processo, porta, versão e arquivo de log. Também mostra se as atualizações automáticas estão ativadas e o resultado da última verificação. |
| `droidpier logs` | Imprime o caminho do arquivo de log e as últimas 50 linhas. |
| `droidpier` | Roda o gateway nesta janela do Terminal até você pressionar `Ctrl+C`. |

Parar o gateway não para os emuladores em execução.

## Inicie com o comando de instalação {#start-with-the-install-command}

O comando de instalação, `curl -fsSL https://droid.devpier.dev/install.sh | sh`, instala ou atualiza o gateway e depois executa `droidpier start`. Para passar opções, coloque-as depois de `sh -s --`. Elas ficam salvas para o gateway em segundo plano:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | sh -s -- --port 7310
```

Para instalar ou atualizar sem iniciar o gateway, defina `DROIDPIER_NO_START=1`:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | DROIDPIER_NO_START=1 sh
```

Para rodar o gateway na janela do Terminal, como antes, defina `DROIDPIER_FOREGROUND=1`:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | DROIDPIER_FOREGROUND=1 sh
```

## Opções

| Opção | Padrão | Efeito |
|---|---|---|
| `--port <port>` | `7300` | A porta em que o gateway escuta, apenas em `127.0.0.1`. |

<!-- verify: phase 3 -->
| Opção | Padrão | Efeito |
|---|---|---|
| `--local` | desativado | Abre a página que o próprio gateway serve, `http://127.0.0.1:<port>/app/`, em vez da página pública em `droid.devpier.dev`. |
| `--no-open` | desativado | Não abre o navegador ao iniciar. O gateway ainda mostra o endereço. |
| `--no-auto-update` | desativado | Com `droidpier start`: não atualiza automaticamente o gateway em segundo plano. No Terminal: não mostra aviso quando há uma versão nova. |

Com ou sem `--no-open`, a página encontra o gateway sozinha. Veja [Primeira execução](/pt-br/docs/getting-started/first-run/#3-open-the-page).

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `ANDROID_HOME` | O diretório do Android SDK. Sem ela, o gateway usa `~/Library/Android/sdk`. |
| `ANDROID_AVD_HOME` | O diretório que contém os AVDs. Sem ela, o gateway usa `avd` dentro de `ANDROID_USER_HOME` quando ele contém AVDs; caso contrário, `~/.android/avd`. O gateway passa o resultado para os emuladores que inicia. |
| `ANDROID_USER_HOME` | O diretório de usuário do Android. Sem ela, o gateway usa `~/.android`. |
| `DEBUG=1` | Mostra uma linha por segundo para cada conexão: quadros recebidos, enviados e descartados, tamanho médio do quadro e o atraso do emulador até o gateway. |

<!-- verify: phase 2 -->
`ANDROID_AVD_HOME` é lida quando o gateway lista os dispositivos.

<!-- verify: phase 3 -->
`ANDROID_HOME` é lida pela verificação da primeira execução.

Quando `ANDROID_HOME`, `ANDROID_AVD_HOME` e `ANDROID_USER_HOME` estão definidas, `droidpier start` as salva para o gateway em segundo plano, porque o launchd não lê o perfil do seu shell. Execute `droidpier start` de novo depois de alterá-las.

## O que ele mostra

Ao iniciar, o gateway mostra o endereço da página. Se nenhum emulador estiver em execução, ele mostra o motivo e continua rodando.

<!-- verify: phase 3 -->
Por padrão, o endereço mostrado é a página pública, `https://droid.devpier.dev/app/`. Quando o gateway não está rodando na porta `7300`, o endereço termina em `#port=<port>`. Com `--local`, é a página local, `http://127.0.0.1:<port>/app/`. O gateway abre o endereço com o comando `open` do macOS, a menos que você passe `--no-open`.

Se já há um gateway rodando na porta, um segundo não inicia. Ele informa que o droidpier já está rodando, com a porta, e abre a página. Se o que está rodando é o gateway em segundo plano, também mostra `droidpier stop`. Se outro programa usa a porta, ele avisa, sugere outra porta e sai.

<!-- verify: phase 3 -->
Quando faltam partes do Android SDK, o gateway lista cada uma com um comando para instalá-la manualmente e pede que você termine a configuração na página. Ele nunca pergunta nada no Terminal: instalações, novos dispositivos e licenças são confirmados na página. Veja [Primeira execução](/pt-br/docs/getting-started/first-run/#2-let-it-check-your-android-sdk).

## Arquivos e portas que ele usa

| O quê | Onde |
|---|---|
| Endereço de escuta do gateway | `127.0.0.1:<port>` |
| Descoberta de emuladores em execução | `~/Library/Caches/TemporaryItems/avd/running/pid_<pid>.ini` |

<!-- verify: phase 2 -->
| O quê | Onde |
|---|---|
| Portas gRPC do emulador que ele atribui | A primeira porta par livre a partir de `8554` |

<!-- verify: phase 3 -->
| O quê | Onde |
|---|---|
| Executável instalado | `~/.local/bin/droidpier` |
| Checksum da versão instalada | `~/.local/share/droidpier/installed.sha256` |
| Configuração do gateway em segundo plano | `~/Library/LaunchAgents/dev.devpier.droidpier.plist` |
| Log do gateway em segundo plano | `~/Library/Logs/Droidpier/droidpier.log` |

## Atualizações automáticas {#automatic-updates}

O gateway em segundo plano se mantém atualizado. Ao iniciar, e depois a cada 30 minutos aproximadamente, ele compara o checksum da versão publicada com o da versão instalada (`~/.local/share/droidpier/installed.sha256`). Quando uma versão nova é publicada, ele a baixa de `droid.devpier.dev`, confere o checksum antes de descompactar, substitui `~/.local/bin/droidpier` e reinicia. As páginas abertas se reconectam sozinhas. Ele espera enquanto houver em andamento uma instalação do SDK, a inicialização de um dispositivo, a exclusão de um dispositivo, a reinicialização do emulador ou uma transferência de arquivo. Se o download falhar ou o checksum não bater, ele continua rodando a versão que você tem e tenta de novo mais tarde. Cada etapa fica no log (`droidpier logs`).

Quando a página percebe que o gateway em segundo plano é mais antigo que ela, pede que ele verifique na hora e mostra que o gateway está sendo atualizado.

Para desativar as atualizações automáticas, execute `droidpier start --no-auto-update`. Para ativá-las de novo, execute `droidpier start` com suas outras opções e sem `--no-auto-update`, por exemplo `droidpier start --port 7300`. `droidpier status` mostra se estão ativadas.

Um gateway rodando em uma janela do Terminal (`droidpier`) não se substitui. Quando há uma versão nova, ele mostra uma linha: execute `droidpier start` para passar para o gateway em segundo plano, que se atualiza sozinho, ou execute o comando de instalação de novo.

## Desinstalar {#uninstall}

Pare o gateway em segundo plano e depois apague os arquivos que ele usa:

```sh
droidpier stop
rm ~/.local/bin/droidpier
rm -r ~/.local/share/droidpier ~/Library/Logs/Droidpier
```

Se `droidpier` já foi apagado, mas o gateway em segundo plano ainda roda ou inicia no login, remova-o manualmente:

```sh
launchctl bootout gui/$(id -u)/dev.devpier.droidpier
rm ~/Library/LaunchAgents/dev.devpier.droidpier.plist
```
