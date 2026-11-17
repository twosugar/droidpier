---
title: Smartphones
description: Ein Android-Smartphone per USB in der Seite nutzen - was es dafür braucht, wie Sie zu ihm wechseln und was sich gegenüber einem Emulator anders verhält.
sourceHash: ebd5c708ed2b
---

Neben virtuellen Android-Geräten kann die Seite auch ein echtes Android-Smartphone zeigen, das per USB-Kabel an Ihren Mac angeschlossen ist. Die Seite zeigt weiterhin jeweils ein Gerät: das Smartphone oder einen Emulator.

## Was Sie brauchen

- Ein USB-Kabel, das Daten überträgt und nicht nur lädt.
- Android 5.0 (API 21) oder neuer. Das braucht der mitgelieferte scrcpy-Server.
- USB-Debugging, eingeschaltet in den Entwickleroptionen des Smartphones.
- Beim ersten Anschließen fragt das Smartphone, ob USB-Debugging von diesem Mac aus erlaubt sein soll. Erlauben Sie es.
- `platform-tools` (`adb`) auf dem Mac. Ein Smartphone braucht weder den Emulator noch ein Systemabbild. Siehe [Voraussetzungen](/de/docs/getting-started/requirements/).

## Die Smartphone-Liste

Smartphones erscheinen in der Geräteliste in einer eigenen Gruppe unter den virtuellen Geräten. Jede Zeile zeigt Hersteller und Modell des Smartphones, seine Android-Version und seinen Zustand:

- **Bereit**: Klicken Sie auf die Zeile, um zum Smartphone zu wechseln.
- **Nicht autorisiert**: Das Smartphone hat diesen Mac noch nicht zugelassen. Erlauben Sie USB-Debugging auf dem Smartphone.
- **Offline**: adb sieht das Smartphone, kann aber nicht mit ihm kommunizieren. Ziehen Sie das Kabel ab und stecken Sie es wieder ein.

Ist kein Smartphone angeschlossen, fordert die Gruppe dazu auf, eines anzuschließen und USB-Debugging einzuschalten.

## Zu einem Smartphone wechseln

Das Anschließen eines Smartphones schaltet die Seite nicht auf dieses um: Vielleicht laden Sie es nur. Klicken Sie in der Liste auf das Smartphone, um zu wechseln. Das Gateway kopiert dann den scrcpy-Server über adb auf das Smartphone und startet ihn. Der Server überträgt den Bildschirm und nimmt die Eingaben entgegen. Er löscht sich selbst vom Smartphone, wenn die Verbindung endet, und es bleibt nichts auf dem Smartphone installiert.

Solange die Seite das Smartphone zeigt, bleibt dessen Bildschirm eingeschaltet.

## Was funktioniert

Die Seite arbeitet mit einem Smartphone genauso wie mit einem Emulator:

- der Bildschirm, so skaliert, dass seine lange Seite höchstens 1920 Pixel misst;
- Klicken und Ziehen, Scrollen mit Mausrad und Trackpad (als echte Scroll-Ereignisse an das Smartphone gesendet) und Tippen, auch auf Chinesisch (Chinesisch und anderer Nicht-ASCII-Text braucht Android 7.0 oder neuer);
- die Zwischenablage in beide Richtungen;
- Zurück, Startbildschirm, Letzte Apps, Lautstärke und Ein/Aus;
- Screenshots in der vollen Auflösung des Smartphones;
- eine APK installieren oder eine Datei kopieren, indem Sie sie auf den Bildschirm ziehen;
- H5-Debugging von WebView-Seiten;
- das Log-Panel;
- die KI-Werkzeuge im Browser.

## Was anders ist

- **Die Drehung** folgt dem Smartphone selbst. Es gibt keine Drehtaste.
- **Es gibt keine Stopp-Taste**: Die Seite kann ein Smartphone nicht ausschalten.
- **Neustart** startet das Smartphone nach Ihrer Bestätigung neu. Die Seite zeigt an, dass das Smartphone neu startet, und verbindet sich danach von selbst wieder, sobald das Smartphone hochgefahren ist, meist innerhalb einer Minute. Hat das Smartphone eine Displaysperre, entsperren Sie es auf der Seite.
- **Abziehen** des Smartphones zeigt an, dass das Smartphone getrennt ist. Stecken Sie es wieder ein, dann verbindet sich die Seite von selbst wieder.
- **Die Statuszeile** zeigt die Bildrate, aber nicht die Latenz. Die Uhr des Smartphones geht anders als die des Macs, deshalb lassen sich beide nicht vergleichen.

## Nur Smartphones, kein Emulator

Die Einrichtungsprüfung auf der Seite listet den Emulator und ein Systemabbild weiterhin auf, wenn sie fehlen. Wenn Sie nur Smartphones nutzen, brauchen Sie nur `platform-tools`: Installieren Sie es und schließen Sie die Einrichtungskarte.
