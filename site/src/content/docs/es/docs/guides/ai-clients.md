---
title: Clientes de IA (MCP)
description: Permite a un cliente de IA, como Claude Code, depurar las páginas H5 del dispositivo que muestra la página, a través del servidor MCP del gateway.
sourceHash: 841858735b29
---

`droidpier mcp` conecta un cliente de IA que habla el Model Context Protocol (MCP), como Claude Code, al gateway. El cliente puede entonces inspeccionar el dispositivo que muestra la página: listar sus páginas H5, ejecutar JavaScript en una de ellas, leer la consola y tomar una captura de pantalla.

El cliente pasa por el gateway en lugar de abrir su propia conexión de depuración. Esto importa en los simuladores de iOS: WebKit solo permite que un depurador a la vez se adjunte a una página, por lo que una herramienta separada (como iwdp) y la consola H5 de la página se desplazan mutuamente. A través del gateway, el cliente de IA y la consola H5 comparten una sola conexión.

## Lo que necesitas {#what-you-need}

- El gateway en ejecución, en segundo plano (`droidpier start`) o en una ventana de Terminal. El gateway en segundo plano se actualiza solo; MCP necesita una versión publicada el 2026-11-24 o posterior. Ejecuta el comando de instalación de nuevo para actualizar un gateway que se ejecuta en una ventana de Terminal.
- La página abierta, mostrando el dispositivo que quieres que use el cliente.

## Añádelo a tu cliente {#add-it-to-your-client}

En Claude Code, añádelo una sola vez:

```sh
claude mcp add droidpier -- droidpier mcp
```

Inicia una nueva sesión de Claude Code después: las herramientas aparecen como `mcp__droidpier__…`.

Otros clientes usan un servidor que se ejecuta como un comando y se comunica por entrada y salida estándar. Indica la ruta completa del ejecutable, ya que una app iniciada desde el Dock puede no tener `~/.local/bin` en su `PATH`:

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<tú>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

Si el gateway se ejecuta en otro puerto, añádelo: `droidpier mcp --port 7310`.

## Las herramientas {#the-tools}

| Herramienta | Qué hace |
|---|---|
| `device_status` | El dispositivo que muestra la página: nombre, plataforma (`android` o `ios`), tipo y tamaño de pantalla en píxeles. |
| `list_pages` | Las páginas H5 en ese dispositivo, cada una con un valor `page`, título, dirección, app y si está en primer plano. |
| `evaluate` | Ejecuta una expresión JavaScript en una página y devuelve el resultado como JSON. Espera una promesa. Si la expresión lanza un error, la herramienta falla con ese error. |
| `console_logs` | La salida de consola y los errores no capturados de una página. La recopilación comienza la primera vez que una herramienta usa esa página; en simuladores de iOS también incluye los mensajes registrados antes. Conserva los últimos 500. Pasa el valor `next` de la respuesta anterior como `since` para obtener solo las líneas nuevas. |
| `screenshot` | La pantalla del dispositivo, como imagen PNG. |

`evaluate` y `console_logs` usan el valor `page` de `list_pages`. Sin él, usan la página en primer plano; cuando hay varias páginas en primer plano, fallan y listan las páginas para elegir.

## Qué dispositivo y qué páginas {#which-device-and-which-pages}

Las herramientas siempre usan el dispositivo que muestra la página. Para usar otro dispositivo, cambia a él en la página. Sin ninguna página abierta, usan el último dispositivo al que se conectó el gateway, e indican cuando no hay ninguno.

Las páginas son las que el dispositivo permite que un depurador vea:

- En emuladores y teléfonos Android: pestañas de Chrome y WebViews de apps que activan la depuración de WebView.
- En simuladores de iOS: pestañas de Safari y `WKWebView`s que establecen `isInspectable` (iOS 16.4 y posterior).

## Usarlo junto a la consola H5 {#using-it-next-to-the-h5-console}

El cliente de IA y la consola H5 de la página pueden depurar la misma página a la vez. Lo que registra el cliente también aparece en la consola H5.

Cuando abres o cierras la consola H5 en una página del simulador de iOS que el cliente también usa, el gateway reabre la conexión de depuración de la página para que la consola empiece limpia sin dejar nada atrás (como una pausa antes de que cargue la siguiente página). Una llamada de herramienta en ese momento falla; el cliente puede ejecutarla de nuevo.

Cuando el gateway se reinicia, por ejemplo para actualizarse, `droidpier mcp` sigue ejecutándose y se vuelve a conectar cuando el gateway regresa, durante hasta un minuto. Una llamada en ese momento falla.

## Seguridad {#security}

`droidpier mcp` llega al gateway a través de un socket Unix, `~/Library/Application Support/Droidpier/mcp-<port>.sock`. Solo tu usuario de macOS puede abrir su carpeta. El gateway no abre ningún puerto de red para él, y las páginas web no pueden alcanzarlo.

Cualquier programa que se ejecute como tu usuario puede usar el socket, igual que podría ejecutar `adb` o `simctl` directamente. Un cliente con estas herramientas puede ejecutar cualquier JavaScript en las páginas H5 de tus dispositivos, incluidas las páginas en las que has iniciado sesión. Permite las herramientas en tu cliente de la misma manera que permites otras herramientas que ejecutan código.

Consulta [Seguridad](/es/docs/reference/security/) para el resto del gateway.

## Solución de problemas {#troubleshooting}

| Problema | Qué hacer |
|---|---|
| `droidpier mcp` termina porque el gateway no está en ejecución | Inicia el gateway con `droidpier start` y luego vuelve a conectar el cliente. |
| Las herramientas dicen que no hay ningún dispositivo conectado | Abre la página y cambia a un dispositivo. |
| Una herramienta no puede encontrar una página | Ejecuta `list_pages` de nuevo: las páginas aparecen y desaparecen a medida que las apps las abren y cierran. |
| Una herramienta agota el tiempo de espera en una página de iOS | La página puede estar pausada en el depurador, por ejemplo en un punto de interrupción en la consola H5. Reanúdala desde ahí. |
