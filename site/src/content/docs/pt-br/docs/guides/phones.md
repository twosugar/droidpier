---
title: Celulares
description: Use um celular Android por USB na página - o que ele precisa, como alternar para ele e o que funciona de forma diferente de um emulador.
sourceHash: ebd5c708ed2b
---

Além dos dispositivos virtuais Android, a página pode mostrar um celular Android real conectado ao seu Mac por um cabo USB. A página continua mostrando um dispositivo por vez: o celular ou um emulador.

## O que você precisa

- Um cabo USB que transmita dados, não apenas carga.
- Android 5.0 (API 21) ou posterior. É o que o servidor do scrcpy incluído exige.
- A depuração USB ativada nas opções do desenvolvedor do celular.
- Na primeira vez que você conecta o celular, ele pergunta se permite a depuração USB deste Mac. Permita.
- `platform-tools` (`adb`) no Mac. Um celular não precisa nem do emulador nem de uma imagem de sistema. Veja [Requisitos](/pt-br/docs/getting-started/requirements/).

## A lista de celulares

Os celulares aparecem em um grupo próprio na lista de dispositivos, abaixo dos dispositivos virtuais. Cada linha mostra o fabricante e o modelo do celular, a versão do Android e o estado:

- **Pronto**: clique na linha para alternar para o celular.
- **Não autorizado**: o celular ainda não permitiu este Mac. Permita a depuração USB no celular.
- **Offline**: o adb vê o celular, mas não consegue se comunicar com ele. Desconecte-o e conecte-o de novo.

Sem nenhum celular conectado, o grupo pede que você conecte um e ative a depuração USB.

## Alternar para um celular

Conectar um celular não faz a página alternar para ele: você pode estar apenas carregando-o. Clique no celular na lista para alternar. Em seguida, o gateway copia o servidor do scrcpy para o celular pelo adb e o inicia. O servidor transmite a tela e recebe a entrada. Ele se apaga sozinho do celular quando a conexão termina, e nada fica instalado no celular.

Enquanto a página mostra o celular, a tela dele permanece ligada.

## O que funciona

A página funciona com um celular da mesma forma que com um emulador:

- a tela, redimensionada para que o lado maior tenha no máximo 1920 pixels;
- clicar e arrastar, rolar com a roda e o trackpad (enviado ao celular como eventos de rolagem reais) e digitar, inclusive chinês (chinês e outros textos não ASCII exigem Android 7.0 ou posterior);
- a área de transferência nos dois sentidos;
- Voltar, Início, Recentes, volume e liga/desliga;
- capturas de tela, na resolução total do celular;
- instalar um APK ou copiar um arquivo soltando-o sobre a tela;
- a depuração H5 de páginas WebView;
- o painel de logs;
- as ferramentas de IA no navegador.

## O que é diferente

- **A rotação** acompanha o próprio celular. Não há tecla de girar.
- **Não há tecla de parar**: a página não pode desligar um celular.
- **Reiniciar** reinicia o celular depois que você confirma. A página mostra que o celular está reiniciando e se conecta de novo sozinha quando o celular terminar de inicializar, geralmente em menos de um minuto. Se o celular tiver tela de bloqueio, desbloqueie-o na página.
- **Desconectar** o celular mostra que o celular está desconectado. Conecte-o de novo e a página se conecta novamente sozinha.
- **A linha de status** mostra a taxa de quadros, mas não a latência. O relógio do celular difere do do Mac, então os dois não podem ser comparados.

## Só celulares, sem emulador

A verificação de configuração da página continua listando o emulador e uma imagem de sistema quando eles estão faltando. Se você usa apenas celulares, só precisa do `platform-tools`: instale-o e feche o cartão de configuração.
