# Déclaration de protection des données

**OpenVolley et OpenBeach** · Version 1.27 · État au 23 novembre 2026

Cette déclaration existe en allemand, anglais, français et italien. Seule la
version anglaise fait foi.

## En bref

- OpenVolley est un projet open source privé et non commercial. Il n'y a ni
  publicité, ni suivi (tracking), ni outil d'analyse, ni cookies de ma part
  (la section 3 nomme les scripts qu'ajoute Cloudflare).
- Les applications fonctionnent hors ligne. Tes matchs sont enregistrés sur
  ton appareil, et dans la base de données du serveur seulement une fois que
  tu es connecté. Pour que les tablettes reçoivent un match en cours, les
  applications navigateur et Android le font passer par mon serveur même sans
  connexion, uniquement en mémoire vive.
- L'outil Global d'OpenVolley n'a pas besoin de compte. Ses matchs restent sur
  ton appareil. Seules une sauvegarde du match et, à la fin, la feuille de
  match en PDF sont conservées sur le serveur, sous un code de sauvegarde
  aléatoire et sans compte, et supprimées 180 jours après la dernière
  modification. Si le marqueur active « Enregistrer dans le cloud » pour un
  match (désactivé par défaut), celui-ci est aussi conservé lisible sur le
  serveur, sans PIN ni images des signatures, jusqu'à 180 jours après le
  dernier enregistrement (section 7).
- « Nouveau match » dans la version suisse (déconnecté) fonctionne de la
  même manière : pas de compte, le match sur ton appareil, sa sauvegarde et
  son PDF sous son code de sauvegarde, et ni équipes enregistrées, ni listes
  du club, ni répertoire des arbitres.
- Écran en direct (facultatif, dans OpenVolley et OpenBeach) : si les
  appareils de marque d'un événement l'activent, le score de chacun de leurs
  matchs (noms des équipes, points et sets, aucun joueur) est aussi envoyé au
  serveur ; il est gardé uniquement en mémoire et visible par toute personne
  qui a le code de l'écran en direct, et pour les matchs Global aussi par
  tout le monde sur livescore.openvolley.app, sauf si c'est désactivé
  (section 7).
- Une feuille de match électronique contient des données sur les joueuses et
  joueurs, l'encadrement et les officiels : noms, numéros de maillot, numéros
  de licence et signatures. Une date de naissance ne figure sur la feuille
  d'un match que si le marqueur en tape une (dans l'outil Global,
  l'organisatrice ou l'organisateur choisit ce qui figure à côté d'un nom).
  Seuls les noms des équipes, le score et les numéros
  de maillot sont publics ; en beach-volley aussi les noms des joueuses et
  joueurs, ainsi que les noms des arbitres des matchs officiels.
  **Les dates de naissance, numéros de licence et signatures ne sont jamais
  publics.**
- Aucune date de naissance n'est conservée ailleurs : ni avec les comptes,
  ni dans les listes des clubs, les équipes enregistrées, les listes envoyées
  à l'avance, le répertoire des arbitres ou les convocations. Celles
  enregistrées avant le 19 novembre 2026 ont été effacées, aussi des feuilles
  de match passées (section 16).
- L'application OpenVolley tient un journal d'activité de chaque match, sans
  NIP ni mots de passe. Si tu es connecté, il est envoyé au serveur. Ce que
  tu cliques ou tapes reste sur ton appareil, sauf un résumé sans le texte
  saisi si tu joins les diagnostics à une demande de support (sections 5
  et 13).
- Quand quelque chose ne va pas, les applications, les pages web et le
  serveur envoient un rapport d'erreur à mon serveur, aussi sans connexion :
  ce qui n'a pas fonctionné et où dans le programme, les étapes juste avant
  (jamais ce que tu as tapé), l'application et sa version, le système
  d'exploitation, le navigateur et la taille de l'écran. Tu peux le
  désactiver dans les options (section 5).
- Le serveur se trouve en Suisse : je le loue chez Infomaniak à Genève et
  l'exploite moi-même. Cloudflare (États-Unis) diffuse les sites web et
  transmet le trafic au serveur.
- Lorsque l'envoi est activé, le marqueur, les arbitres, les clubs des deux
  équipes et l'adresse de contact saisie pour chaque équipe reçoivent par
  e-mail la feuille de match finale d'un match officiel (section 7).
- Le responsable d'une équipe peut envoyer à l'avance la liste d'un match.
  L'appareil du marqueur la garde pour la préparation du match ; dès que le
  marqueur l'accepte, le serveur la supprime (section 10).
- Les procès-verbaux de match (feuilles de match, événements, fichiers des
  feuilles de match) sont conservés pendant leur saison et les deux saisons
  suivantes, puis effacés (section 16).
- Tu peux demander à tout moment l'accès, la rectification ou
  l'effacement : **support@openvolley.app**.

## 1. Qui est responsable

Le responsable du traitement est :

**Luca Canepa**, personne privée, Suisse\
Adresse postale : voir les [mentions légales](impressum.md)\
E-mail : support@openvolley.app

J'exploite OpenVolley en tant que personne privée. Je n'ai pas désigné de
conseiller à la protection des données ; je n'y suis pas tenu. Pour toute
question sur la protection des données, écris à support@openvolley.app.

Cette déclaration s'applique :

- au site **openvolley.app** et à la page de téléchargement
  **get.openvolley.app** ;
- aux applications de marquage **OpenVolley** (salle) et **OpenBeach** (beach)
  dans le navigateur, comme application de bureau (Windows, Linux) et comme
  application Android ;
- aux vues tablette pour l'arbitre et le banc, au livescore, aux pages de
  listes d'équipe et de feuilles de match et aux sites de gestion sous
  `*.openvolley.app` ;
- au serveur `backend.openvolley.app` avec lequel les applications se
  synchronisent.

## 2. Droit applicable

Je traite les données personnelles selon la loi fédérale suisse sur la
protection des données (LPD, en vigueur depuis le 1er septembre 2023).
Lorsque des personnes dans l'UE ou l'EEE sont concernées, par exemple des
joueuses et joueurs étrangers lors d'un tournoi de beach-volley, je respecte en
outre le règlement général sur la protection des données de l'UE (RGPD).
Cette déclaration contient les informations exigées par les deux lois.

## 3. Principes

- **Pas de cookies.** Les applications ne déposent aucun cookie. Elles
  enregistrent seulement ce dont elles ont besoin pour fonctionner dans la
  mémoire de ton navigateur ou appareil (localStorage et IndexedDB) : les
  données des matchs pour le mode hors ligne, tes réglages et, si tu es
  connecté, un jeton de connexion.
- **Pas de suivi, pas de publicité, pas d'analyse.** Il n'y a ni outil
  d'analyse, ni envoi de rapports d'erreur à des tiers (les rapports d'erreur vont
  uniquement à mon propre serveur, section 5), ni publicité, ni
  profilage, ni décision individuelle automatisée. Je ne vends pas de données.
- **Pas de contenus de tiers.** Les polices et le code des programmes
  viennent de nos propres sites, pas de serveurs tiers. Les exceptions sont
  nommées expressément (section 12 et les scripts de Cloudflare ci-dessous).
- **Scripts de Cloudflare.** Cloudflare, qui livre les sites (section 15),
  ajoute aux pages deux petits scripts à lui : dans chaque page un contrôle
  contre les accès automatisés (détection des robots) et, sur openvolley.app
  et get.openvolley.app, un script qui affiche les adresses e-mail écrites sur
  la page. Ils viennent de la même adresse que la page, ne te suivent pas et
  ne servent à aucune analyse. Le contrôle des robots peut enregistrer son
  résultat dans un cookie de Cloudflare (`cf_clearance`) ; il est strictement
  nécessaire à la protection du service.
- **Hors ligne d'abord.** Ce que tu saisis sans te connecter n'est
  enregistré que sur ton appareil. Pour la transmission aux tablettes, voir
  la section 9.

## 4. Site web et page de téléchargement

**openvolley.app** et **get.openvolley.app** sont des pages statiques ; en
dehors des scripts de Cloudflare (section 3), elles ne chargent aucun script. Le seul formulaire est le formulaire de support sur
openvolley.app/support (section 13). Lors de l'affichage, Cloudflare traite
les données techniquement nécessaires : adresse IP, adresse demandée, heure
et identifiant du navigateur. Mon serveur ne tient pas de journal d'accès pour
get.openvolley.app.

Les liens vers GitHub et F-Droid mènent à des services qui sont eux-mêmes
responsables de leurs traitements de données.

## 5. Les applications de marquage (navigateur, bureau, Android)

**Sans connexion**, l'application enregistre tout uniquement sur ton
appareil : matchs, équipes, listes d'équipe (avec numéros de licence, et
dates de naissance là où le marqueur les a tapées), sets, événements du
match, listes d'officiels, réglages et les journaux de l'application (voir
ci-dessous). Les matchs restent enregistrés jusqu'à ce que
tu les supprimes ou effaces les données de l'application. Sans connexion,
seuls les rapports d'erreur sont envoyés à mon serveur (voir ci-dessous).

**Transmission en direct, même sans connexion.** Dès qu'un match est créé,
les applications navigateur et Android l'envoient (équipes, listes d'équipe,
score, événements) au relais en direct de mon serveur, afin que les tablettes
de l'arbitre et du banc le reçoivent (section 9). Il n'y est gardé qu'en
mémoire vive. L'application de bureau utilise à la place son propre relais
sur le réseau local.

**Avec connexion**, l'application synchronise tes matchs avec le serveur
(section 7). Elle téléverse en plus :

- des **copies de sauvegarde** d'un match (complètes, avec listes d'équipe
  et signatures). Seul ton compte peut les lire. Elles
  sont effacées après 30 jours ;
- des **journaux de l'application** (messages techniques ; ils peuvent
  contenir des noms et des numéros de match). Seul ton compte peut les
  lire. Ils sont effacés après 30 jours, et avec ton compte ;
- les **feuilles de match** comme fichiers (PDF et données), voir section 7.

