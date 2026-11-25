---
title: KI-Clients (MCP)
description: Lässt einen KI-Client wie Claude Code die H5-Seiten des Geräts, das die Seite zeigt, über den MCP-Server des Gateways debuggen.
sourceHash: 841858735b29
---

`droidpier mcp` verbindet einen KI-Client, der das Model Context Protocol (MCP) spricht, wie Claude Code, mit dem Gateway. Der Client kann dann das Gerät ansehen, das die Seite zeigt: seine H5-Seiten auflisten, JavaScript darin ausführen, die Konsole lesen und einen Screenshot machen.

Der Client geht durch das Gateway, anstatt eine eigene Debug-Verbindung zu öffnen. Das ist bei iOS-Simulatoren wichtig: WebKit erlaubt nur einem Debugger gleichzeitig, sich an eine Seite anzuhängen, sodass ein separates Tool (wie iwdp) und die H5-Konsole der Seite sich gegenseitig verdrängen. Über das Gateway teilen sich der KI-Client und die H5-Konsole eine einzige Verbindung.

## Was Sie brauchen {#what-you-need}

- Das Gateway läuft, im Hintergrund (`droidpier start`) oder in einem Terminal-Fenster. Das Hintergrund-Gateway aktualisiert sich selbst; MCP benötigt eine am 2026-11-24 oder später veröffentlichte Version. Führen Sie den Installationsbefehl erneut aus, um ein im Terminal-Fenster laufendes Gateway zu aktualisieren.
- Die Seite ist geöffnet und zeigt das Gerät, das der Client verwenden soll.

## Zu Ihrem Client hinzufügen {#add-it-to-your-client}

In Claude Code, einmalig hinzufügen:

```sh
claude mcp add droidpier -- droidpier mcp
```

Starten Sie danach eine neue Claude Code-Sitzung: Die Tools erscheinen als `mcp__droidpier__…`.

Andere Clients verwenden einen Server, der als Befehl läuft und über Standardeingabe und -ausgabe kommuniziert. Geben Sie den vollständigen Pfad der ausführbaren Datei an, da eine aus dem Dock gestartete App möglicherweise kein `~/.local/bin` in ihrem `PATH` hat:

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<Sie>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

Wenn das Gateway auf einem anderen Port läuft, fügen Sie ihn hinzu: `droidpier mcp --port 7310`.

## Die Tools {#the-tools}

| Tool | Funktion |
|---|---|
| `device_status` | Das Gerät, das die Seite zeigt: Name, Plattform (`android` oder `ios`), Art und Bildschirmgröße in Pixeln. |
| `list_pages` | Die H5-Seiten auf diesem Gerät, jede mit einem `page`-Wert, Titel, Adresse, App und ob sie im Vordergrund ist. |
| `evaluate` | Führt einen JavaScript-Ausdruck in einer Seite aus und gibt das Ergebnis als JSON zurück. Wartet auf ein Promise. Wenn der Ausdruck einen Fehler wirft, schlägt das Tool mit dem Fehler fehl. |
| `console_logs` | Die Konsolenausgabe und nicht abgefangenen Fehler einer Seite. Die Sammlung beginnt, wenn ein Tool die Seite zum ersten Mal verwendet; auf iOS-Simulatoren enthält es auch zuvor protokollierte Meldungen. Es behält die letzten 500. Übergeben Sie den `next`-Wert der vorherigen Antwort als `since`, um nur neue Zeilen zu erhalten. |
| `screenshot` | Der Gerätebildschirm als PNG-Bild. |

`evaluate` und `console_logs` verwenden den `page`-Wert aus `list_pages`. Ohne ihn verwenden sie die Seite im Vordergrund; wenn mehrere Seiten im Vordergrund sind, schlagen sie fehl und listen die auswählbaren Seiten auf.

## Welches Gerät und welche Seiten {#which-device-and-which-pages}

Die Tools verwenden immer das Gerät, das die Seite zeigt. Um ein anderes Gerät zu verwenden, wechseln Sie in der Seite dazu. Ohne geöffnete Seite verwenden sie das Gerät, mit dem sich das Gateway zuletzt verbunden hat, und zeigen an, wenn keines vorhanden ist.

Die Seiten sind die, die das Gerät einem Debugger sehen lässt:

- Auf Android-Emulatoren und Telefonen: Chrome-Tabs und WebViews von Apps, die WebView-Debugging aktivieren.
- Auf iOS-Simulatoren: Safari-Tabs und `WKWebView`s, die `isInspectable` setzen (iOS 16.4 und neuer).

## Neben der H5-Konsole verwenden {#using-it-next-to-the-h5-console}

Der KI-Client und die H5-Konsole der Seite können dieselbe Seite gleichzeitig debuggen. Was der Client protokolliert, erscheint auch in der H5-Konsole.

Wenn Sie die H5-Konsole auf einer iOS-Simulator-Seite öffnen oder schließen, die der Client ebenfalls verwendet, öffnet das Gateway die Debug-Verbindung der Seite erneut, damit die Konsole sauber startet und nichts zurücklässt (z. B. eine Pause vor dem nächsten Seitenaufruf). Ein in diesem Moment laufender Tool-Aufruf schlägt fehl; der Client kann ihn erneut ausführen.

Wenn das Gateway neu startet, z. B. um sich zu aktualisieren, läuft `droidpier mcp` weiter und verbindet sich wieder, sobald das Gateway zurück ist, bis zu einer Minute. Ein in diesem Moment laufender Aufruf schlägt fehl.

## Sicherheit {#security}

`droidpier mcp` erreicht das Gateway über einen Unix-Socket, `~/Library/Application Support/Droidpier/mcp-<port>.sock`. Nur Ihr macOS-Benutzer kann seinen Ordner öffnen. Das Gateway öffnet dafür keinen Netzwerkport, und Webseiten können ihn nicht erreichen.

Jedes Programm, das als Ihr Benutzer läuft, kann den Socket verwenden, genau wie es selbst `adb` oder `simctl` ausführen könnte. Ein Client mit diesen Tools kann beliebiges JavaScript in den H5-Seiten Ihrer Geräte ausführen, auch auf Seiten, bei denen Sie angemeldet sind. Erlauben Sie die Tools in Ihrem Client so, wie Sie andere Tools erlauben, die Code ausführen.

Weitere Informationen zum Gateway finden Sie unter [Sicherheit](/de/docs/reference/security/).

## Fehlerbehebung {#troubleshooting}

| Problem | Was zu tun ist |
|---|---|
| `droidpier mcp` beendet sich, weil das Gateway nicht läuft | Starten Sie das Gateway mit `droidpier start`, und verbinden Sie den Client dann erneut. |
| Die Tools sagen, kein Gerät ist verbunden | Öffnen Sie die Seite und wechseln Sie zu einem Gerät. |
| Ein Tool kann eine Seite nicht finden | Führen Sie `list_pages` erneut aus: Seiten kommen und gehen, wenn Apps sie öffnen und schließen. |
| Ein Tool überschreitet die Zeit bei einer iOS-Seite | Die Seite ist möglicherweise im Debugger pausiert, z. B. an einem Haltepunkt in der H5-Konsole. Setzen Sie sie dort fort. |
