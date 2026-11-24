---
title: Clients IA (MCP)
description: Permet à un client IA, comme Claude Code, de déboguer les pages H5 du périphérique affiché par la page, via le serveur MCP de la passerelle.
sourceHash: 841858735b29
---

`droidpier mcp` connecte un client IA qui parle le Model Context Protocol (MCP), comme Claude Code, à la passerelle. Le client peut alors inspecter le périphérique affiché par la page : lister ses pages H5, y exécuter du JavaScript, lire sa console et prendre une capture d'écran.

Le client passe par la passerelle plutôt que d'ouvrir sa propre connexion de débogage. C'est important sur les simulateurs iOS : WebKit ne permet qu'à un seul débogueur à la fois de s'attacher à une page, si bien qu'un outil séparé (comme iwdp) et la console H5 de la page se repoussent mutuellement. Par la passerelle, le client IA et la console H5 partagent une seule connexion.

## Ce qu'il vous faut {#what-you-need}

- La passerelle en cours d'exécution, en arrière-plan (`droidpier start`) ou dans une fenêtre du Terminal. La passerelle en arrière-plan se met à jour toute seule ; MCP nécessite une version publiée le 2026-11-24 ou plus tard. Exécutez à nouveau la commande d'installation pour mettre à jour une passerelle qui tourne dans une fenêtre du Terminal.
- La page ouverte, affichant le périphérique que vous souhaitez que le client utilise.

## Ajout dans votre client {#add-it-to-your-client}

Dans Claude Code, ajoutez-le une seule fois :

```sh
claude mcp add droidpier -- droidpier mcp
```

Démarrez ensuite une nouvelle session Claude Code : les outils apparaissent sous la forme `mcp__droidpier__…`.

Les autres clients utilisent un serveur qui s'exécute comme une commande et communique via l'entrée et la sortie standard. Fournissez le chemin complet de l'exécutable, car une application lancée depuis le Dock peut ne pas avoir `~/.local/bin` dans son `PATH` :

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<vous>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

Si la passerelle tourne sur un autre port, ajoutez-le : `droidpier mcp --port 7310`.

## Les outils {#the-tools}

| Outil | Ce qu'il fait |
|---|---|
| `device_status` | Le périphérique affiché par la page : nom, plateforme (`android` ou `ios`), type et taille d'écran en pixels. |
| `list_pages` | Les pages H5 sur ce périphérique, chacune avec une valeur `page`, un titre, une adresse, une application et si elle est au premier plan. |
| `evaluate` | Exécute une expression JavaScript dans une page et renvoie le résultat en JSON. Attend une promesse. Si l'expression lève une erreur, l'outil échoue avec cette erreur. |
| `console_logs` | La sortie console et les erreurs non capturées d'une page. La collecte commence la première fois qu'un outil utilise cette page ; sur les simulateurs iOS, elle inclut aussi les messages enregistrés auparavant. Elle conserve les 500 derniers. Passez la valeur `next` de la réponse précédente comme `since` pour n'obtenir que les nouvelles lignes. |
| `screenshot` | L'écran du périphérique, sous forme d'image PNG. |

`evaluate` et `console_logs` utilisent la valeur `page` de `list_pages`. Sans elle, ils utilisent la page au premier plan ; si plusieurs pages sont au premier plan, ils échouent et listent les pages parmi lesquelles choisir.

## Quel périphérique et quelles pages {#which-device-and-which-pages}

Les outils utilisent toujours le périphérique affiché par la page. Pour utiliser un autre périphérique, basculez vers lui dans la page. Sans page ouverte, ils utilisent le dernier périphérique auquel la passerelle s'est connectée, et l'indiquent s'il n'y en a aucun.

Les pages sont celles que le périphérique autorise un débogueur à voir :

- Sur les émulateurs et téléphones Android : onglets Chrome, et WebViews des applications activant le débogage WebView.
- Sur les simulateurs iOS : onglets Safari, et `WKWebView`s qui définissent `isInspectable` (iOS 16.4 et ultérieur).

## Utilisation à côté de la console H5 {#using-it-next-to-the-h5-console}

Le client IA et la console H5 de la page peuvent déboguer la même page en même temps. Ce que le client enregistre apparaît aussi dans la console H5.

Lorsque vous ouvrez ou fermez la console H5 sur une page de simulateur iOS que le client utilise également, la passerelle rouvre la connexion de débogage de la page pour que la console commence proprement et ne laisse rien derrière elle (comme une pause avant le chargement de la page suivante). Un appel d'outil en cours à ce moment-là échoue ; le client peut le réexécuter.

Lorsque la passerelle redémarre, par exemple pour se mettre à jour, `droidpier mcp` continue de tourner et se reconnecte dès que la passerelle est de retour, pendant jusqu'à une minute. Un appel en cours à ce moment-là échoue.

## Sécurité {#security}

`droidpier mcp` atteint la passerelle via un socket Unix, `~/Library/Application Support/Droidpier/mcp-<port>.sock`. Seul votre utilisateur macOS peut ouvrir son dossier. La passerelle n'ouvre aucun port réseau pour cela, et les pages web ne peuvent pas l'atteindre.

Tout programme s'exécutant sous votre utilisateur peut utiliser le socket, comme il pourrait exécuter `adb` ou `simctl` directement. Un client avec ces outils peut exécuter n'importe quel JavaScript dans les pages H5 de vos périphériques, y compris des pages où vous êtes connecté. Autorisez les outils dans votre client de la même façon que vous autorisez d'autres outils qui exécutent du code.

Voir [Sécurité](/fr/docs/reference/security/) pour le reste de la passerelle.

## Résolution de problèmes {#troubleshooting}

| Problème | Que faire |
|---|---|
| `droidpier mcp` quitte car la passerelle n'est pas en cours d'exécution | Démarrez la passerelle avec `droidpier start`, puis reconnectez le client. |
| Les outils indiquent qu'aucun périphérique n'est connecté | Ouvrez la page et basculez vers un périphérique. |
| Un outil ne trouve pas de page | Exécutez à nouveau `list_pages` : les pages apparaissent et disparaissent à mesure que les applications les ouvrent et les ferment. |
| Un outil dépasse le délai d'attente sur une page iOS | La page est peut-être en pause dans le débogueur, par exemple à un point d'arrêt dans la console H5. Reprenez l'exécution depuis là. |