**Journal d'activité (OpenVolley à partir de la version 2.4.0).** Pour la
traçabilité de la feuille de match et pour le dépannage, l'application
consigne ce qui se passe sur l'appareil : points et autres événements du
match, annulations et corrections (ce qui a été modifié, quand et pourquoi),
sets et statut du match, signatures et validations (seulement la fonction et
le fait qu'elles ont eu lieu), remarques (seulement leur longueur),
modifications des listes d'équipe (seulement le numéro de maillot), résultats
des envois au serveur, erreurs de l'application (message et endroit dans le
programme), démarrage, mise à jour et fermeture de l'application ainsi que
connexion et déconnexion. Chaque entrée porte un identifiant aléatoire de
l'appareil (créé par l'application, sans lien avec le matériel), la version
de l'application, la plateforme et, si tu es connecté, ton compte.
**Ne sont jamais enregistrés** les NIP, mots de passe, jetons de connexion,
images de signature, dates de naissance, adresses e-mail, numéros de
téléphone et de licence ; si quelqu'un modifie un tel champ à la main, le
journal indique seulement qu'il a été modifié. Dans le texte libre (messages
d'erreur, valeurs des modifications), les suites de six chiffres ou plus et
les nombres placés à côté de mots comme « PIN », « code » ou « mot de passe »
sont masqués. Le journal ne contient donc pas plus de données personnelles
que la feuille de match elle-même (numéros de maillot, noms des officiels
lors d'une correction). Tu peux le consulter dans l'application et
l'enregistrer comme fichier (CSV ou JSON).

**Où se trouve le journal d'activité :** sur ton appareil ; dans les
applications de bureau et Android aussi sous forme de fichiers quotidiens
dans le dossier `OpenVolley/logs` (bureau : dans ton dossier utilisateur à
côté des fichiers de sauvegarde, Android : dans le dossier propre à
l'application, voir ci-dessous). Si tu es connecté, l'application l'envoie à mon serveur, y
compris les entrées créées sur cet appareil sans connexion. Sur le serveur,
les entrées d'un match peuvent être lues par le compte qui a saisi le match,
les comptes qui ont saisi le NIP du match et les administrateurs ; les entrées
sans match ne sont visibles que pour les administrateurs. Lorsqu'un match est
supprimé sur le serveur, ses entrées sont supprimées avec lui. La durée de
conservation figure à la section 16 ; sur demande, je les supprime plus tôt
(section 19).

**Rapports d'erreur (depuis novembre 2026).** Quand une erreur se produit,
l'application ou la page web envoie un rapport à mon serveur, que tu sois
connecté ou non : l'application de marquage, les pages arbitre, banc,
livescore, feuille de match, liste d'équipe, dictée, manager et TV, ainsi
qu'OpenBeach. Un rapport contient le message d'erreur et l'endroit dans le
programme (noms de fichiers et numéros de ligne), l'écran ou la page
ouverte, les dernières étapes avant l'erreur (écrans ouverts, boutons
touchés (par leur nom interne, pas leur texte), adresses du serveur appelées
et leur résultat ; jamais ce que tu as tapé ni le contenu d'un champ de
saisie), l'application (OpenVolley ou OpenBeach), l'outil et sa version, le
système d'exploitation et sa version, le navigateur ou la vue web et sa
version, la façon dont l'application fonctionne (onglet du navigateur,
application web installée, application de bureau ou mobile), le modèle de
l'appareil quand le système le donne, la taille de l'écran et de la fenêtre,
la langue et le fuseau horaire, si l'appareil était en ligne, l'identifiant
aléatoire de l'appareil (le même que dans le journal d'activité), un
identifiant aléatoire de la visite, l'identifiant externe du match ouvert
et, si tu es connecté, ton compte. **Jamais contenus :** NIP, mots de passe,
jetons de connexion, texte tapé, adresses e-mail, dates de naissance,
numéros de téléphone, images de signature et ton adresse IP ; le serveur
retire de nouveau ces valeurs, quoi qu'un appareil envoie. Le serveur
enregistre ses propres erreurs de la même façon (la requête et l'endroit
dans le programme, sans contenu).
Seuls les administrateurs disposant de tous les droits voient les rapports,
dans le manager ; ils y voient aussi le nom, l'adresse e-mail, les rôles et
les clubs d'un compte connecté, et l'ouverture des rapports est inscrite au
journal des modifications (section 14). Les administrateurs sont informés
des nouvelles erreurs par e-mail, avec les rôles et les clubs des comptes
concernés mais jamais un nom ou une adresse, et par une notification push
sur leur téléphone via un service de notification sur mon propre ordinateur
(uniquement l'outil, la version, le système d'exploitation et le message
d'erreur). Les rapports sont conservés 90 jours (section 16). Tu peux les
désactiver dans les options (Support et avis : « Envoyer automatiquement les
rapports d'erreur ») ; les rapports déjà envoyés restent jusqu'à leur
expiration, ou je les efface sur demande (indique l'identifiant de
l'appareil affiché à cet endroit).

**Historique des événements (OpenVolley à partir de la version 2.4.0).**
Lorsqu'un point ou un autre événement est annulé ou corrigé, l'application
consigne l'ancien événement (pour une modification aussi le nouveau) avec le
motif, l'heure, l'identifiant de l'appareil, la version de l'application et
le compte. Si l'événement se trouvait déjà sur le serveur, celui-ci ne le
supprime pas, mais le marque comme annulé et conserve la modification, afin
que le déroulement du match reste traçable. L'historique des événements fait
partie du match et est supprimé avec lui. Sur le serveur, seuls les
administrateurs le voient.

**Journal d'utilisation : ce que tu cliques ou tapes reste sur ton
appareil.** Pour le dépannage, l'application enregistre sur l'appareil ce que
tu cliques et tapes (y compris le texte des champs de saisie, par exemple
des noms). Ce journal n'est pas envoyé de lui-même. Seulement si tu joins
les diagnostics à une demande de support, un résumé des deux dernières heures
environ l'accompagne, sans le texte saisi (section 13). Tu peux le
télécharger toi-même (dans les réglages, ou à la fin du match dans le fichier
ZIP) et l'envoyer par exemple au support. Dans OpenVolley à partir de la
version 2.4.0, il n'enregistre aucune saisie dans les champs de mot de passe
et de NIP ni aucun NIP affiché à l'écran, et il est effacé après 30 jours ou
au-delà de 50 000 entrées.

**Application de bureau.** L'application de bureau enregistre en plus des
fichiers de sauvegarde automatiques des matchs dans ton dossier utilisateur
(Linux : `~/.local/share/OpenVolley/backups`, Windows :
`%APPDATA%\OpenVolley\backups`). Ils contiennent les noms (et les dates de
naissance là où le marqueur les a tapées), mais aucun NIP, et sont effacés
après 30 jours. À partir de la
version 2.4.0, l'application de bureau OpenVolley écrit en outre un fichier
journal technique (`desktop.log`) dans le dossier `OpenVolley/logs` :
démarrage et fermeture, recherches et téléchargements de mises à jour, liens
et téléchargements ouverts (adresse sans paramètres, emplacement
d'enregistrement), nombre de tablettes connectées et erreurs. Il reste sur
ton appareil, n'est jamais envoyé et ne contient ni NIP, ni jetons de
connexion, ni mots de passe du point d'accès. Au plus cinq anciens fichiers
de 5 Mo chacun sont conservés.

**Application Android.** L'application Android garde ses fichiers de
sauvegarde (chiffrés avec les NIP du match ; un match de test n'en a pas), les feuilles de match en PDF et
les fichiers quotidiens du journal d'activité dans son propre dossier, qu'aucune
autre application ne peut lire et qui est supprimé à la désinstallation.
C'est seulement si tu choisis « Exporter vers Documents » qu'elle copie
des fichiers dans le dossier public « Documents » (`Documents/OpenVolley`).
**Ces copies subsistent après la désinstallation de l'application et, sous
Android 10 et versions antérieures, d'autres applications peuvent aussi les
lire.** Supprime-les toi-même lorsque tu n'en as plus besoin. Les
versions jusqu'à 3.1.4 gardaient leurs fichiers dans « Documents » ; les
versions plus récentes les déplacent dans le dossier de l'application au
premier démarrage. Si tu as activé la sauvegarde Google de
l'appareil, Android peut aussi sauvegarder les données de l'application (avec
les listes d'équipe) dans ton compte Google ; les conditions de Google
s'appliquent.

Sur un appareil partagé, déconnecte-toi après le match. La déconnexion
efface de l'application ton jeton de connexion, ton profil et tes clubs,
les matchs du jour, les équipes, listes et listes de licences des clubs mises en
cache, ainsi que les adresses e-mail avec lesquelles des officiels ont
confirmé sur cet appareil ; de même lorsque ta session expire ou qu'un
autre compte se connecte. Sans connexion, la déconnexion met aussi fin à
ta session sur le serveur dès que l'appareil est de nouveau en ligne. Les
adresses des officiels sont conservées 7 jours au plus. Ne configure pas de
clé d'accès sur un appareil partagé (coche "Appareil partagé" à la
connexion).

## 6. Compte et e-mails

Il te faut un compte pour synchroniser des matchs, gérer des équipes et des
tournois ou valider des résultats en tant qu'officiel. Les comptes s'ouvrent
sur `manager.openvolley.app` et `manager-beach.openvolley.app`.

**Données :** adresse e-mail, mot de passe (enregistré uniquement sous forme
de hachage, jamais en clair), prénom et nom, pays, numéro de licence
(ton numéro de licence Swiss Volley, 4 à 7 chiffres ; nécessaire pour un
nouveau compte depuis le 23 novembre 2026, les comptes ouverts avant sont
invités à l'indiquer à leur prochaine connexion), la langue
choisie à l'inscription (pour les e-mails du
compte), rôles (par exemple marqueur, arbitre, gestionnaire de
compétition), les applications concernées (salle, beach), dates de création,
de dernière connexion et de confirmation de l'e-mail. Les indications saisies
à l'inscription sont aussi conservées en copie avec le compte.

**But :** connexion, déblocage des fonctions de ton rôle et préremplissage
de tes propres données sur la feuille de match (nom, pays, numéro de licence).

**Pas de date de naissance :** l'inscription et le profil n'en demandent pas,
et le serveur n'en conserve aucune (depuis le 19 novembre 2026 ; les dates de
naissance saisies auparavant ont été effacées, section 16).

**Les nouveaux comptes** n'ont d'abord aucun rôle. Un administrateur les
valide, ou tu utilises un code d'invitation. Le système enregistre qui a
utilisé quel code et quand.

**Ce que tu fais (inscription à OpenVolley, facultatif) :** à
l'inscription, tu peux indiquer ce que tu fais (marqueur, arbitre,
responsable d'équipe ou entraîneur, responsable du club) et pour quel club et
quelle équipe. Cette demande n'est conservée que jusqu'à ce qu'elle soit
validée ou refusée, et elle est visible, avec ton nom et ton adresse
e-mail, par les administrateurs et par les responsables de ce club ou de cette
équipe. Une fois validée, ton compte
reçoit exactement ce rôle, ce club ou cette équipe (par un administrateur, ou
par les responsables du club ou de l'équipe pour leur propre club ou équipe) ;
le système enregistre qui a décidé et quand, mais pas ton nom ni ton
adresse dans cette entrée.

**Clubs (OpenVolley) :** un administrateur, ou un code d'invitation, peut
rattacher ton compte à un ou plusieurs clubs. Tu tiens alors les matchs
officiels à domicile de ces clubs. Le système enregistre à quels clubs ton
compte appartient, qui l'a rattaché et quand, jusqu'à ce que le club ou le
rattachement soit supprimé ou que tu supprimes le compte. L'application de
marque garde une copie de tes clubs sur ton appareil pour vérifier un match
hors ligne ; la copie est supprimée à la déconnexion.

**Responsables de club (OpenVolley) :** un administrateur peut désigner des
comptes comme responsables d'un club. Pour les comptes qui marquent pour leur
club, ils voient le nom, l'adresse e-mail, les rôles et la date du
rattachement. Ils peuvent créer des codes d'invitation pour leur club et
retirer un compte du club ; le compte lui-même et ses rôles restent. Un club
peut indiquer une **adresse de contact** (saisie par les administrateurs ou
les responsables du club) ; elle reçoit les feuilles de match finales des
matchs du club (section 7).

Les responsables de club peuvent aussi donner un lien à l'entraîneur ou au
responsable d'une équipe de leur club, qui gère alors cette équipe (section
10).

**Connexion :** après la connexion, ton navigateur enregistre un jeton de
connexion. Le serveur n'en garde qu'un hachage. Une session dure 30 jours
après la dernière utilisation, 90 jours au plus, et se termine à la
déconnexion, au changement de mot de passe et à la suppression du compte.
Pour se protéger des attaques, le serveur compte les tentatives échouées par
adresse IP et par adresse e-mail, uniquement en mémoire vive.

**E-mails :** je n'envoie que des e-mails liés au compte : confirmation de
l'adresse e-mail, lien de réinitialisation du mot de passe, avis de
changement du mot de passe, avis qu'un résultat a été validé avec ton NIP
de validation et avis que ton NIP a été bloqué. Ils ne contiennent ni pixel
de suivi ni image chargée à distance. Un lien de confirmation est valable
24 heures, un lien de réinitialisation 60 minutes.

**Feuilles de match par e-mail :** j'envoie la feuille de match finale d'un
match officiel et la feuille de ton propre match de test comme décrit à la
section 7.

**Qui voit tes données de compte :** toi-même et les administrateurs
d'OpenVolley (moi et les personnes que je désigne). En outre, dans la mesure
où leur tâche l'exige :

- les responsables d'un club pour lequel tu marques ou dont tu gères une
  équipe : ton nom, ton adresse e-mail, tes rôles et depuis quand tu
  appartiens au club ou gères l'équipe ;
- les responsables du club ou de l'équipe indiqués lors de ton inscription
  (ceux qui valident) : ton nom, ton adresse e-mail, la date
  d'inscription et si ton adresse est confirmée, jusqu'à la décision sur
  ta demande ;
- les autres gestionnaires d'un tournoi de beach-volley que tu gères :
  ton adresse e-mail ;
- les marqueurs qui reçoivent une liste d'équipe que tu as envoyée à
  l'avance : ton nom comme expéditeur (section 10) ;
- les autres marqueurs d'un match officiel que tu marques déjà : ton nom,
  pour qu'ils sachent que le match est pris ;
- les gestionnaires de compétition de l'application : le nom du compte qui a
  saisi chaque match, dans la liste des feuilles de match.

**Supprimer ton compte :** tu peux supprimer ton compte toi-même dans
l'application à tout moment. Sont alors effacés le compte, le profil, les
sessions, le NIP de validation, les codes d'invitation utilisés, tes copies
de sauvegarde et journaux téléversés ainsi que tes entrées du journal
d'activité sans match. **Subsistent** les documents officiels auxquels
d'autres ont un intérêt : les feuilles de match que tu as saisies, les
validations que tu as données (avec ton nom tel qu'il figure sur la
feuille de match), les équipes et tournois enregistrés, les entrées du
journal des modifications (section 14) ainsi que le journal d'activité et
l'historique des événements des matchs (section 5). Ton compte est
dissocié de ces entrées. Tu peux faire effacer ce qui subsiste selon la
section 19, dans la mesure où la feuille de match n'en a pas besoin.

**Suppression par un administrateur :** un administrateur peut aussi
supprimer ton compte, lorsque tu le demandes (section 19) ou lorsqu'un
nouveau compte n'est pas validé (refusé). Les mêmes données sont effacées et
les mêmes subsistent que lorsque tu le supprimes toi-même.

## 7. Données des matchs et feuilles de match

**Contenu d'un match :** numéro du match, ligue, salle et localité, équipes
(nom, nom court, couleur), listes d'équipe avec numéro de maillot, prénom et
nom, numéro de licence et indication libéro ou capitaine, encadrement
(fonction, nom, numéro de licence), officiels (arbitres, marqueur, juges de
ligne avec nom, pays et numéro de licence ; arbitres avec une adresse e-mail
facultative), une adresse e-mail de contact facultative par équipe, **signatures** (images dessinées sur
l'appareil ou sur un téléphone), tirage au sort, déroulement du match avec tous les événements,
remplacements et sanctions, résultats et corrections ultérieures, ainsi que
les **remarques** (la case des remarques de la feuille de match : ce
qu'écrit le marqueur et les lignes qu'ajoute l'application, par exemple pour
un remplacement forcé ou un libéro qui ne peut plus jouer). Les **remarques
techniques** sont aussi conservées avec le match : ce que l'application note
sur la manière dont le match a été enregistré (corrections, un changement de
la liste d'équipe après le tirage au sort, un set rouvert, des signatures
effacées ou données à nouveau, un remplacement pour blessure avec un
remplaçant régulier, une blessure sur le banc) et ce que le marqueur ajoute
comme telle. Elles ne sont pas imprimées sur la feuille de match.

**Numéro de licence ou date de naissance :** dans la version suisse, c'est le
numéro de licence qui figure à côté d'un nom. Le marqueur peut y taper à la
place une date de naissance ; elle figure alors seulement sur la feuille de ce
match. Dans l'outil Global, l'organisatrice ou l'organisateur du tournoi
choisit ce qui figure à côté d'un nom : la date de naissance, un numéro
d'identité ou un texte.

**Données de santé dans un match :** un remplacement ou un changement de
libéro parce qu'une joueuse ou un joueur est blessé ou malade, et une blessure
que note le marqueur, sont des informations sur la santé (données
personnelles sensibles selon la LPD, catégorie particulière selon le RGPD).
L'application enregistre l'événement avec son motif, comme l'exigent les
règles, et n'écrit dans les remarques que les termes des règles (par exemple
« #4 substituted, cannot continue playing »), jamais un diagnostic. Les
remarques écrites par le marqueur peuvent en dire plus : n'écris que ce dont
le procès-verbal a besoin. Les remarques sont vues par ceux qui voient tout
(tableau ci-dessous) et, pendant le match, par la tablette d'arbitre et les
détenteurs du NIP du match, jamais par les tablettes de banc ni le public ;
elles figurent sur la feuille de match et parviennent ainsi à ses
destinataires (ci-dessous). Un remplacement pour blessure avec un remplaçant
régulier et une blessure sur le banc sont en revanche des remarques
techniques : elles ne figurent ni sur la feuille de match ni sur la tablette
d'arbitre, restent avec le procès-verbal du match et sont listées dans
l'e-mail de la feuille de match finale (ci-dessous). Base juridique : section 20 ; conservées avec le
match (section 16).

**Qui saisit les données :** le marqueur dans l'application, les responsables
d'équipe sur la page des listes d'équipe (`roster.openvolley.app`) et dans le site de gestion (section 10), les
gestionnaires de compétition au moyen des équipes enregistrées (section 10)
et les convocations officielles de Swiss Volley (section 11). Les joueuses et
joueurs ne saisissent pas eux-mêmes leurs données. Une Einsatzliste importée
dans la préparation du match remplit les noms, numéros de maillot et numéros
de licence ; ses dates de naissance ne sont pas reprises.

**But :** une feuille de match électronique pour les matchs officiels :
saisie pendant le match, procès-verbal officiel du match, contrôle de la
qualification (numéro de licence), livescore.

**Qui voit quoi :**

| Qui | Quoi |
|---|---|
| Le compte qui a saisi ou clôturé le match ; les administrateurs | Tout |
| Les comptes qui ont saisi le NIP du match (par exemple une tablette qui reprend le match) | Tout, jusqu'à la clôture du match |
| Tablette d'arbitre avec le NIP d'arbitre | Équipes, les deux listes d'équipe avec noms et numéros, score, remarques (sans les remarques techniques). **Pas** de dates de naissance, signatures, officiels ni validations |
| Tablette de banc avec le NIP de son équipe | La liste de sa propre équipe avec noms et numéros, les numéros de maillot de l'autre équipe, score. **Pas** de remarques, dates de naissance, signatures, officiels ni validations |
| Tout le monde (public) | Voir section 8 |

Une fois un match validé et clôturé, personne ne peut plus le modifier, pas
même la personne qui l'a saisi. Seul un administrateur peut le rouvrir. Dès
la clôture, le NIP du match n'ouvre plus le procès-verbal : il ne montre que
ce qui est public (section 8), et les comptes qui l'ont rejoint avec lui ne
peuvent plus lire le match. Chaque restauration d'un match avec le NIP du
match est consignée dans le journal des modifications. La personne qui a créé
le match et les administrateurs voient les comptes qui l'ont rejoint avec le
NIP du match et peuvent les retirer.

**Fichiers des feuilles de match :** à la fin du match, l'application
téléverse la feuille de match en PDF et sous forme de fichier de données.
Seul le compte qui l'a téléversée peut la lire (via
`scoresheet.openvolley.app`), ainsi que les administrateurs et les
responsables de compétition de l'application concernée (OpenVolley ou
OpenBeach), qui peuvent ouvrir le PDF dans le gestionnaire. Chaque ouverture
est inscrite au journal avec leur compte. Si le compte qui l'a téléversée est
supprimé, le fichier reste conservé comme procès-verbal du match ; seuls les
administrateurs et les responsables de compétition peuvent encore ouvrir le
PDF.

**Feuille de match finale par e-mail :** cette fonction est d'abord
désactivée ; les administrateurs et les responsables de compétition
d'OpenVolley l'activent. Lorsqu'elle est activée, le serveur envoie la
feuille de match d'un match officiel en salle clôturé, en PDF, à :

- le compte qui a clôturé le match et le compte du marqueur qui a validé le
  résultat ;
- les arbitres qui ont validé le résultat avec leur compte ou dont l'adresse
  e-mail a été saisie pour le match ;
- l'adresse de contact du club de chaque équipe (section 6), afin que le club
  puisse transmettre la feuille aux entraîneurs ;
- l'adresse de contact saisie pour chaque équipe dans la configuration du
  match ou sous « Modifier les infos du match », comme les adresses des
  arbitres.

Chaque adresse reçoit son propre e-mail et ne voit pas les autres. Si un
match est rouvert puis clôturé à nouveau, la feuille corrigée est envoyée une
nouvelle fois aux destinataires. Seuls le moment de l'envoi et le nombre
d'adresses sont enregistrés, pas les adresses. Les matchs clôturés avant
l'activation ne sont pas envoyés. L'adresse e-mail d'un arbitre ou d'une
équipe est facultative, fait partie du match et n'est jamais publique ; seuls ceux qui
peuvent lire tout le match la voient (tableau ci-dessus). L'e-mail liste aussi
dans son texte les remarques techniques du match (ci-dessus) ; elles ne
figurent pas dans le PDF. L'envoi passe par
Migadu (section 15).

**Feuille d'un match de test :** si tu valides le résultat à la fin d'un
match de test en étant connecté, l'application envoie sa feuille en PDF à
l'adresse e-mail de ton compte, et à aucune autre. Le serveur ne la
conserve pas ; sur ton appareil, le match de test est supprimé lorsque tu
le clôtures.

**Outil Global (sans compte) :** dans l'outil Global d'OpenVolley (choisi au
démarrage de l'application, modifiable dans les Options tant qu'aucun match
n'est sur l'appareil), tu saisis les matchs d'un tournoi quelconque sans
compte. Les effectifs, les officiels et les matchs que tu saisis ou que
tu charges depuis un fichier Excel ou CSV restent sur ton appareil ;
l'application lit le fichier sur l'appareil et ne le téléverse pas. Un match
Global ne figure jamais dans les enregistrements de match, d'équipe ou de
joueur de la ligue, ni dans le manager ni dans les affichages publics de la
ligue ; ce n'est qu'avec « Enregistrer dans le cloud » (ci-dessous) qu'il est
conservé sur le serveur, dans une table séparée qui lui est propre. Deux
fichiers par match sont conservés sur le serveur, sans
compte : la sauvegarde du match (le contenu d'un fichier de sauvegarde :
équipes, effectifs avec noms, numéros de maillot et dates de naissance,
officiels, signatures, déroulement du match) et, une fois le match validé, la
feuille de match en PDF. Ils sont rangés sous un code de sauvegarde aléatoire
(128 bits) que l'application crée pour le match et affiche dans la
préparation du match. Le code est le seul accès aux fichiers : il n'y a ni
liste ni recherche. La sauvegarde est chiffrée comme tout fichier de
sauvegarde de l'application (sans les PIN) : elle ne s'ouvre qu'avec le PIN
arbitre du match ou avec la clé de récupération de la fédération, que
celle-ci conserve hors ligne. Qui connaît le code et ce PIN peut restaurer le
match ; conserve-les donc comme un mot de passe. Une nouvelle sauvegarde
remplace la précédente. Les
fichiers sont supprimés 180 jours après la dernière modification ; les
sauvegardes du serveur (section 18) en gardent encore une copie quelque temps.
L'organisatrice ou l'organisateur du tournoi est responsable d'avoir le droit
d'enregistrer les données et d'informer les joueuses et joueurs et leurs
parents (section 17).

**Nouveau match sans compte (version suisse) :** déconnecté, « Nouveau
match » lance un match au format suisse sans compte. Il est traité comme un
match Global : il reste sur ton appareil, ne figure jamais dans les données de
matchs, d'équipes ou de joueurs de la ligue, et sa sauvegarde et la feuille de
match approuvée en PDF sont enregistrées de la même manière sous un code de
sauvegarde aléatoire (chiffrées, supprimées 180 jours après la dernière
modification). Il peut utiliser les informations publiques du calendrier de
Swiss Volley (équipes, salle, ligue, numéro du match, noms des arbitres, sans
dates de naissance) et une Einsatzliste lue sur l'appareil. Les équipes
enregistrées, les listes de licences des clubs, les effectifs envoyés par les
équipes et le répertoire des arbitres n'y sont pas disponibles, même si
quelqu'un se connecte plus tard sur l'appareil.

**Enregistrer dans le cloud (outil Global, facultatif) :** dans la
préparation du match, le marqueur peut activer « Enregistrer dans le cloud »
pour un match Global ; c'est désactivé par défaut. Le match est alors, en plus
de la sauvegarde et du PDF ci-dessus, aussi conservé lisible (non chiffré)
dans la base de données du serveur, sans compte : le contenu de la feuille de
match (équipes, effectifs avec noms, numéros de maillot et dates de naissance,
staff des équipes, officiels, déroulement du match, sets, remarques), sans les
PIN, les images des signatures, le code de sauvegarde et le code du tournoi ;
un résumé (noms, noms courts et couleurs des équipes, sets et points, état,
salle, ligue, heure prévue, numéro du match) ; et, une fois le match validé,
la feuille de match en PDF, sur laquelle figurent les signatures et les dates
de naissance. Le match est retrouvé par un hachage de son code de sauvegarde
et protégé par un hachage de son PIN arbitre ; le serveur ne conserve ni le
code ni le PIN. En option :

- **Lien de partage :** un lien en lecture seule avec un jeton aléatoire, que
  le marqueur active et désactive. Toute personne qui a le lien voit le
  résultat, les sets et la feuille de match en PDF sur
  livescore.openvolley.app.
- **Code du tournoi :** un code de 10 caractères, saisi sur les appareils de
  marque d'un tournoi. Toute personne qui a le code voit la liste de tous les
  matchs enregistrés avec lui, avec leurs résumés et leurs PDF, sur
  livescore.openvolley.app. Le serveur ne conserve le code que sous forme de
  hachage.
- **Autre appareil :** pour y continuer, tu restaures le match avec le code de
  sauvegarde et le PIN arbitre, comme ci-dessus.

La copie lisible, le lien de partage et le code du tournoi sont supprimés
180 jours après le dernier enregistrement, ou aussitôt que le marqueur choisit
« Supprimer du cloud » ; les sauvegardes du serveur (section 18) en gardent
encore une copie quelque temps. Sans « Enregistrer dans le cloud », rien de
tout cela n'est conservé. Ici aussi, l'organisatrice ou l'organisateur du
tournoi est responsable d'avoir le droit d'enregistrer les données et
d'informer les joueuses et joueurs et leurs parents (section 17).

**Écran en direct pour TV (facultatif, tout match, aussi OpenBeach) :** les
appareils de marque d'un événement peuvent activer un écran en direct avec un
code commun (Options, Écran en direct), pour les matchs de championnat, de
test, simples et Global. Tant qu'il est actif, chaque mise à jour en direct de
leurs matchs envoie aussi le code à mon serveur, avec un résumé du score : les
noms des équipes, leurs noms courts et leurs couleurs, les points, les sets
gagnés et les points des sets terminés, l'équipe au service, l'état du match
(par exemple temps mort, pause entre les sets, terminé), la salle ou le
terrain et l'heure prévue. Un appareil de marque qui passe par un relais de
salle ou par l'application de bureau envoie le même résumé par ce biais. Les
joueurs, le staff des équipes, les officiels, les alignements, les sanctions,
les remarques, les signatures et les PIN ne sont pas envoyés ; dans OpenBeach,
le nom d'une équipe est toutefois souvent celui de ses joueuses ou joueurs, et
il apparaît alors à l'écran. Le résumé est gardé uniquement dans la mémoire du
serveur, jamais dans une base de données ni dans un fichier, et il est
supprimé 45 minutes après la fin du match, après 3 heures sans mise à jour ou
au redémarrage du serveur. Toute personne qui connaît le code peut voir les
résumés de ses matchs sur openvolley.app/tv et livescore.openvolley.app ou les
lire via l'interface du serveur ; un relais de salle les montre aussi sur son
propre réseau. Un appareil de marque qui a un code d'écran en direct liste en
outre les résumés de ses matchs Global sur livescore.openvolley.app, pour tout
le monde et sans le code, sauf si « Afficher les matchs Global sur
livescore.openvolley.app » est désactivé sur cet appareil dans Options, Écran
en direct (c'est activé par défaut). Les matchs de championnat figurent de
toute façon dans le livescore ; les matchs de test et simples n'y sont jamais
listés. Désactive l'écran en direct dans les Options pour arrêter l'envoi.

**Validation avec NIP :** les officiels peuvent confirmer le résultat, en plus
de leur signature, avec un NIP de validation personnel. Sont enregistrés : le
NIP sous forme de hachage cryptographique (jamais en clair), les tentatives
échouées et blocages ; pour chaque validation, le match, la fonction (1er ou
2e arbitre, marqueur), ton compte, ton nom au moment de la validation,
l'heure, le résultat validé ainsi qu'un hachage pseudonymisé de l'adresse IP
et de l'appareil (pour détecter les abus). Les validations font partie du
procès-verbal du match. Tu vois tes propres validations ; le marqueur du
match et les administrateurs les voient aussi.

**Signer sur un téléphone (OpenVolley à partir de la version 2.4.0) :** au
lieu de signer sur l'appareil du marqueur, une personne peut signer sur son
propre téléphone. L'appareil affiche pour cela un code QR avec un lien vers
mon serveur (`backend.openvolley.app`) ou, en mode salle, vers l'ordinateur
portable sur le réseau local. Le lien est valable 10 minutes et pour une
seule signature. Le téléphone n'a besoin ni de compte ni d'application. La
page affiche le numéro du match, les équipes, la date, la fonction et, s'il
est connu, le nom de la personne qui signe. Le téléphone n'envoie que les
traits de la signature (pas d'image). Le serveur ou l'ordinateur portable ne
garde ces données qu'en mémoire vive, transmet la signature à l'appareil du
marqueur et la supprime au plus tard 5 minutes après la signature ; rien
n'est enregistré dans la base de données. Le téléphone n'enregistre rien : ni
cookies ni stockage local ; le lien n'est gardé que dans l'onglet du
navigateur pendant la session et est effacé à la fin. Seul l'appareil du
marqueur en fait l'image de la signature. Comme une signature dessinée sur
place, elle fait partie du match, avec la mention qu'elle a été faite sur un
téléphone (voie et heure). Via le serveur, le marqueur doit être connecté
avec un rôle de marqueur ou d'arbitre.

**Envoi des infos du match par e-mail :** un marqueur connecté peut se faire
envoyer les infos d'un match qu'il a saisi ou qu'il modifie (numéro du match,
équipes, date et lieu, sans NIP) à l'adresse e-mail confirmée de son propre
compte ; l'application le fait à la création d'un match. Aucune autre adresse
ne peut être saisie. Le service Resend (États-Unis) est utilisé pour l'envoi
(section 15).

**Envoi du NIP du match par e-mail :** juste après la création d'un nouveau
match officiel, l'application affiche une fois son NIP du match. Un marqueur
connecté peut alors se faire envoyer le NIP de ce match à l'adresse e-mail
confirmée de son propre compte, avec le numéro du match, les équipes, la
ligue, la date et l'heure. Rien n'est envoyé sans sa demande, aucune autre
adresse ne peut être saisie, et le serveur n'envoie le NIP que s'il
correspond à celui enregistré pour ce match. Son journal ne contient ni le NIP
ni l'adresse. Le service Resend (États-Unis) est utilisé pour l'envoi
(section 15). L'application peut aussi ouvrir l'application e-mail de
l'appareil avec le NIP, pour n'importe quelle adresse ; ce message est envoyé
par l'application e-mail et ne passe pas par mon serveur.

## 8. Affichages publics : livescore, panneaux LED, données publiques

Sans compte et sans NIP, sont visibles :

- **Livescore** (`livescore.openvolley.app`, `livescore-beach.openvolley.app`)
  et connexions en direct : noms, noms courts et couleurs des équipes, score,
  sets, service, composition, remplacements et sanctions **uniquement par
  numéro de maillot**, temps morts, ligue, salle, numéro du match. **En
  beach-volley, les noms des équipes sont en général les noms de famille des
  joueuses et joueurs ; ils sont donc publics.**
- **Panneaux LED** dans la salle : noms des équipes et score.
- **Convocations officielles** (section 11) : données du match avec les noms
  des arbitres et juges de ligne, sans dates de naissance.
- **Tournois de beach-volley publics** (section 10) : équipes, prénoms, noms
  et pays des joueuses et joueurs, têtes de série, classement, programme,
  terrains.

Ces données peuvent aussi être obtenues via l'interface de programmation du
serveur (`backend.openvolley.app`). Tout site web peut afficher le livescore
d'un match, ou les matchs du jour d'un club, avec le widget livescore (aussi
en `<iframe>`) ; il montre les mêmes données, sans noms de joueuses et de
joueurs.

**Jamais publics :** dates de naissance, numéros de licence, signatures,
validations, adresses e-mail et NIP. Les listes d'équipe avec les noms ne
sont visibles que pour qui connaît le NIP du match ou, pour un match Global
enregistré dans le cloud, son lien de partage ou son code du tournoi
(section 7).

## 9. Tablettes et mode salle (LAN)

**Les tablettes d'arbitre et de banc** (`referee.`, `bench.`,
`referee-beach.openvolley.app`) se connectent au match avec un NIP. La
tablette d'arbitre reçoit les deux listes d'équipe avec noms et numéros, le
score et les remarques ; une tablette de banc la liste de sa propre équipe et
seulement les numéros de maillot de l'autre équipe. Aucune ne reçoit de dates
de naissance, de signatures ni de données sur les officiels. La
tablette d'arbitre enregistre le NIP et le numéro du match dans le
navigateur ; efface les données du navigateur si plusieurs personnes
utilisent la tablette.

**Via le serveur (relais cloud) :** les données en direct passent par mon
serveur. Il ne les garde qu'en mémoire vive et les supprime 24 heures après la
dernière activité. Cela vaut aussi sans connexion.

**Mode salle (LAN) :** l'application de bureau peut servir les tablettes
directement sur le réseau local de la salle, aussi via le propre point d'accès
Wi-Fi de l'ordinateur portable. Les données restent alors dans le réseau
local et uniquement en mémoire vive. Le nom et le mot de passe du point
d'accès sont générés au hasard sur ton appareil à chaque démarrage. Seule
la synchronisation avec le serveur quitte le réseau local, et seulement si le
marqueur est connecté.

**Panneau LED (LedBox) :** un tableau d'affichage dans la salle peut reprendre
le score. Il ne reçoit que les noms des équipes, le score et les résultats
des sets, aucune donnée de joueuses ou joueurs.

## 10. Sites de gestion : équipes enregistrées, listes des équipes et tournois de beach-volley

Sur `manager.openvolley.app` et `manager-beach.openvolley.app`, les
gestionnaires de compétition peuvent préparer des équipes et des tournois.

**Équipes enregistrées :** nom de l'équipe, club, joueuses et joueurs avec
numéro, prénom et nom, numéro de licence, libéro/capitaine et (beach) pays ;
encadrement avec fonction, nom et numéro de licence ; pas de dates de
naissance. Visibles pour les gestionnaires de compétition et les
administrateurs du sport concerné. Dans OpenVolley, un compte de marqueur ne
voit que les équipes enregistrées de ses propres matchs de la saison en cours
(les équipes de ses clubs et leurs adversaires, et les matchs qu'il a saisis
ou modifie) ; un compte sans club seulement peu avant le match et pour
quelques matchs par semaine, chacun consigné dans le journal des
modifications. Les applications de marquage mettent ces équipes en cache et
les effacent à la déconnexion.

**Complétées à partir des matchs officiels (OpenVolley) :** après le tirage
au sort d'un match officiel en salle (jamais un match de test ni un match
Easy), le serveur ajoute toutes les personnes de la liste de chaque équipe à
l'équipe enregistrée de cette équipe pour la saison : les joueuses et joueurs
avec prénom et nom, numéro de maillot et numéro de licence, et les officiels
d'équipe (entraîneurs, kinésithérapeute, médecin) avec fonction, prénom et nom
et numéro de licence. Une personne qui y figure déjà (le même numéro de
licence, sinon le même nom) garde son entrée ; le dernier match officiel de
l'équipe fixe les numéros de maillot des joueuses et joueurs et les fonctions
des officiels d'équipe, et une joueuse ou un joueur de l'équipe enregistrée
qui avait ce numéro le perd. Personne n'est retiré, et les indications libéro
et capitaine de l'équipe enregistrée restent. Seuls les joueuses et joueurs et
les entraîneurs (entraîneur, entraîneur adjoint 1 et entraîneur adjoint 2)
avec un numéro de licence sont aussi ajoutés aux listes de licences du club
(ci-dessous), les joueuses et joueurs à la liste des joueurs, les entraîneurs
à la liste des entraîneurs, si les listes du club n'ont pas encore ce numéro
de licence ; un kinésithérapeute ou un médecin reste uniquement dans l'équipe
enregistrée.

**Responsables d'équipe (OpenVolley) :** les responsables d'un club peuvent
donner un lien à l'entraîneur ou au responsable d'une équipe de leur club ; la
personne qui l'ouvre et se connecte gère cette équipe. Le serveur enregistre
quel compte gère quelle équipe, qui l'a ajouté et quand. Un responsable
d'équipe modifie l'équipe enregistrée et peut envoyer à l'avance la liste de
chaque match de l'équipe : joueuses et joueurs avec numéro, prénom et nom,
numéro de licence et libéro/capitaine, ainsi que l'encadrement avec
fonction, nom et numéro de licence ; pas de dates de naissance.
S'ils le souhaitent, l'entraîneur et le capitaine peuvent signer cette liste à
l'avance ; les signatures sont enregistrées avec elle sous forme d'images.

**Listes envoyées à l'avance :** visibles pour les responsables de l'équipe,
les responsables de son club et les administrateurs, ainsi que pour les
comptes ayant le rôle de marqueur ou de gestionnaire de compétition
d'OpenVolley. Les appareils de marquage téléchargent les listes des prochains
matchs à domicile de leurs clubs, pour que la préparation du match fonctionne
sans internet. Quand le marqueur accepte une liste dans la préparation du
match, elle fait partie du match (section 7) et le serveur supprime aussitôt
les joueuses et joueurs, l'encadrement et les signatures ; il garde seulement
le fait que la liste a été acceptée, quand et par quel compte. Une liste que
personne n'accepte est supprimée 14 jours après le match. Sur un appareil de
marquage, la copie est supprimée dès que le serveur sait qu'elle a été
acceptée, à la déconnexion et au plus tard 36 heures après le match.

**Listes de licences des clubs (OpenVolley) :** les responsables d'un club
peuvent charger les listes des joueuses et joueurs, des marqueurs et des
entraîneurs du club depuis l'administration du club de VolleyManager. Le
fichier est lu dans le navigateur : seuls le numéro de licence, le nom, le
prénom et le sexe de chaque personne sont conservés ; la colonne de la date
de naissance n'est pas lue, et rien d'autre du fichier n'est envoyé au
serveur. Les listes sont visibles pour les responsables du club et les
administrateurs. Un responsable d'équipe du club voit les joueuses et joueurs
du sexe de son équipe et trouve les officiels d'équipe (un entraîneur peut
être n'importe quelle personne des listes du club) par une recherche par nom
qui montre quelques personnes à la fois. Les appareils des marqueurs du club
téléchargent les listes, afin que la préparation du match puisse ajouter des
joueurs et des officiels d'équipe sans internet. Le
sexe sert à ce qu'aucune joueuse ni aucun joueur ne soit inscrit dans une
équipe de l'autre sexe ; il n'est pas vérifié pour les officiels d'équipe.
Chaque chargement remplace les personnes du chargement précédent de cette
liste ; les listes sont supprimées avec le club, et celles des saisons passées
sont supprimées chaque jour. Les listes peuvent aussi
contenir des personnes qu'un responsable d'équipe ou un responsable du club a
ajoutées à la main depuis l'effectif d'une équipe, et les joueuses et
joueurs et les entraîneurs de la liste d'un match officiel (ci-dessus), avec
numéro de licence, noms et sexe uniquement ; un chargement les conserve, et elles sont supprimées avec leur
liste ou le club. Sur un appareil de marquage,
chaque téléchargement remplace la copie, et elle est supprimée à la
déconnexion.

**API des clubs (OpenVolley) :** les responsables d'un club peuvent créer
des jetons d'API pour le logiciel ou le site web du club (par exemple sa
gestion des membres). Un jeton appartient à ce club (ou à l'une de ses
équipes), agit avec les droits de la personne qui l'a créé et cesse de
fonctionner dès qu'il est révoqué, qu'il expire ou que cette personne ne gère
plus le club. Avec lui, le logiciel du club lit et, si le jeton le permet,
écrit les équipes du club, les listes envoyées à l'avance pour ses matchs, ses
équipes enregistrées et ses listes de licences, avec les données décrites
ci-dessus (noms, numéros de maillot, numéros de licence), ainsi que les
matchs du club tels que les montre l'interface publique (section 8). Seul un
jeton qui peut aussi les écrire lit les noms et numéros de licence, et un tel
jeton exige le mot de passe de la personne responsable. Le serveur ne
conserve du jeton qu'une empreinte, son nom, ses droits, l'équipe,
l'expiration et la dernière utilisation ; le journal des modifications
indique qui l'a créé ou révoqué, chaque modification faite avec lui et
chaque lecture de ces données personnelles. Ce que
le logiciel du club fait des données lues relève de la responsabilité du
club.

**Tournois de beach-volley :** titre, lieu, dates, équipes avec prénoms, noms,
numéros de licence et pays des joueuses et joueurs, programme, résultats,
noms des arbitres et marqueurs. Si un tournoi est marqué **public**, la page
publique du tournoi montre les équipes, les noms et les pays, jamais les
numéros de licence ni les dates de naissance.

**But :** réutiliser les listes d'équipe, préparer à l'avance la liste d'un match, ajouter les joueuses et
joueurs et les officiels d'équipe d'un club à une liste et vérifier le sexe des joueuses et joueurs par
rapport à celui de l'équipe, organiser des tournois, rattacher les joueuses et joueurs par numéro de
licence lors d'une importation, remplir les numéros de maillot pour le prochain match.

Ces données sont conservées jusqu'à ce qu'un gestionnaire les supprime, même
si le compte qui les a créées est supprimé.

## 11. Données concernant les arbitres

**Convocations de Swiss Volley :** chaque jour, le serveur reprend les
convocations officielles du VolleyManager de Swiss Volley, pour la période
d'hier à 14 jours à l'avance : équipes, salle et adresse, ligue, 1er et
2e arbitre avec leurs noms, juges de ligne, convocations. Le serveur utilise
pour cela un compte VolleyManager. But : charger les matchs officiels avec
les bons officiels. Les noms sont publics (section 8). VolleyManager envoie
aussi les dates de naissance des arbitres ; le serveur ne les lit pas et ne
les conserve pas (depuis le 19 novembre 2026 ; celles conservées auparavant
ont été effacées). Les convocations sont conservées comme les procès-verbaux
de match (section 16).

**Numéros de licence des arbitres :** depuis le 20 novembre 2026, le serveur
conserve aussi le numéro de licence (le numéro Swiss Volley) que
VolleyManager envoie pour le 1er et le 2e arbitre. Ces numéros ne sont pas
publics : seuls les administrateurs et les comptes qui marquent des matchs en
salle les voient, afin que l'application de marquage les inscrive à côté des
arbitres lorsqu'elle charge un match officiel. Ils sont effacés avec les
convocations (la saison du match et les 2 saisons suivantes, section 16), ou
plus tôt sur demande, avec le nom de l'arbitre (section 19). Une fois sur une
feuille de match, ils font partie du procès-verbal du match (section 7).

**Répertoire des arbitres :** un répertoire commun avec prénom et nom, pays
et sport, afin que le marqueur n'ait pas à saisir les officiels à chaque
fois ; pas de dates de naissance (celles conservées avant le 19 novembre 2026
ont été effacées). Les comptes qui marquent peuvent ajouter des entrées ; les
administrateurs peuvent les modifier et les supprimer. Seuls les administrateurs et les
comptes qui marquent voient le répertoire, pour saisir les officiels d'un
match officiel ; il n'est pas public, et les matchs de test et les matchs
Easy ne l'affichent pas.

Si tu ne souhaites pas figurer dans le répertoire, écris à
support@openvolley.app.

## 12. Téléchargements et mises à jour

- **Application de bureau :** 60 secondes après le démarrage, puis toutes les
  6 heures, à la connexion et sur demande, elle vérifie s'il existe une
  nouvelle version, jamais pendant un match en cours. Elle interroge
  `get.openvolley.app`, à défaut GitHub. Seule la requête habituelle est
  transmise (adresse IP, identifiant du programme).
- **Application Android depuis F-Droid :** l'application ne cherche pas
  elle-même de mises à jour ; c'est ton application F-Droid qui le fait.
- **Application Android installée directement :** l'application demande une
  fois si elle doit chercher des mises à jour (par défaut : non). Ce n'est que
  si tu acceptes qu'elle interroge `get.openvolley.app`, environ une fois
  par jour. Tu peux le désactiver dans les réglages.
- **Page d'accueil de app.openvolley.app :** si tu l'ouvres dans le
  navigateur d'un ordinateur, ton navigateur obtient de GitHub
  (`api.github.com`, États-Unis) la liste des dernières versions afin de
  proposer le bon téléchargement. GitHub reçoit ton adresse IP.
- **GitHub et F-Droid :** si tu télécharges chez eux, leurs déclarations de
  protection des données s'appliquent.

## 13. Support et contact

**Formulaire de support (dans les applications et sur openvolley.app/support) :**
il transmet à mon serveur ton adresse e-mail, le type et le domaine de
ta demande, ton message et, si tu en ajoutes, jusqu'à cinq pièces
jointes (par exemple des captures d'écran ou des fichiers de sauvegarde),
ainsi que la langue, l'adresse de la page sans ses paramètres, l'identifiant
du navigateur, l'heure, la plateforme (« web » depuis le site) et, dans les
applications, la version de l'application.

**Les diagnostics** ne sont envoyés que si « Joindre les diagnostics » est
coché. Pour une demande de support (signalement d'erreur ou question), la case
est déjà cochée, pour un retour ou une suggestion elle ne l'est pas ; tu
peux la décocher avant l'envoi. « Afficher ce qui est envoyé » te montre
auparavant exactement le texte envoyé. L'application le joint à la demande
sous forme de fichier texte (au plus 2 Mo). Il contient :

- des données techniques : application et version, plateforme, système
  d'exploitation, identifiant du navigateur, taille de l'écran et de la
  fenêtre, langue, heure et fuseau horaire, état en ligne et de la
  connexion, données pas encore transmises et dernières erreurs de
  transmission, mémoire utilisée, l'identifiant aléatoire de l'appareil et,
  si tu es connecté, l'identifiant de ton compte ;
- l'état du match ouvert (ou du dernier match ouvert) : numéro du match,
  équipes, statut, sets et score, compositions (numéros de maillot), temps
  morts et remplacements, les 30 derniers événements du match, et si le
  serveur a clôturé le match ou l'a confié à un autre appareil ;
- l'historique des deux dernières heures environ (au moins depuis le dernier
  démarrage de l'application), tiré du journal d'activité et du journal
  d'utilisation (section 5) : ce que tu as touché (avec son libellé, qui
  peut contenir des noms d'équipes ou de personnes), les touches, les écrans
  ouverts, dans quel champ tu as tapé combien de caractères (pas le
  texte), les points et autres événements du match, les corrections, les
  transmissions ainsi que le démarrage, la fermeture et la mise en
  arrière-plan de l'application ;
- les derniers messages d'erreur et avertissements de l'application, avec
  l'endroit du programme concerné.

**Ne sont jamais inclus** les mots de passe, NIP, jetons de connexion,
signatures, adresses e-mail, numéros de téléphone et le texte que tu as
tapé dans des champs : l'application retire ces données de tout le texte
avant l'envoi. Dans les vues de l'arbitre, du banc et du livescore, le
fichier ne contient que les données techniques, l'état de la connexion et
les messages d'erreur. Si l'envoi échoue, « Télécharger les diagnostics »
enregistre le fichier pour que tu puisses le joindre toi-même à ton
e-mail. Les versions plus anciennes de l'application n'envoient que les
données techniques, le numéro du match et les derniers messages d'erreur.
Le site web n'envoie pas de diagnostics.

Le serveur transmet la demande sous la forme d'un seul e-mail à
support@openvolley.app, avec ton adresse comme adresse de réponse. Il n'en
garde rien, sauf une ligne de journal avec le type, le domaine et une forme
abrégée de ton adresse e-mail (section 14). La boîte aux lettres est
hébergée par Migadu (section 15). Mon système de tickets
(support.openvolley.app), que j'exploite moi-même sur mon serveur chez Infomaniak en Suisse,
la lit, afin que je puisse te répondre et suivre ta demande. J'utilise
ton adresse uniquement pour te répondre. **Pour les demandes concernant
tes données, écris directement à support@openvolley.app.**

**E-mail à support@openvolley.app :** il est traité de la même manière, dans
la boîte aux lettres et dans le système de tickets.

**Durée de conservation :** je conserve les demandes de support (boîte aux
lettres et système de tickets, avec les pièces jointes et les diagnostics) 2
ans après le dernier message, afin de pouvoir retrouver les réponses
précédentes ; plus tôt sur demande.

## 14. Journaux et sécurité sur le serveur

- **Journaux du serveur :** le serveur journalise les requêtes sans contenu
  et **sans adresses IP** (statut, code d'erreur, identifiant de la requête).
  Exception : une demande de support est journalisée avec une forme abrégée
  de ton adresse e-mail (section 13). Les requêtes lentes ou échouées de la
  base de données sont journalisées sans leurs valeurs. Les journaux sont
  écrasés selon leur taille (au plus 10 fichiers de 20 Mo par service), en
  général après quelques jours à quelques semaines.
- **Rapports d'erreur :** les erreurs du serveur lui-même sont enregistrées
  comme rapports d'erreur (section 5), sans contenu et sans adresses IP.
  L'adresse IP d'un appareil qui envoie des rapports n'est utilisée qu'en
  mémoire, pour en limiter le nombre.
- **Cloudflare** traite l'adresse IP, l'adresse demandée et l'identifiant du
  navigateur de chaque requête et les conserve selon ses propres règles.
- **Adresses IP uniquement en mémoire vive :** pour se protéger des abus, le
  serveur limite les requêtes et les connexions par adresse IP, et le relais
  en direct s'en sert pour reconnaître les appareils d'une même salle. Il ne
  garde les adresses IP qu'en mémoire vive et ne les enregistre ni ne les
  journalise (sauf sous forme de hachage pseudonymisé d'une validation,
  section 7).
- **Journal des modifications :** pour la traçabilité, le serveur consigne qui
  a modifié des rôles, validé, clôturé ou rouvert des matchs, ajouté des
  co-éditeurs ou modifié des inscriptions à un tournoi, et quand. Les entrées
  peuvent contenir les adresses e-mail de co-éditeurs et les noms d'équipes de
  beach-volley. Seuls les administrateurs voient ce journal.
- **Clubs et feuilles de match par e-mail :** le journal des modifications
  consigne aussi qui a désigné des responsables de club, retiré un compte
  d'un club, modifié l'adresse de contact d'un club ou activé ou désactivé
  l'envoi des feuilles de match, et que la feuille d'un match a été envoyée,
  avec le nombre de destinataires. Il ne contient aucune adresse e-mail.
- **Équipes :** le journal des modifications consigne aussi qui gère une
  équipe et qui a envoyé, supprimé ou accepté la liste d'un match, avec le
  nombre de joueuses, joueurs et membres de l'encadrement et si elle était
  signée, jamais de noms ni de signatures, et quand.
- **Comptes supprimés :** le journal des modifications consigne qu'un
  administrateur a supprimé un compte ou refusé un nouveau compte, avec les
  rôles et les applications du compte, sa date de création, le nombre de
  matchs officiels qu'il laisse et un hachage pseudonymisé de son adresse
  e-mail, jamais l'adresse ni le nom.
- **Conservation et caviardage :** le journal des modifications consigne
  chaque effacement quotidien de procès-verbaux échus (seulement la date
  limite et le nombre d'entrées effacées) et chaque rectification ou
  effacement des données d'une personne sur demande (seulement le type, un
  hachage pseudonymisé de la personne et le nombre par table, jamais le nom).
- **Signer sur un téléphone :** le serveur ne journalise que les étapes
  (démarrée, ouverte, signée, terminée) avec la fonction et un identifiant
  court, jamais le lien, la signature, des noms ou des équipes.

## 15. Destinataires et sous-traitants

Je transmets des données personnelles uniquement aux prestataires dont j'ai
besoin pour l'exploitation. Ils traitent les données sur mandat.

| Prestataire | Tâche | Pays |
|---|---|---|
| Infomaniak Network SA | Hébergement du serveur : base de données, fichiers, helpdesk et page de téléchargement | Suisse |
| Cloudflare, Inc. | Diffusion des sites, DNS, connexion sécurisée au serveur | États-Unis (réseau mondial) |
| Migadu | Envoi d'e-mails (noreply@) et boîte aux lettres (support@) | Suisse / Europe |
| Resend, Inc. | Envoi des infos du match et du NIP du match par e-mail (seulement ces fonctions, si activées) | États-Unis |

**Important concernant Cloudflare :** la connexion chiffrée de ton appareil
se termine chez Cloudflare ; de là, elle se poursuit chiffrée jusqu'à mon
serveur. Cloudflare peut donc techniquement voir le contenu des requêtes, y
compris les listes d'équipe. Cloudflare ne peut
utiliser les données que pour fournir son service.

**Sont responsables de manière indépendante :** GitHub, Inc. (États-Unis) pour
les téléchargements et la liste des versions, F-Droid pour le catalogue
d'applications, Swiss Volley pour les données du VolleyManager.

**Les sauvegardes** sont conservées chiffrées sur mon serveur chez Infomaniak
et sur mon propre support de stockage, tous deux en Suisse. Elles sont
chiffrées avant de quitter le serveur ; personne d'autre ne peut les lire
(section 18).

**Communication à l'étranger :** selon le Conseil fédéral, les États de l'UE
et de l'EEE offrent une protection adéquate des données. Pour les États-Unis, je me
fonde sur le Swiss-U.S. Data Privacy Framework lorsque le prestataire est
certifié, et sinon sur les clauses contractuelles types des contrats des
prestataires. Tu peux me demander une copie de ces garanties.

## 16. Durée de conservation

| Données | Conservation |
|---|---|
| Compte et profil | Jusqu'à ce que tu supprimes le compte ou qu'un administrateur le supprime (sur demande, ou un nouveau compte refusé) |
| Session | 30 jours après la dernière utilisation, 90 jours au plus |
| Liens dans les e-mails | Valables 60 minutes ou 24 heures, effacés 7 jours plus tard |
| NIP de validation | Jusqu'à ce que tu le supprimes ou supprimes ton compte |
| Feuilles de match, événements, historique des événements, signatures, validations, remarques (données de santé comprises), fichiers des feuilles de match | Comme procès-verbal officiel : la saison du match et les 2 saisons suivantes (une saison va du 1er juillet au 30 juin), puis effacés par un passage quotidien ; par exemple, les procès-verbaux de la saison 2024/25 partent le 1er juillet 2027. Plus tôt sur demande dans la mesure où le procès-verbal n'a pas besoin des données (section 19) |
| Équipes enregistrées, tournois de beach-volley | Jusqu'à ce qu'un gestionnaire les supprime, ou sur demande |
| Répertoire des arbitres | Jusqu'à ce qu'un administrateur supprime l'entrée ; effacement sur demande |
| Convocations de Swiss Volley | Comme les procès-verbaux de match : la saison du match et les 2 saisons suivantes |
| Journal des modifications | Aussi longtemps que nécessaire pour la traçabilité ; effacement examiné sur demande |
| Adresse de contact d'un club | Jusqu'à sa modification ou sa suppression, ou la suppression du club |
| Responsables de club | Jusqu'à ce que les administrateurs les retirent, que le club soit supprimé ou que tu supprimes ton compte |
| Responsables d'équipe | Jusqu'à ce qu'un responsable de club ou un administrateur les retire, que l'équipe ou le club soit supprimé ou que tu supprimes ton compte |
| Liste envoyée à l'avance (joueuses et joueurs, encadrement, signatures) | Jusqu'à ce qu'un marqueur l'accepte, au plus tard 14 jours après le match ; la mention de l'acceptation 14 jours après le match |
| Listes de licences d'un club (numéro de licence, noms, sexe) | Jusqu'au prochain chargement de cette liste, sa suppression par un responsable du club ou la suppression du club, au plus tard jusqu'à la fin de la saison ; personnes ajoutées à la main ou depuis la liste d'un match : jusqu'à la suppression de la liste ou du club, au plus tard jusqu'à la fin de la saison ; sur un appareil de marquage jusqu'au prochain téléchargement ou à la déconnexion |
| Adresse e-mail d'un arbitre ou d'une équipe pour un match | Avec le match, comme partie de la feuille de match |
| Envoi de la feuille de match finale (moment, nombre de destinataires, sans adresses) | Avec le match |
| Feuille d'un match de test par e-mail | Non conservée sur le serveur |
| Outil Global : sauvegarde et feuille de match PDF d'un match (sous le code de sauvegarde) | 180 jours après la dernière modification |
| Outil Global, « Enregistrer dans le cloud » : copie lisible d'un match, lien de partage, code du tournoi (sous forme de hachage) | 180 jours après le dernier enregistrement, ou à la suppression du cloud |
| Écran en direct : résumé du score d'un match dont l'appareil de marque l'a activé (noms des équipes, points, sets ; aucun joueur) | Uniquement dans la mémoire du serveur ; supprimé 45 minutes après la fin du match, après 3 heures sans mise à jour ou au redémarrage du serveur |
| Copies de sauvegarde téléversées | 30 jours |
| Journaux de l'application téléversés | 30 jours ; effacés avec ton compte |
| Journal d'activité d'un match (serveur) | 24 mois, au plus tard jusqu'à la suppression du match ; plus tôt sur demande |
| Journal d'activité sans match (serveur) | 90 jours ; les entrées enregistrées sous ton compte sont effacées avec lui |
| Rapports d'erreur (serveur) | 90 jours ; ceux envoyés pendant que tu étais connecté sont effacés avec ton compte ; plus tôt sur demande |
| Historique des événements (événements annulés et corrigés) | Avec le match, comme partie du procès-verbal du match |
| Journal d'activité sur l'appareil | Entrées envoyées 180 jours (au plus 100 000) ; entrées pas encore envoyées jusqu'à leur envoi (au plus 200 000) ; au plus 30 fichiers quotidiens et 50 Mo |
| Journal d'utilisation (uniquement sur l'appareil) | OpenVolley à partir de 2.4.0 : 30 jours, au plus 50 000 entrées |
| Fichier journal de l'application de bureau (uniquement sur l'appareil) | Au plus cinq anciens fichiers de 5 Mo chacun |
| Signature sur un téléphone (serveur ou ordinateur portable) | Uniquement en mémoire vive ; lien valable 10 minutes, signature supprimée au plus tard 5 minutes après la signature |
| Demandes de support (boîte aux lettres et système de tickets, avec les pièces jointes et les diagnostics) | 2 ans après le dernier message ; plus tôt sur demande |
| Journaux du serveur | Écrasés selon leur taille, au plus 10 fichiers de 20 Mo par service (quelques jours à quelques semaines) |
| Données en direct (serveur et mode salle) | Uniquement en mémoire vive ; sur le serveur supprimées 24 heures après la dernière activité |
| Sauvegardes | Jusqu'à environ 6 mois (section 18) |
| Données sur ton appareil | Jusqu'à ce que tu les supprimes ; fichiers de sauvegarde des applications de bureau et Android 30 jours |

**Dates de naissance effacées (19 novembre 2026).** Depuis, aucune date de
naissance n'est conservée en dehors de la feuille de match d'un match, et là
seulement si le marqueur en a tapé une (section 7). Les dates de naissance
enregistrées auparavant ont été effacées sur le serveur : dans les comptes
(le profil et la copie conservée de l'inscription), les listes de licences
des clubs, les équipes enregistrées, les listes envoyées à l'avance, le
répertoire des arbitres, les convocations de Swiss Volley et les
procès-verbaux des matchs passés (listes d'équipe, encadrement, officiels,
listes chargées par les équipes, les entrées et remarques des corrections,
l'historique des événements). Les numéros de licence restent. Les PDF des
feuilles de match enregistrés sont refaits à partir des procès-verbaux
corrigés ; un fichier qui ne peut pas être refait ainsi (par exemple une
feuille de match de beach-volley) reste tel quel jusqu'à ce que je l'aie
vérifié, et n'est pas effacé sans cette vérification. Ce que je ne peux pas
atteindre : les e-mails déjà envoyés (par exemple une feuille de match
finale) ; les sauvegardes chiffrées, qui gardent des copies plus anciennes
jusqu'à environ 6 mois (section 18) ; et les copies hors de mon serveur,
comme les données sur des appareils et les fichiers de sauvegarde sur un
ordinateur, une clé USB ou dans le dossier « Documents » d'Android, jusqu'à
ce qu'ils soient écrasés ou effacés (une application de marquage mise à jour
retire les dates de naissance des matchs suisses de son appareil qui ne sont
pas en cours). Les matchs Global ne sont pas concernés : leur organisatrice
ou organisateur choisit ce qui figure à côté d'un nom, et leurs fichiers et
copies dans le cloud sont conservés comme décrit à la section 7.

## 17. Mineurs

Beaucoup de joueuses et joueurs sont mineurs. Leurs données (nom, numéro,
numéro de licence) ne sont pas saisies par eux-mêmes, mais par les clubs, les
responsables d'équipe, les marqueurs ou les organisateurs. Ceux-ci doivent
être autorisés à saisir les données et en informer les joueuses et joueurs et
leurs parents. La date de naissance d'une joueuse ou d'un joueur ne figure
que sur la feuille d'un match où le marqueur en tape une (dans l'outil
Global, si l'organisatrice ou l'organisateur l'a choisie), jamais dans les
listes des clubs, les équipes enregistrées ou les listes envoyées à
l'avance ; elle n'est jamais publique, le numéro de licence non plus.

Dans l'outil Global, l'organisatrice ou l'organisateur du tournoi, ou la
personne qui saisit les données, est responsable de la même manière. Les
parents peuvent demander la suppression de la sauvegarde ou de la copie dans
le cloud d'un match ; il me
faut alors le code de sauvegarde ou les indications du match (section 19).

Les parents ou autres représentants légaux peuvent exercer les droits de la
section 19 pour leur enfant.

## 18. Sécurité et sauvegardes

- Connexions chiffrées (HTTPS) pour tous les sites et le serveur.
- Les mots de passe, NIP et jetons de connexion ne sont enregistrés sur le
  serveur que sous forme de hachage.
- La base de données et les fichiers enregistrés se trouvent sur des volumes
  chiffrés sur le serveur (LUKS2, AES). La clé n'est pas enregistrée sur le
  serveur.
- Accès selon les rôles ; tablettes uniquement avec NIP ; les matchs clôturés
  sont en lecture seule.
- Limitation des tentatives de connexion et blocage après des échecs.
- Sauvegardes : le serveur sauvegarde la base de données chaque heure et les
  fichiers chaque jour, **chiffrés**. Les sauvegardes sont copiées chaque heure
  sur mon propre support de stockage en Suisse et y sont conservées dans des
  instantanés quotidiens, hebdomadaires et mensuels **jusqu'à environ
  6 mois**. Des données effacées
  peuvent donc subsister jusqu'à environ 6 mois dans ces sauvegardes
  chiffrées ; elles ne servent qu'à une restauration.
- Les fichiers de sauvegarde et les fichiers journaux de l'application de
  bureau ne sont lisibles que par ton compte utilisateur et ne contiennent
  aucun NIP.

Aucun système n'est parfaitement sûr. Si tu trouves une faille de sécurité,
signale-la à support@openvolley.app.

## 19. Tes droits

Tu as le droit :

- d'obtenir **l'accès** aux données que je traite à ton sujet ;
- de faire **rectifier** des données inexactes ;
- de faire **effacer** ou anonymiser des données ;
- de t'**opposer** au traitement ;
- de faire **limiter** le traitement, par exemple pendant l'examen d'une
  rectification ;
- de **recevoir** tes données dans un format courant ou de les faire
  transmettre (les applications permettent aussi de télécharger les copies de
  sauvegarde, les feuilles de match et le journal d'activité) ;
- de **retirer un consentement** à tout moment (par exemple pour la recherche
  de mises à jour sur Android).

Écris à **support@openvolley.app**. Je réponds dans les 30 jours. Afin de ne
pas transmettre de données à la mauvaise personne, je peux demander une
preuve de ton identité.

**Effacement dans les feuilles de match officielles :** une feuille de match
clôturée est le procès-verbal officiel d'un match, auquel les clubs, la
fédération et les officiels ont un intérêt. J'efface ou anonymise tes données
qui s'y trouvent dans la mesure où le procès-verbal n'en a pas besoin, et je
t'explique ce qui subsiste et pourquoi. Une rectification (par exemple
d'un nom mal orthographié) ou un effacement se fait dans toutes les
copies sur le serveur à la fois : dans les procès-verbaux avec leur
historique et leurs journaux, dans les listes des clubs et les équipes
enregistrées, dans le répertoire des arbitres et dans les convocations. Le
numéro de maillot et la fonction restent là où le procès-verbal en a besoin,
et le PDF de la feuille de match est refait. Je ne peux pas atteindre les
copies hors de mon serveur (sur des appareils, dans des e-mails déjà
envoyés). Les sauvegardes chiffrées gardent les anciennes données jusqu'à
environ 6 mois (section 18) ; si l'une d'elles devait être restaurée,
j'appliquerais à nouveau ta demande.

**Plainte :** tu peux t'adresser au Préposé fédéral à la protection des
données et à la transparence (PFPDT, www.edoeb.admin.ch). Si tu résides dans
l'UE ou l'EEE, également à l'autorité de protection des données de ton
pays.

## 20. Bases juridiques (RGPD)

Lorsque le RGPD s'applique, je me fonde sur :

- **le contrat** (art. 6, par. 1, let. b RGPD) : compte (avec le numéro de
  licence facultatif), synchronisation, e-mails liés au compte, support,
  fonctions que tu utilises, la sauvegarde en ligne et la copie dans le cloud de l'outil Global ;
- **l'intérêt légitime** (art. 6, par. 1, let. f RGPD) : des procès-verbaux
  de match officiels corrects et vérifiables pour les clubs, la fédération et
  les officiels (listes d'équipe, numéros de licence et, là où le marqueur en
  tape une sur la feuille, la date de naissance pour le contrôle de la
  qualification, signatures, validations, journal d'activité, historique
  des événements et remarques), les équipes enregistrées et les listes des
  clubs complétées à partir des listes des matchs officiels, l'envoi de la
  feuille de match finale aux officiels et aux clubs, le livescore pour le public, l'organisation de tournois, le
  dépannage (y compris les rapports d'erreur des applications, que tu peux
  désactiver), la sécurité et la protection contre les abus, les sauvegardes ;
- **le consentement** (art. 6, par. 1, let. a RGPD) : recherche de mises à
  jour de l'application Android installée directement ;
- **pour les données de santé** (une blessure ou une maladie consignée dans
  un match, section 7) : les règles de jeu exigent l'enregistrement d'un tel
  remplacement et d'un libéro qui ne peut plus jouer. Selon le RGPD, je me
  fonde sur l'art. 9, par. 2, let. f (constatation, exercice ou défense de
  droits en justice : les réclamations et recours d'une compétition sont
  tranchés sur la base du procès-verbal), avec l'intérêt légitime ci-dessus ;
  selon la LPD, sur l'intérêt prépondérant à un procès-verbal officiel
  correct. L'application n'enregistre automatiquement que les termes des
  règles.

Selon la LPD suisse, je ne traite des données que pour les finalités
indiquées et dans la mesure nécessaire.

**Aucune obligation de fournir des données :** tu n'es tenu ni par la
loi ni par un contrat de me fournir des données. Sans adresse e-mail et mot
de passe, je ne peux toutefois pas ouvrir de compte, et sans listes d'équipe
il n'y a pas de feuille de match.

## 21. Modifications

J'adapte cette déclaration lorsque les applications ou le droit changent. La
version publiée sur cette page, avec la date indiquée en haut, fait foi.
