---
title: Befehlszeile
description: Optionen und Umgebungsvariablen für den Befehl des Droidpier-Gateways.
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

| Befehl | Wirkung |
|---|---|
| `droidpier start` | Führt das Gateway als macOS-LaunchAgent im Hintergrund aus. Es läuft nach dem Schließen des Terminals weiter, startet bei der Anmeldung und wird nach einem Absturz neu gestartet. Läuft es bereits, wird es neu gestartet. Angegebene Optionen werden gespeichert; ohne Optionen bleiben die gespeicherten. Öffnet die Seite einmal, außer mit `--no-open`. Außerdem hält es sich selbst aktuell: siehe [Automatische Updates](#automatic-updates). |
| `droidpier stop` | Stoppt das Gateway im Hintergrund. Es startet bei der Anmeldung nicht mehr. |
| `droidpier status` | Zeigt, ob das Gateway im Hintergrund läuft, mit Prozess-ID, Port, Version und Logdatei. Außerdem zeigt es, ob automatische Updates aktiv sind, mit dem Ergebnis der letzten Prüfung. |
| `droidpier logs` | Gibt den Pfad der Logdatei und ihre letzten 50 Zeilen aus. |
| `droidpier` | Führt das Gateway in diesem Terminal-Fenster aus, bis Sie `Ctrl+C` drücken. |

Das Stoppen des Gateways stoppt laufende Emulatoren nicht.

## Mit dem Installationsbefehl starten {#start-with-the-install-command}

Der Installationsbefehl `curl -fsSL https://droid.devpier.dev/install.sh | sh` installiert oder aktualisiert das Gateway und führt dann `droidpier start` aus. Optionen dafür schreiben Sie hinter `sh -s --`. Sie werden für das Gateway im Hintergrund gespeichert:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | sh -s -- --port 7310
```

Um nur zu installieren oder zu aktualisieren, ohne das Gateway zu starten, setzen Sie `DROIDPIER_NO_START=1`:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | DROIDPIER_NO_START=1 sh
```

Um das Gateway wie früher im Terminal-Fenster auszuführen, setzen Sie `DROIDPIER_FOREGROUND=1`:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | DROIDPIER_FOREGROUND=1 sh
```

## Optionen

| Option | Standard | Wirkung |
|---|---|---|
| `--port <port>` | `7300` | Der Port, auf dem das Gateway lauscht, nur auf `127.0.0.1`. |

<!-- verify: phase 3 -->
| Option | Standard | Wirkung |
|---|---|---|
| `--local` | aus | Die Seite öffnen, die das Gateway selbst bereitstellt, `http://127.0.0.1:<port>/app/`, statt der öffentlichen Seite auf `droid.devpier.dev`. |
| `--no-open` | aus | Beim Start keinen Browser öffnen. Das Gateway gibt die Adresse trotzdem aus. |
| `--no-auto-update` | aus | Für `droidpier start`: das Gateway im Hintergrund nicht automatisch aktualisieren. Im Terminal: keine Zeile ausgeben, wenn es eine neue Version gibt. |

Mit oder ohne `--no-open` findet die Seite das Gateway von selbst. Siehe [Erster Start](/de/docs/getting-started/first-run/#3-open-the-page).

## Umgebungsvariablen

| Variable | Wirkung |
|---|---|
| `ANDROID_HOME` | Das Verzeichnis des Android SDK. Ohne sie verwendet das Gateway `~/Library/Android/sdk`. |
| `ANDROID_AVD_HOME` | Das Verzeichnis, das die AVDs enthält. Ohne sie verwendet das Gateway `avd` in `ANDROID_USER_HOME`, wenn dort AVDs liegen, sonst `~/.android/avd`. Das Gateway gibt das Ergebnis an die Emulatoren weiter, die es startet. |
| `ANDROID_USER_HOME` | Das Android-Benutzerverzeichnis. Ohne sie verwendet das Gateway `~/.android`. |
| `DEBUG=1` | Gibt pro Sekunde eine Zeile für jede Verbindung aus: empfangene, gesendete und verworfene Frames, durchschnittliche Frame-Größe und die Verzögerung vom Emulator zum Gateway. |

<!-- verify: phase 2 -->
`ANDROID_AVD_HOME` wird gelesen, wenn das Gateway Geräte auflistet.

<!-- verify: phase 3 -->
`ANDROID_HOME` wird von der Prüfung beim ersten Start gelesen.

Sind `ANDROID_HOME`, `ANDROID_AVD_HOME` und `ANDROID_USER_HOME` gesetzt, speichert `droidpier start` sie für das Gateway im Hintergrund, denn launchd liest Ihr Shell-Profil nicht. Führen Sie `droidpier start` erneut aus, nachdem Sie sie geändert haben.

## Was es ausgibt

Beim Start gibt das Gateway die Adresse der Seite aus. Wenn kein Emulator läuft, gibt es den Grund aus und läuft weiter.

<!-- verify: phase 3 -->
Standardmäßig ist die ausgegebene Adresse die öffentliche Seite, `https://droid.devpier.dev/app/`. Wenn das Gateway nicht auf Port `7300` läuft, endet die Adresse auf `#port=<port>`. Mit `--local` ist es die lokale Seite, `http://127.0.0.1:<port>/app/`. Das Gateway öffnet die Adresse mit dem macOS-Befehl `open`, es sei denn, Sie übergeben `--no-open`.

Läuft auf dem Port bereits ein Gateway, startet kein zweites. Es meldet, dass droidpier bereits läuft, mit dem Port, und öffnet die Seite. Ist das laufende das Gateway im Hintergrund, gibt es auch `droidpier stop` aus. Belegt ein anderes Programm den Port, meldet es das, schlägt einen anderen Port vor und beendet sich.

<!-- verify: phase 3 -->
Fehlen Teile des Android SDK, listet das Gateway jedes davon mit einem Befehl zur manuellen Installation auf und bittet Sie, die Einrichtung auf der Seite abzuschließen. Im Terminal fragt es nie etwas: Installationen, neue Geräte und Lizenzen bestätigen Sie auf der Seite. Siehe [Erster Start](/de/docs/getting-started/first-run/#2-let-it-check-your-android-sdk).

## Verwendete Dateien und Ports

| Was | Wo |
|---|---|
| Lauschadresse des Gateways | `127.0.0.1:<port>` |
| Erkennung laufender Emulatoren | `~/Library/Caches/TemporaryItems/avd/running/pid_<pid>.ini` |

<!-- verify: phase 2 -->
| Was | Wo |
|---|---|
| Vergebene gRPC-Ports für Emulatoren | Der erste freie gerade Port ab `8554` |

<!-- verify: phase 3 -->
| Was | Wo |
|---|---|
| Installierte ausführbare Datei | `~/.local/bin/droidpier` |
| Prüfsumme der installierten Version | `~/.local/share/droidpier/installed.sha256` |
| Einstellungen des Gateways im Hintergrund | `~/Library/LaunchAgents/dev.devpier.droidpier.plist` |
| Log des Gateways im Hintergrund | `~/Library/Logs/Droidpier/droidpier.log` |

## Automatische Updates {#automatic-updates}

Das Gateway im Hintergrund hält sich selbst aktuell. Beim Start und danach etwa alle 30 Minuten vergleicht es die Prüfsumme der veröffentlichten Version mit der der installierten Version (`~/.local/share/droidpier/installed.sha256`). Ist eine neue Version veröffentlicht, lädt es sie von `droid.devpier.dev` herunter, prüft die Prüfsumme vor dem Entpacken, ersetzt `~/.local/bin/droidpier` und startet neu. Offene Seiten verbinden sich von selbst wieder. Solange eine SDK-Installation, der Start eines Geräts, das Löschen eines Geräts, ein Neustart des Emulators oder eine Dateiübertragung läuft, wartet es. Schlägt der Download fehl oder stimmt die Prüfsumme nicht, läuft die vorhandene Version weiter und es versucht es später erneut. Jeder Schritt steht im Log (`droidpier logs`).

Stellt die Seite fest, dass das Gateway im Hintergrund älter ist als sie selbst, bittet sie es, sofort zu prüfen, und zeigt an, dass das Gateway aktualisiert wird.

Automatische Updates abschalten: `droidpier start --no-auto-update`. Wieder einschalten: `droidpier start` mit Ihren übrigen Optionen und ohne `--no-auto-update` ausführen, zum Beispiel `droidpier start --port 7300`. `droidpier status` zeigt, ob sie aktiv sind.

Ein Gateway, das in einem Terminalfenster läuft (`droidpier`), ersetzt sich nicht selbst. Gibt es eine neue Version, gibt es eine Zeile aus: Führen Sie `droidpier start` aus, um zum Gateway im Hintergrund zu wechseln, das sich selbst aktualisiert, oder führen Sie den Installationsbefehl erneut aus.

## Deinstallieren {#uninstall}

Stoppen Sie das Gateway im Hintergrund und löschen Sie dann die Dateien, die es verwendet:

```sh
droidpier stop
rm ~/.local/bin/droidpier
rm -r ~/.local/share/droidpier ~/Library/Logs/Droidpier
```

Ist `droidpier` bereits gelöscht, läuft das Gateway im Hintergrund aber noch oder startet bei der Anmeldung, entfernen Sie es von Hand:

```sh
launchctl bootout gui/$(id -u)/dev.devpier.droidpier
rm ~/Library/LaunchAgents/dev.devpier.droidpier.plist
```
