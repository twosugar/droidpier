---
title: Téléphones
description: Utiliser un téléphone Android en USB dans la page - ce qu’il faut, comment passer sur le téléphone et ce qui fonctionne autrement qu’avec un émulateur.
sourceHash: 9d3199c6c7cf
---

En plus des appareils virtuels Android, la page peut afficher un vrai téléphone Android branché à votre Mac par un câble USB. La page affiche toujours un appareil à la fois : le téléphone ou un émulateur.

## Ce qu’il vous faut

- Un câble USB qui transmet des données, et pas seulement du courant.
- Android 5.0 (API 21) ou plus récent. C’est ce qu’exige le serveur scrcpy fourni.
- Le débogage USB activé dans les options pour les développeurs du téléphone.
- La première fois que vous branchez le téléphone, il demande s’il faut autoriser le débogage USB depuis ce Mac. Autorisez-le.
- `platform-tools` (`adb`) sur le Mac. Un téléphone n’a besoin ni de l’émulateur ni d’une image système. Voir [Configuration requise](/fr/docs/getting-started/requirements/).

## La liste des téléphones

Les téléphones apparaissent dans un groupe à part de la liste des appareils, sous les appareils virtuels. Chaque ligne affiche le fabricant et le modèle du téléphone, sa version d’Android et son état :

- **Prêt** : cliquez sur la ligne pour passer sur le téléphone.
- **Non autorisé** : le téléphone n’a pas encore autorisé ce Mac. Autorisez le débogage USB sur le téléphone.
- **Hors ligne** : adb voit le téléphone mais ne peut pas communiquer avec lui. Débranchez-le puis rebranchez-le.

Quand aucun téléphone n’est branché, le groupe invite à en brancher un et à activer le débogage USB.

## Passer sur un téléphone

Brancher un téléphone ne fait pas passer la page dessus : vous voulez peut-être seulement le recharger. Cliquez sur le téléphone dans la liste pour passer dessus. La passerelle copie alors le serveur scrcpy sur le téléphone via adb et le démarre. Le serveur diffuse l’écran et reçoit les saisies. Il se supprime lui-même du téléphone à la fin de la connexion, et rien ne reste installé sur le téléphone.

Tant que la page affiche le téléphone, son écran reste allumé.

## Ce qui fonctionne

La page fonctionne avec un téléphone comme avec un émulateur :

- l’écran, mis à l’échelle pour que son grand côté ne dépasse pas 1920 pixels ;
- le clic et le glisser, le défilement à la molette et au trackpad (envoyé au téléphone sous forme de vrais événements de défilement) et la saisie au clavier, y compris en chinois (le chinois et les autres textes non ASCII nécessitent Android 7.0 ou version ultérieure) ;
- le presse-papiers dans les deux sens ;
- Retour, Accueil, Récents, volume et alimentation ;
- les captures d’écran, à la pleine résolution du téléphone ;
- l’installation d’un APK ou la copie d’un fichier en le déposant sur l’écran ;
- le débogage H5 des pages WebView ;
- le panneau de journal ;
- les outils d’IA dans le navigateur.

## Ce qui est différent

- **La rotation** suit le téléphone lui-même. Il n’y a pas de bouton de rotation.
- **Il n’y a pas de bouton d’arrêt** : la page ne peut pas éteindre un téléphone.
- **Redémarrer** redémarre le téléphone après votre confirmation. La page indique que le téléphone redémarre, puis se reconnecte d’elle-même une fois le téléphone démarré, en général en moins d’une minute. Si le téléphone a un écran de verrouillage, déverrouillez-le sur la page.
- **Débrancher** le téléphone fait indiquer à la page qu’il est déconnecté. Rebranchez-le et la page se reconnecte d’elle-même.
- **La ligne d’état** affiche la fréquence d’images mais pas la latence. L’horloge du téléphone diffère de celle du Mac, donc les deux ne peuvent pas être comparées.

## Seulement des téléphones, pas d’émulateur

Si vous n’utilisez que des téléphones, il ne vous faut que `platform-tools`. Une fois qu’il est installé et si vous n’avez aucun appareil virtuel, la page n’affiche pas d’elle-même la vérification de la configuration, même si l’émulateur et une image système manquent. Pour configurer un émulateur plus tard, cliquez sur le bouton situé sous la liste d’appareils vide. Il indique combien d’éléments manquent et ouvre la vérification de la configuration, où vous les installez.

Sans `platform-tools`, le groupe Téléphones vous invite à l’installer d’abord, depuis la vérification de la configuration.
