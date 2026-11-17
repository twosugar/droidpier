---
title: Telefoni
description: Usa un telefono Android via USB nella pagina - cosa serve, come passare al telefono e cosa funziona in modo diverso rispetto a un emulatore.
sourceHash: ebd5c708ed2b
---

Oltre ai dispositivi virtuali Android, la pagina può mostrare un vero telefono Android collegato al tuo Mac con un cavo USB. La pagina mostra comunque un dispositivo alla volta: il telefono o un emulatore.

## Cosa ti serve

- Un cavo USB che trasporti dati, non solo corrente.
- Android 5.0 (API 21) o successivo. È quanto richiede il server scrcpy incluso.
- Il debug USB attivato nelle opzioni sviluppatore del telefono.
- La prima volta che colleghi il telefono, ti chiede se consentire il debug USB da questo Mac. Consentilo.
- `platform-tools` (`adb`) sul Mac. Un telefono non ha bisogno né dell’emulatore né di un’immagine di sistema. Vedi [Requisiti](/it/docs/getting-started/requirements/).

## L’elenco dei telefoni

I telefoni compaiono in un gruppo a parte nell’elenco dei dispositivi, sotto i dispositivi virtuali. Ogni riga mostra il produttore e il modello del telefono, la sua versione di Android e il suo stato:

- **Pronto**: fai clic sulla riga per passare al telefono.
- **Non autorizzato**: il telefono non ha ancora autorizzato questo Mac. Consenti il debug USB sul telefono.
- **Offline**: adb vede il telefono ma non riesce a comunicare con esso. Scollegalo e ricollegalo.

Se non è collegato nessun telefono, il gruppo invita a collegarne uno e ad attivare il debug USB.

## Passare a un telefono

Collegare un telefono non fa passare la pagina a esso: magari lo stai solo ricaricando. Fai clic sul telefono nell’elenco per passare a esso. Il gateway copia allora il server scrcpy sul telefono tramite adb e lo avvia. Il server trasmette lo schermo e riceve l’input. Si elimina da solo dal telefono quando la connessione termina, e sul telefono non resta installato nulla.

Finché la pagina mostra il telefono, il suo schermo resta acceso.

## Cosa funziona

La pagina funziona con un telefono come con un emulatore:

- lo schermo, scalato in modo che il lato lungo misuri al massimo 1920 pixel;
- clic e trascinamento, scorrimento con rotellina e trackpad (inviato al telefono come veri eventi di scorrimento) e digitazione, anche in cinese (il cinese e altro testo non ASCII richiedono Android 7.0 o successivo);
- gli appunti in entrambe le direzioni;
- Indietro, Home, App recenti, volume e accensione;
- gli screenshot, alla piena risoluzione del telefono;
- l’installazione di un APK o la copia di un file trascinandolo sullo schermo;
- il debug H5 delle pagine WebView;
- il pannello dei log;
- gli strumenti di IA nel browser.

## Cosa è diverso

- **La rotazione** segue il telefono stesso. Non c’è un pulsante di rotazione.
- **Non c’è un pulsante di arresto**: la pagina non può spegnere un telefono.
- **Riavvia** riavvia il telefono dopo la tua conferma. La pagina indica che il telefono si sta riavviando, poi si riconnette da sola quando il telefono è avviato, di solito entro un minuto. Se il telefono ha una schermata di blocco, sbloccalo nella pagina.
- **Scollegare** il telefono fa indicare alla pagina che il telefono è disconnesso. Ricollegalo e la pagina si riconnette da sola.
- **La riga di stato** mostra la frequenza dei frame ma non la latenza. L’orologio del telefono differisce da quello del Mac, quindi i due non si possono confrontare.

## Solo telefoni, nessun emulatore

Il controllo della configurazione nella pagina continua a elencare l’emulatore e un’immagine di sistema quando mancano. Se usi solo telefoni, ti serve solo `platform-tools`: installalo e chiudi la scheda di configurazione.
