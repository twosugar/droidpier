---
title: Teléfonos
description: Usa un teléfono Android por USB en la página - qué necesita, cómo cambiar a él y qué funciona de forma distinta a un emulador.
sourceHash: ebd5c708ed2b
---

Además de los dispositivos virtuales Android, la página puede mostrar un teléfono Android real conectado a tu Mac con un cable USB. La página sigue mostrando un dispositivo a la vez: el teléfono o un emulador.

## Qué necesitas

- Un cable USB que transmita datos, no solo carga.
- Android 5.0 (API 21) o posterior. Es lo que necesita el servidor de scrcpy incluido.
- La depuración por USB activada en las opciones de desarrollador del teléfono.
- La primera vez que conectas el teléfono, este pregunta si permite la depuración por USB desde esta Mac. Permítela.
- `platform-tools` (`adb`) en la Mac. Un teléfono no necesita ni el emulador ni una imagen del sistema. Consulta [Requisitos](/es/docs/getting-started/requirements/).

## La lista de teléfonos

Los teléfonos aparecen en un grupo propio de la lista de dispositivos, debajo de los dispositivos virtuales. Cada fila muestra el fabricante y el modelo del teléfono, su versión de Android y su estado:

- **Listo**: haz clic en la fila para cambiar al teléfono.
- **No autorizado**: el teléfono aún no ha permitido esta Mac. Permite la depuración por USB en el teléfono.
- **Sin conexión**: adb ve el teléfono, pero no puede comunicarse con él. Desconéctalo y vuelve a conectarlo.

Si no hay ningún teléfono conectado, el grupo indica que conectes uno y actives la depuración por USB.

## Cambiar a un teléfono

Conectar un teléfono no cambia la página a él: tal vez solo lo estés cargando. Haz clic en el teléfono de la lista para cambiar. Entonces el gateway copia el servidor de scrcpy al teléfono por adb y lo inicia. El servidor transmite la pantalla y recibe la entrada. Se elimina solo del teléfono cuando termina la conexión, y no queda nada instalado en el teléfono.

Mientras la página muestra el teléfono, su pantalla permanece encendida.

## Qué funciona

La página funciona con un teléfono igual que con un emulador:

- la pantalla, escalada de modo que su lado largo mida como máximo 1920 píxeles;
- hacer clic y arrastrar, desplazarse con la rueda y el trackpad (se envía al teléfono como eventos de desplazamiento reales) y escribir, incluido chino (el chino y otro texto no ASCII requieren Android 7.0 o posterior);
- el portapapeles en ambas direcciones;
- Atrás, Inicio, Recientes, volumen y encendido;
- capturas de pantalla, a la resolución completa del teléfono;
- instalar un APK o copiar un archivo soltándolo sobre la pantalla;
- la depuración H5 de páginas WebView;
- el panel de registros;
- las herramientas de IA del navegador.

## Qué es distinto

- **La rotación** sigue al propio teléfono. No hay tecla de rotación.
- **No hay tecla de detener**: la página no puede apagar un teléfono.
- **Reiniciar** reinicia el teléfono después de que confirmes. La página muestra que el teléfono se está reiniciando y se vuelve a conectar sola cuando el teléfono ha arrancado, normalmente en menos de un minuto. Si el teléfono tiene pantalla de bloqueo, desbloquéalo en la página.
- **Desconectar** el teléfono muestra que el teléfono está desconectado. Vuelve a conectarlo y la página se conecta de nuevo sola.
- **La línea de estado** muestra la tasa de fotogramas, pero no la latencia. El reloj del teléfono difiere del de la Mac, así que no se pueden comparar.

## Solo teléfonos, sin emulador

La comprobación de configuración de la página sigue listando el emulador y una imagen del sistema cuando faltan. Si solo usas teléfonos, solo necesitas `platform-tools`: instálalo y cierra la tarjeta de configuración.
