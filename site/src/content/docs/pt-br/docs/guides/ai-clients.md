---
title: Clientes de IA (MCP)
description: Permite que um cliente de IA, como o Claude Code, depure as páginas H5 no dispositivo que a página mostra, através do servidor MCP do gateway.
sourceHash: 841858735b29
---

`droidpier mcp` conecta um cliente de IA que fala o Model Context Protocol (MCP), como o Claude Code, ao gateway. O cliente pode então inspecionar o dispositivo que a página mostra: listar suas páginas H5, executar JavaScript em uma delas, ler o console e tirar um screenshot.

O cliente passa pelo gateway em vez de abrir sua própria conexão de depuração. Isso importa nos simuladores de iOS: o WebKit permite apenas um depurador por vez conectado a uma página, então uma ferramenta separada (como o iwdp) e o console H5 da página se empurram mutuamente. Pelo gateway, o cliente de IA e o console H5 compartilham uma única conexão.

## O que você precisa {#what-you-need}

- O gateway em execução, em segundo plano (`droidpier start`) ou em uma janela do Terminal. O gateway em segundo plano se atualiza sozinho; o MCP precisa de uma versão publicada em 2026-11-24 ou mais recente. Execute o comando de instalação novamente para atualizar um gateway que roda em uma janela do Terminal.
- A página aberta, mostrando o dispositivo que você quer que o cliente use.

## Adicione ao seu cliente {#add-it-to-your-client}

No Claude Code, adicione uma só vez:

```sh
claude mcp add droidpier -- droidpier mcp
```

Inicie uma nova sessão do Claude Code depois: as ferramentas aparecem como `mcp__droidpier__…`.

Outros clientes usam um servidor que roda como um comando e se comunica via entrada e saída padrão. Forneça o caminho completo do executável, pois um app aberto pelo Dock pode não ter `~/.local/bin` no seu `PATH`:

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<você>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

Se o gateway rodar em outra porta, adicione: `droidpier mcp --port 7310`.

## As ferramentas {#the-tools}

| Ferramenta | O que faz |
|---|---|
| `device_status` | O dispositivo que a página mostra: nome, plataforma (`android` ou `ios`), tipo e tamanho da tela em pixels. |
| `list_pages` | As páginas H5 nesse dispositivo, cada uma com um valor `page`, título, endereço, app e se está em primeiro plano. |
| `evaluate` | Executa uma expressão JavaScript em uma página e retorna o resultado como JSON. Aguarda uma promise. Se a expressão lançar um erro, a ferramenta falha com esse erro. |
| `console_logs` | A saída do console e os erros não capturados de uma página. A coleta começa na primeira vez que uma ferramenta usa essa página; em simuladores de iOS também inclui as mensagens registradas antes. Mantém as últimas 500. Passe o valor `next` da resposta anterior como `since` para obter apenas as novas linhas. |
| `screenshot` | A tela do dispositivo, como imagem PNG. |

`evaluate` e `console_logs` usam o valor `page` de `list_pages`. Sem ele, usam a página em primeiro plano; quando há várias páginas em primeiro plano, falham e listam as páginas para escolher.

## Qual dispositivo e quais páginas {#which-device-and-which-pages}

As ferramentas sempre usam o dispositivo que a página mostra. Para usar outro dispositivo, mude para ele na página. Sem nenhuma página aberta, usam o dispositivo ao qual o gateway se conectou por último, e informam quando não há nenhum.

As páginas são as que o dispositivo permite que um depurador veja:

- Em emuladores e celulares Android: abas do Chrome e WebViews de apps que ativam a depuração de WebView.
- Em simuladores de iOS: abas do Safari e `WKWebView`s que definem `isInspectable` (iOS 16.4 e posterior).

## Usando ao lado do console H5 {#using-it-next-to-the-h5-console}

O cliente de IA e o console H5 da página podem depurar a mesma página ao mesmo tempo. O que o cliente registra também aparece no console H5.

Quando você abre ou fecha o console H5 em uma página do simulador de iOS que o cliente também usa, o gateway reabre a conexão de depuração da página para que o console comece limpo e não deixe nada para trás (como uma pausa antes de a próxima página carregar). Uma chamada de ferramenta em execução nesse momento falha; o cliente pode executá-la novamente.

Quando o gateway reinicia, por exemplo para se atualizar, o `droidpier mcp` continua rodando e se reconecta quando o gateway voltar, por até um minuto. Uma chamada em execução nesse momento falha.

## Segurança {#security}

`droidpier mcp` chega ao gateway por um socket Unix, `~/Library/Application Support/Droidpier/mcp-<port>.sock`. Apenas o seu usuário do macOS pode abrir sua pasta. O gateway não abre nenhuma porta de rede para ele, e páginas web não conseguem alcançá-lo.

Qualquer programa que rode com o seu usuário pode usar o socket, como poderia executar `adb` ou `simctl` diretamente. Um cliente com essas ferramentas pode executar qualquer JavaScript nas páginas H5 dos seus dispositivos, incluindo páginas em que você está autenticado. Permita as ferramentas no seu cliente da mesma forma que permite outras ferramentas que executam código.

Consulte [Segurança](/pt-br/docs/reference/security/) para o restante do gateway.

## Solução de problemas {#troubleshooting}

| Problema | O que fazer |
|---|---|
| `droidpier mcp` encerra porque o gateway não está rodando | Inicie o gateway com `droidpier start` e reconecte o cliente. |
| As ferramentas dizem que nenhum dispositivo está conectado | Abra a página e mude para um dispositivo. |
| Uma ferramenta não consegue encontrar uma página | Execute `list_pages` novamente: páginas aparecem e somem conforme os apps as abrem e fecham. |
| Uma ferramenta atinge o tempo limite em uma página iOS | A página pode estar pausada no depurador, por exemplo em um breakpoint no console H5. Retome-a lá. |
