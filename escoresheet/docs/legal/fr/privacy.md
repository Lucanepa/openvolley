# Déclaration de protection des données

**OpenVolley et OpenBeach** · Version 1.0 · État au 7 octobre 2026

Cette déclaration existe en allemand, anglais, français et italien. Seule la
version allemande fait foi.

## En bref

- OpenVolley est un projet open source privé et non commercial. Il n'y a ni
  publicité, ni suivi (tracking), ni outil d'analyse, ni cookies.
- Les applications fonctionnent hors ligne. Vos matchs sont enregistrés sur
  votre appareil, et dans la base de données du serveur seulement une fois que
  vous êtes connecté. Pour que les tablettes reçoivent un match en cours, les
  applications navigateur et Android le font passer par mon serveur même sans
  connexion, uniquement en mémoire vive.
- Une feuille de match électronique contient des données sur les joueuses et
  joueurs, l'encadrement et les officiels : noms, numéros de maillot, dates de
  naissance et signatures. Seuls les noms des équipes, le score et les numéros
  de maillot sont publics ; en beach-volley aussi les noms des joueuses et
  joueurs, ainsi que les noms des arbitres des matchs officiels.
  **Les dates de naissance, numéros de licence et signatures ne sont jamais
  publics.**
- Le serveur se trouve en Allemagne (Hetzner). Cloudflare (États-Unis) diffuse
  les sites web et transmet le trafic au serveur.
- Vous pouvez demander à tout moment l'accès, la rectification ou
  l'effacement : **support@openvolley.app**.

## 1. Qui est responsable

Le responsable du traitement est :

**Luca Canepa**, personne privée, Suisse\
Adresse postale : voir les [mentions légales](impressum.md)\
E-mail : support@openvolley.app

J'exploite OpenVolley en tant que personne privée. Je n'ai pas désigné de
conseiller à la protection des données ; je n'y suis pas tenu. Pour toute
question sur la protection des données, écrivez à support@openvolley.app.

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
  mémoire de votre navigateur ou appareil (localStorage et IndexedDB) : les
  données des matchs pour le mode hors ligne, vos réglages et, si vous êtes
  connecté, un jeton de connexion.
- **Pas de suivi, pas de publicité, pas d'analyse.** Il n'y a ni outil
  d'analyse, ni envoi de rapports d'erreur à des tiers, ni publicité, ni
  profilage, ni décision individuelle automatisée. Je ne vends pas de données.
- **Pas de contenus de tiers.** Les polices et le code des programmes
  viennent de nos propres sites, pas de serveurs tiers. Les exceptions sont
  nommées expressément (section 12).
- **Hors ligne d'abord.** Ce que vous saisissez sans vous connecter n'est
  enregistré que sur votre appareil. Pour la transmission aux tablettes, voir
  la section 9.

## 4. Site web et page de téléchargement

**openvolley.app** et **get.openvolley.app** sont des pages statiques sans
formulaire et sans scripts de tiers. Lors de l'affichage, Cloudflare traite
les données techniquement nécessaires : adresse IP, adresse demandée, heure
et identifiant du navigateur. Mon serveur ne tient pas de journal d'accès pour
get.openvolley.app.

Les liens vers GitHub et F-Droid mènent à des services qui sont eux-mêmes
responsables de leurs traitements de données.

## 5. Les applications de marquage (navigateur, bureau, Android)

**Sans connexion**, l'application enregistre tout uniquement sur votre
appareil : matchs, équipes, listes d'équipe avec dates de naissance, sets,
événements du match, listes d'officiels, réglages et un journal local de
l'utilisation (pour le dépannage ; vous pouvez le télécharger vous-même). Les
matchs restent enregistrés jusqu'à ce que vous les supprimiez ou effaciez les
données de l'application.

**Transmission en direct, même sans connexion.** Dès qu'un match est créé,
les applications navigateur et Android l'envoient (équipes, listes d'équipe,
score, événements) au relais en direct de mon serveur, afin que les tablettes
de l'arbitre et du banc le reçoivent (section 9). Il n'y est gardé qu'en
mémoire vive. L'application de bureau utilise à la place son propre relais
sur le réseau local.

**Avec connexion**, l'application synchronise vos matchs avec le serveur
(section 7). Elle téléverse en plus :

- des **copies de sauvegarde** d'un match (complètes, avec listes d'équipe,
  dates de naissance et signatures). Seul votre compte peut les lire. Elles
  sont effacées après 30 jours ;
