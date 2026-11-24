---
title: Client IA (MCP)
description: Consente a un client IA come Claude Code di eseguire il debug delle pagine H5 sul dispositivo mostrato dalla pagina, tramite il server MCP del gateway.
sourceHash: 841858735b29
---

`droidpier mcp` connette un client IA che supporta il Model Context Protocol (MCP), come Claude Code, al gateway. Il client può quindi ispezionare il dispositivo mostrato dalla pagina: elencare le sue pagine H5, eseguire JavaScript in una di esse, leggere la console e fare uno screenshot.

Il client passa attraverso il gateway invece di aprire una propria connessione di debug. Questo è importante nei simulatori iOS: WebKit consente a un solo debugger per volta di collegarsi a una pagina, quindi uno strumento separato (come iwdp) e la console H5 della pagina si escludono a vicenda. Attraverso il gateway, il client IA e la console H5 condividono una sola connessione.

## Cosa serve {#what-you-need}

- Il gateway in esecuzione, in background (`droidpier start`) o in una finestra del Terminale. Il gateway in background si aggiorna da solo; MCP richiede una versione pubblicata il 2026-11-24 o successiva. Esegui di nuovo il comando di installazione per aggiornare un gateway che gira in una finestra del Terminale.
- La pagina aperta, che mostra il dispositivo che vuoi che il client usi.

## Aggiungilo al tuo client {#add-it-to-your-client}

In Claude Code, aggiungilo una sola volta:

```sh
claude mcp add droidpier -- droidpier mcp
```

Avvia poi una nuova sessione di Claude Code: gli strumenti appaiono come `mcp__droidpier__…`.

Gli altri client usano un server che si esegue come comando e comunica tramite input e output standard. Fornisci il percorso completo dell'eseguibile, poiché un'app avviata dal Dock potrebbe non avere `~/.local/bin` nel suo `PATH`:

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<tu>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

Se il gateway gira su un'altra porta, aggiungila: `droidpier mcp --port 7310`.

## Gli strumenti {#the-tools}

| Strumento | Cosa fa |
|---|---|
| `device_status` | Il dispositivo mostrato dalla pagina: nome, piattaforma (`android` o `ios`), tipo e dimensione schermo in pixel. |
| `list_pages` | Le pagine H5 su quel dispositivo, ognuna con un valore `page`, titolo, indirizzo, app e se è in primo piano. |
| `evaluate` | Esegue un'espressione JavaScript in una pagina e restituisce il risultato come JSON. Attende una promise. Se l'espressione genera un errore, lo strumento fallisce con quell'errore. |
| `console_logs` | L'output della console e gli errori non catturati di una pagina. La raccolta inizia la prima volta che uno strumento usa quella pagina; sui simulatori iOS include anche i messaggi registrati in precedenza. Conserva gli ultimi 500. Passa il valore `next` della risposta precedente come `since` per ottenere solo le nuove righe. |
| `screenshot` | Lo schermo del dispositivo, come immagine PNG. |

`evaluate` e `console_logs` usano il valore `page` di `list_pages`. Senza di esso usano la pagina in primo piano; se ci sono più pagine in primo piano, falliscono ed elencano le pagine tra cui scegliere.

## Quale dispositivo e quali pagine {#which-device-and-which-pages}

Gli strumenti usano sempre il dispositivo mostrato dalla pagina. Per usare un altro dispositivo, selezionalo nella pagina. Senza nessuna pagina aperta, usano l'ultimo dispositivo a cui si è connesso il gateway, e lo segnalano quando non ce n'è nessuno.

Le pagine sono quelle che il dispositivo consente a un debugger di vedere:

- Su emulatori e telefoni Android: schede Chrome e WebView di app che abilitano il debug WebView.
- Su simulatori iOS: schede Safari e `WKWebView` che impostano `isInspectable` (iOS 16.4 e successivi).

## Usarlo accanto alla console H5 {#using-it-next-to-the-h5-console}

Il client IA e la console H5 della pagina possono eseguire il debug della stessa pagina contemporaneamente. Ciò che il client registra appare anche nella console H5.

Quando apri o chiudi la console H5 su una pagina del simulatore iOS che il client usa anch'esso, il gateway riapre la connessione di debug della pagina in modo che la console parta pulita senza lasciare nulla indietro (come una pausa prima del caricamento della pagina successiva). Una chiamata a uno strumento in esecuzione in quel momento fallisce; il client può rieseguirla.

Quando il gateway si riavvia, ad esempio per aggiornarsi, `droidpier mcp` continua a girare e si riconnette quando il gateway torna, per un massimo di un minuto. Una chiamata in esecuzione in quel momento fallisce.

## Sicurezza {#security}

`droidpier mcp` raggiunge il gateway tramite un socket Unix, `~/Library/Application Support/Droidpier/mcp-<port>.sock`. Solo il tuo utente macOS può aprire la sua cartella. Il gateway non apre nessuna porta di rete per esso, e le pagine web non possono raggiungerlo.

Qualsiasi programma che gira con il tuo utente può usare il socket, come potrebbe eseguire direttamente `adb` o `simctl`. Un client con questi strumenti può eseguire qualsiasi JavaScript nelle pagine H5 dei tuoi dispositivi, incluse le pagine in cui hai effettuato l'accesso. Abilita gli strumenti nel tuo client nello stesso modo in cui abiliti altri strumenti che eseguono codice.

Vedi [Sicurezza](/it/docs/reference/security/) per il resto del gateway.

## Risoluzione dei problemi {#troubleshooting}

| Problema | Cosa fare |
|---|---|
| `droidpier mcp` termina perché il gateway non è in esecuzione | Avvia il gateway con `droidpier start`, poi riconnetti il client. |
| Gli strumenti dicono che nessun dispositivo è connesso | Apri la pagina e seleziona un dispositivo. |
| Uno strumento non riesce a trovare una pagina | Esegui di nuovo `list_pages`: le pagine compaiono e scompaiono man mano che le app le aprono e chiudono. |
| Uno strumento va in timeout su una pagina iOS | La pagina potrebbe essere in pausa nel debugger, ad esempio a un breakpoint nella console H5. Riprendi l'esecuzione da lì. |