- des **journaux de l'application** (messages techniques ; ils peuvent
  contenir des noms et des numéros de match). Seul votre compte peut les
  lire. Ils sont conservés jusqu'à la suppression de votre compte ;
- les **feuilles de match** comme fichiers (PDF et données), voir section 7.

**Application de bureau.** L'application de bureau enregistre en plus des
fichiers de sauvegarde automatiques des matchs dans votre dossier utilisateur
(Linux : `~/.local/share/OpenVolley/backups`, Windows :
`%APPDATA%\OpenVolley\backups`). Ils contiennent les noms et les dates de
naissance, mais aucun NIP, et sont effacés après 30 jours.

**Application Android.** L'application Android dépose ses fichiers de
sauvegarde dans le dossier public « Documents ». **Ces fichiers subsistent
après la désinstallation de l'application et, sous Android 10 et versions
antérieures, d'autres applications peuvent aussi les lire.** Supprimez-les
vous-même si nécessaire. Si vous avez activé la sauvegarde Google de
l'appareil, Android peut aussi sauvegarder les données de l'application (avec
les listes d'équipe) dans votre compte Google ; les conditions de Google
s'appliquent.

Sur un appareil partagé, déconnectez-vous après le match. La déconnexion
efface votre jeton de connexion et les équipes mises en cache.

## 6. Compte et e-mails

Il vous faut un compte pour synchroniser des matchs, gérer des équipes et des
tournois ou valider des résultats en tant qu'officiel. Les comptes s'ouvrent
sur `manager.openvolley.app` et `manager-beach.openvolley.app`.

**Données :** adresse e-mail, mot de passe (enregistré uniquement sous forme
de hachage, jamais en clair), prénom et nom, pays, date de naissance
(facultative), rôles (par exemple marqueur, arbitre, gestionnaire de
compétition), les applications concernées (salle, beach), dates de création,
de dernière connexion et de confirmation de l'e-mail. Les indications saisies
à l'inscription sont aussi conservées en copie avec le compte.

**But :** connexion, déblocage des fonctions de votre rôle et préremplissage
de vos propres données sur la feuille de match (nom, pays, date de naissance).

**Les nouveaux comptes** n'ont d'abord aucun rôle. Un administrateur les
valide, ou vous utilisez un code d'invitation. Le système enregistre qui a
utilisé quel code et quand.

**Connexion :** après la connexion, votre navigateur enregistre un jeton de
connexion. Le serveur n'en garde qu'un hachage. Une session dure 30 jours
après la dernière utilisation, 90 jours au plus, et se termine à la
déconnexion, au changement de mot de passe et à la suppression du compte.
Pour se protéger des attaques, le serveur compte les tentatives échouées par
adresse IP et par adresse e-mail, uniquement en mémoire vive.

**E-mails :** je n'envoie que des e-mails liés au compte : confirmation de
l'adresse e-mail, lien de réinitialisation du mot de passe, avis de
changement du mot de passe, avis qu'un résultat a été validé avec votre NIP
de validation et avis que votre NIP a été bloqué. Ils ne contiennent ni pixel
de suivi ni image chargée à distance. Un lien de confirmation est valable
24 heures, un lien de réinitialisation 60 minutes.

**Qui voit vos données de compte :** vous-même et les administrateurs
d'OpenVolley (moi et les personnes que je désigne).

**Supprimer votre compte :** vous pouvez supprimer votre compte vous-même dans
l'application à tout moment. Sont alors effacés le compte, le profil, les
sessions, le NIP de validation, les codes d'invitation utilisés ainsi que vos
copies de sauvegarde et journaux téléversés. **Subsistent** les documents
officiels auxquels d'autres ont un intérêt : les feuilles de match que vous
avez saisies, les validations que vous avez données (avec votre nom tel
qu'il figure sur la feuille de match), les équipes et tournois enregistrés et
les entrées du journal des modifications (section 14). Votre compte est
dissocié de ces entrées. Vous pouvez faire effacer ce qui subsiste selon la
section 19, dans la mesure où la feuille de match n'en a pas besoin.

## 7. Données des matchs et feuilles de match

**Contenu d'un match :** numéro du match, ligue, salle et localité, équipes
(nom, nom court, couleur), listes d'équipe avec numéro de maillot, prénom et
nom, date de naissance et indication libéro ou capitaine, encadrement
(fonction, nom, date de naissance), officiels (arbitres, marqueur, juges de
ligne avec nom, pays, date de naissance), **signatures** (images dessinées sur
l'appareil), tirage au sort, déroulement du match avec tous les événements,
remplacements et sanctions, résultats et corrections ultérieures.

**Qui saisit les données :** le marqueur dans l'application, les responsables
d'équipe sur la page des listes d'équipe (`roster.openvolley.app`), les
gestionnaires de compétition au moyen des équipes enregistrées (section 10)
et les convocations officielles de Swiss Volley (section 11). Les joueuses et
joueurs ne saisissent pas eux-mêmes leurs données.

**But :** une feuille de match électronique pour les matchs officiels :
saisie pendant le match, procès-verbal officiel du match, contrôle de la
qualification et de la catégorie d'âge, livescore.

**Qui voit quoi :**

| Qui | Quoi |
|---|---|
| Le compte qui a saisi le match ; les comptes qui ont saisi le NIP du match ; les administrateurs | Tout |
| Tablettes d'arbitre et de banc avec NIP | Équipes, listes d'équipe avec noms et numéros, score. **Pas** de dates de naissance, signatures, officiels ni validations |
| Tout le monde (public) | Voir section 8 |

Une fois un match validé et clôturé, personne ne peut plus le modifier, pas
même la personne qui l'a saisi. Seul un administrateur peut le rouvrir.

**Fichiers des feuilles de match :** à la fin du match, l'application
téléverse la feuille de match en PDF et sous forme de fichier de données.
Seul le compte qui l'a téléversée peut la lire (via
`scoresheet.openvolley.app`), ainsi que les administrateurs. Si ce compte est
supprimé, le fichier reste conservé comme procès-verbal du match, mais
personne ne peut plus l'ouvrir jusqu'à ce qu'un administrateur rétablisse
l'accès.

**Validation avec NIP :** les officiels peuvent confirmer le résultat, en plus
de leur signature, avec un NIP de validation personnel. Sont enregistrés : le
NIP sous forme de hachage cryptographique (jamais en clair), les tentatives
échouées et blocages ; pour chaque validation, le match, la fonction (1er ou
2e arbitre, marqueur), votre compte, votre nom au moment de la validation,
l'heure, le résultat validé ainsi qu'un hachage pseudonymisé de l'adresse IP
et de l'appareil (pour détecter les abus). Les validations font partie du
procès-verbal du match. Vous voyez vos propres validations ; le marqueur du
match et les administrateurs les voient aussi.

**Envoi des infos du match par e-mail :** si vous envoyez les infos du match
à une adresse e-mail depuis l'application, le numéro du match, le NIP du
match, les équipes, la date et le lieu sont envoyés à l'adresse saisie.
L'adresse du destinataire est consignée dans le journal du serveur. Le
service Resend (États-Unis) peut être utilisé pour l'envoi (section 15).

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
- **Répertoire des arbitres** (section 11) : prénom et nom, pays, sans dates
  de naissance.
- **Tournois de beach-volley publics** (section 10) : équipes, prénoms, noms
  et pays des joueuses et joueurs, têtes de série, classement, programme,
  terrains.

Ces données peuvent aussi être obtenues via l'interface de programmation du
serveur (`backend.openvolley.app`).

**Jamais publics :** dates de naissance, numéros de licence, signatures,
validations, adresses e-mail et NIP. Les listes d'équipe avec les noms ne
sont visibles que pour qui connaît le NIP du match.

## 9. Tablettes et mode salle (LAN)

**Les tablettes d'arbitre et de banc** (`referee.`, `bench.`,
`referee-beach.openvolley.app`) se connectent au match avec un NIP. Elles
reçoivent les équipes, les listes d'équipe avec noms et numéros et le score,
mais ni dates de naissance, ni signatures, ni données sur les officiels. La
tablette d'arbitre enregistre le NIP et le numéro du match dans le
navigateur ; effacez les données du navigateur si plusieurs personnes
utilisent la tablette.

**Via le serveur (relais cloud) :** les données en direct passent par mon
serveur. Il ne les garde qu'en mémoire vive et les supprime 24 heures après la
dernière activité. Cela vaut aussi sans connexion.

**Mode salle (LAN) :** l'application de bureau peut servir les tablettes
directement sur le réseau local de la salle, aussi via le propre point d'accès
Wi-Fi de l'ordinateur portable. Les données restent alors dans le réseau
local et uniquement en mémoire vive. Le nom et le mot de passe du point
d'accès sont générés au hasard sur votre appareil à chaque démarrage. Seule
la synchronisation avec le serveur quitte le réseau local, et seulement si le
marqueur est connecté.

**Panneau LED (LedBox) :** un tableau d'affichage dans la salle peut reprendre
le score. Il ne reçoit que les noms des équipes, le score et les résultats
des sets, aucune donnée de joueuses ou joueurs.

## 10. Sites de gestion : équipes enregistrées et tournois de beach-volley

Sur `manager.openvolley.app` et `manager-beach.openvolley.app`, les
gestionnaires de compétition peuvent préparer des équipes et des tournois.

**Équipes enregistrées :** nom de l'équipe, club, joueuses et joueurs avec
numéro, prénom et nom, date de naissance, numéro de licence, libéro/capitaine
et (beach) pays ; encadrement avec fonction, nom, date de naissance et numéro
de licence. Visibles pour les comptes ayant le rôle de gestionnaire ou de
marqueur du sport concerné. Les applications de marquage mettent ces équipes en
cache et les effacent à la déconnexion.

**Tournois de beach-volley :** titre, lieu, dates, équipes avec prénoms, noms,
numéros de licence et pays des joueuses et joueurs, programme, résultats,
noms des arbitres et marqueurs. Si un tournoi est marqué **public**, la page
publique du tournoi montre les équipes, les noms et les pays, jamais les
numéros de licence ni les dates de naissance.

**But :** réutiliser les listes d'équipe, organiser des tournois, rattacher
les joueuses et joueurs par numéro de licence lors d'une importation.

Ces données sont conservées jusqu'à ce qu'un gestionnaire les supprime, même
si le compte qui les a créées est supprimé.

## 11. Données concernant les arbitres

**Convocations de Swiss Volley :** chaque jour, le serveur reprend les
convocations officielles du VolleyManager de Swiss Volley, pour la période
d'hier à 14 jours à l'avance : équipes, salle et adresse, ligue, 1er et
2e arbitre avec nom et date de naissance, juges de ligne, convocations. Le
serveur utilise pour cela un compte VolleyManager. But : charger les matchs
officiels avec les bons officiels. Les noms sont publics (section 8) ; les
dates de naissance ne sont visibles que pour les utilisateurs connectés.

**Répertoire des arbitres :** un répertoire commun avec prénom et nom, pays,
date de naissance et sport, afin que le marqueur n'ait pas à saisir les
officiels à chaque fois. Les comptes connectés peuvent ajouter des entrées ;
les administrateurs peuvent les modifier et les supprimer. Les noms et le
pays sont publics ; les dates de naissance ne sont visibles que pour les
utilisateurs connectés.

Si vous ne souhaitez pas figurer dans le répertoire, écrivez à
support@openvolley.app.

## 12. Téléchargements et mises à jour

- **Application de bureau :** 60 secondes après le démarrage, puis toutes les
  6 heures, à la connexion et sur demande, elle vérifie s'il existe une
  nouvelle version, jamais pendant un match en cours. Elle interroge
  `get.openvolley.app`, à défaut GitHub. Seule la requête habituelle est
  transmise (adresse IP, identifiant du programme).
- **Application Android depuis F-Droid :** l'application ne cherche pas
  elle-même de mises à jour ; c'est votre application F-Droid qui le fait.
- **Application Android installée directement :** l'application demande une
  fois si elle doit chercher des mises à jour (par défaut : non). Ce n'est que
  si vous acceptez qu'elle interroge `get.openvolley.app`, environ une fois
  par jour. Vous pouvez le désactiver dans les réglages.
- **Page d'accueil de app.openvolley.app :** si vous l'ouvrez dans le
  navigateur d'un ordinateur, votre navigateur obtient de GitHub
  (`api.github.com`, États-Unis) la liste des dernières versions afin de
  proposer le bon téléchargement. GitHub reçoit votre adresse IP.
- **GitHub et F-Droid :** si vous téléchargez chez eux, leurs déclarations de
  protection des données s'appliquent.

## 13. Support et contact

**Formulaire de support dans les applications :** il transmet au serveur le
type et le domaine du signalement, votre description, à titre facultatif votre
adresse e-mail, l'adresse de la page et l'identifiant du navigateur. Votre
adresse e-mail et le début de votre message sont consignés dans le journal du
serveur (section 14) ; le signalement peut être transmis par e-mail à
support@openvolley.app. J'utilise votre adresse uniquement pour vous
répondre. **Pour les demandes concernant vos données, écrivez directement à
support@openvolley.app.**

**E-mail à support@openvolley.app :** je conserve votre message aussi
longtemps que votre demande l'exige.

## 14. Journaux et sécurité sur le serveur

- **Journaux du serveur :** le serveur journalise les requêtes sans contenu
  et **sans adresses IP** (statut, code d'erreur, identifiant de la requête).
  Exceptions : les signalements du formulaire de support et l'adresse du
  destinataire des infos du match (sections 7 et 13). Les requêtes lentes de
  la base de données peuvent être journalisées avec leurs valeurs. Les
  journaux sont écrasés selon leur taille, en général après quelques jours à
  quelques semaines.
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

## 15. Destinataires et sous-traitants

Je transmets des données personnelles uniquement aux prestataires dont j'ai
besoin pour l'exploitation. Ils traitent les données sur mandat.

| Prestataire | Tâche | Pays |
|---|---|---|
| Hetzner Online GmbH | Serveur, base de données, stockage de fichiers | Allemagne |
| Cloudflare, Inc. | Diffusion des sites, DNS, connexion sécurisée au serveur | États-Unis (réseau mondial) |
| Migadu | Envoi d'e-mails (noreply@) et boîte aux lettres (support@) | Suisse / Europe |
| Resend, Inc. | Envoi des infos du match par e-mail (seulement cette fonction, si activée) | États-Unis |

**Important concernant Cloudflare :** la connexion chiffrée de votre appareil
se termine chez Cloudflare ; de là, elle se poursuit chiffrée jusqu'à mon
serveur. Cloudflare peut donc techniquement voir le contenu des requêtes, y
compris les listes d'équipe et les dates de naissance. Cloudflare ne peut
utiliser les données que pour fournir son service.

**Sont responsables de manière indépendante :** GitHub, Inc. (États-Unis) pour
les téléchargements et la liste des versions, F-Droid pour le catalogue
d'applications, Swiss Volley pour les données du VolleyManager.

**Les sauvegardes** sont conservées chiffrées sur mon serveur en Allemagne et
sur mes propres appareils en Suisse ; aucun tiers ne reçoit de données à cet
effet (section 18).

**Communication à l'étranger :** selon le Conseil fédéral, l'Allemagne et
l'UE offrent une protection adéquate des données. Pour les États-Unis, je me
fonde sur le Swiss-U.S. Data Privacy Framework lorsque le prestataire est
certifié, et sinon sur les clauses contractuelles types des contrats des
prestataires. Vous pouvez me demander une copie de ces garanties.

## 16. Durée de conservation

| Données | Conservation |
|---|---|
| Compte et profil | Jusqu'à ce que vous supprimiez le compte |
| Session | 30 jours après la dernière utilisation, 90 jours au plus |
| Liens dans les e-mails | Valables 60 minutes ou 24 heures, effacés 7 jours plus tard |
| NIP de validation | Jusqu'à ce que vous le supprimiez ou supprimiez votre compte |
| Feuilles de match, événements, signatures, validations, fichiers des feuilles de match | Comme procès-verbal officiel, aussi longtemps que nécessaire (saison en cours et archives). Effacement sur demande dans la mesure où le procès-verbal n'a pas besoin des données (section 19) |
| Équipes enregistrées, tournois de beach-volley | Jusqu'à ce qu'un gestionnaire les supprime, ou sur demande |
| Répertoire des arbitres, convocations | Aussi longtemps que nécessaire ; effacement sur demande |
| Journal des modifications | Aussi longtemps que nécessaire pour la traçabilité ; effacement examiné sur demande |
| Copies de sauvegarde téléversées | 30 jours |
| Journaux de l'application téléversés | Jusqu'à la suppression de votre compte |
| Journaux du serveur | Écrasés selon leur taille (quelques jours à quelques semaines) |
| Données en direct (serveur et mode salle) | Uniquement en mémoire vive ; sur le serveur supprimées 24 heures après la dernière activité |
| Sauvegardes | Jusqu'à environ 6 mois (section 18) |
| Données sur votre appareil | Jusqu'à ce que vous les supprimiez ; fichiers de sauvegarde des applications de bureau et Android 30 jours |

## 17. Mineurs

Beaucoup de joueuses et joueurs sont mineurs. Leurs données (nom, numéro, date
de naissance) ne sont pas saisies par eux-mêmes, mais par les clubs, les
responsables d'équipe, les marqueurs ou les organisateurs. Ceux-ci doivent
être autorisés à saisir les données et en informer les joueuses et joueurs et
leurs parents. La date de naissance sert au contrôle de la qualification et de
la catégorie d'âge sur la feuille de match officielle et n'est jamais publique.

Les parents ou autres représentants légaux peuvent exercer les droits de la
section 19 pour leur enfant.

## 18. Sécurité et sauvegardes

- Connexions chiffrées (HTTPS) pour tous les sites et le serveur.
- Les mots de passe, NIP et jetons de connexion ne sont enregistrés sur le
  serveur que sous forme de hachage.
- Accès selon les rôles ; tablettes uniquement avec NIP ; les matchs clôturés
  sont en lecture seule.
- Limitation des tentatives de connexion et blocage après des échecs.
- Sauvegardes : le serveur sauvegarde la base de données chaque heure et les
  fichiers chaque jour, **chiffrés**. La clé de déchiffrement ne se trouve pas
  sur le serveur. Les sauvegardes sont copiées chaque jour sur mon propre
  support de stockage en Suisse et y sont conservées jusqu'à 90 jours, et dans
  des instantanés mensuels **jusqu'à environ 6 mois**. Des données effacées
  peuvent donc subsister jusqu'à environ 6 mois dans ces sauvegardes
  chiffrées ; elles ne servent qu'à une restauration.
- Les fichiers de sauvegarde de l'application de bureau ne sont lisibles que
  par votre compte utilisateur et ne contiennent aucun NIP.

Aucun système n'est parfaitement sûr. Si vous trouvez une faille de sécurité,
signalez-la à support@openvolley.app.

## 19. Vos droits

Vous avez le droit :

- d'obtenir **l'accès** aux données que je traite à votre sujet ;
- de faire **rectifier** des données inexactes ;
- de faire **effacer** ou anonymiser des données ;
- de vous **opposer** au traitement ;
- de faire **limiter** le traitement, par exemple pendant l'examen d'une
  rectification ;
- de **recevoir** vos données dans un format courant ou de les faire
  transmettre (les applications permettent aussi de télécharger les copies de
  sauvegarde et les feuilles de match) ;
- de **retirer un consentement** à tout moment (par exemple pour la recherche
  de mises à jour sur Android).

Écrivez à **support@openvolley.app**. Je réponds dans les 30 jours. Afin de ne
pas transmettre de données à la mauvaise personne, je peux demander une
preuve de votre identité.

**Effacement dans les feuilles de match officielles :** une feuille de match
clôturée est le procès-verbal officiel d'un match, auquel les clubs, la
fédération et les officiels ont un intérêt. J'efface ou anonymise vos données
qui s'y trouvent dans la mesure où le procès-verbal n'en a pas besoin, et je
vous explique ce qui subsiste et pourquoi.

**Plainte :** vous pouvez vous adresser au Préposé fédéral à la protection des
données et à la transparence (PFPDT, www.edoeb.admin.ch). Si vous résidez dans
l'UE ou l'EEE, également à l'autorité de protection des données de votre
pays.

## 20. Bases juridiques (RGPD)

Lorsque le RGPD s'applique, je me fonde sur :

- **le contrat** (art. 6, par. 1, let. b RGPD) : compte, synchronisation,
  e-mails liés au compte, support, fonctions que vous utilisez ;
- **l'intérêt légitime** (art. 6, par. 1, let. f RGPD) : des procès-verbaux
  de match officiels corrects et vérifiables pour les clubs, la fédération et
  les officiels (listes d'équipe, dates de naissance pour le contrôle de la
  qualification, signatures, validations), le livescore pour le public,
  l'organisation de tournois, la sécurité et la protection contre les abus,
  les sauvegardes ;
- **le consentement** (art. 6, par. 1, let. a RGPD) : date de naissance
  facultative dans le compte, recherche de mises à jour de l'application
  Android installée directement.

Selon la LPD suisse, je ne traite des données que pour les finalités
indiquées et dans la mesure nécessaire.

**Aucune obligation de fournir des données :** vous n'êtes tenu ni par la
loi ni par un contrat de me fournir des données. Sans adresse e-mail et mot
de passe, je ne peux toutefois pas ouvrir de compte, et sans listes d'équipe
il n'y a pas de feuille de match.

## 21. Modifications

J'adapte cette déclaration lorsque les applications ou le droit changent. La
version publiée sur cette page, avec la date indiquée en haut, fait foi.
