# Pole Scoring — portage desktop Python

Portage de l'application [`app_pole`](../app_pole) (Node.js + navigateur) vers une
application desktop native Python, sans dépendance à un navigateur externe.

L'original Node.js n'est pas modifié : ce dossier est un projet séparé, indépendant,
qui vit en parallèle le temps de la migration.

## Architecture

- Fenêtre native : [pywebview](https://pywebview.flowrl.com/) (WebView2 sur Windows,
  via pythonnet/clr)
- Backend local : FastAPI + uvicorn, lancé en thread interne sur `127.0.0.1:4380`
  (`0.0.0.0` par défaut pour rester accessible aux tablettes juges sur le réseau local,
  comme la version Node)
- Base de données : `sqlite3` (module standard), même schéma et même format de fichier
  que la version Node (`node:sqlite`) — un export de la base Node peut être ouvert tel
  quel par la version Python
- Génération PDF : sous-processus Edge/Chrome headless installé sur le poste (identique
  à la version Node, pour un rendu pixel-identique des feuilles de notation/résultats)
- Frontend : `src/pole_scoring/webui/` est une copie conforme de `app_pole/public/`,
  non modifiée sauf nécessité identifiée en cours de migration
- Packaging : **Windows uniquement** (pas d'accès à macOS) — [PyInstaller](https://pyinstaller.org/)
  fige l'app en dossier autonome, [Inno Setup](https://jrsoftware.org/isinfo.php) l'emballe
  en `pole-scoring-setup.exe`, exactement l'outillage déjà utilisé côté version Node
  (voir [Packaging Windows](#packaging-windows) ci-dessous)

## Structure

```
src/pole_scoring/
  app.py           FastAPI app factory (routes API + fichiers statiques)
  __main__.py      point d'entrée: lance le serveur puis la fenêtre native
  config.py        chemins de données, port (équivalent de src/config.js)
  api/             routeurs FastAPI par domaine métier
  services/        logique métier (équivalent de src/db.js, découpé par domaine)
  db/              connexion sqlite, schéma, migrations
  models/          schémas de requêtes/réponses
  utils/           hashing, normalisations, helpers
  webui/           interface HTML/CSS/JS (copie de app_pole/public)
entry_point.py     point d'entrée PyInstaller (hors package, cf. Phase 6)
pole-scoring.spec  spec PyInstaller (mode onedir)
resources/         icône .ico
installer/         script Inno Setup (.iss) + icône
scripts/           build-portable.ps1 (PyInstaller), build-installer.ps1 (+ Inno Setup),
                   import-node-database.ps1 (copier les vraies données Node pour tester)
```

## Développement

```powershell
python -m venv .venv
.venv\Scripts\pip install -e .
$env:POLE_SCORING_DATA_DIR = "$PWD\data"
.venv\Scripts\python -m pole_scoring
```

### Travailler avec les vraies données (celles de la version Node)

Pour tester la version Python avec les compétitions/juges/compétiteurs déjà
existants côté Node, plutôt que copier le fichier `.sqlite` à la main
(risque d'incohérence si Node écrit pendant la copie) :

```powershell
# 1. Démarrer la version Python sur un port isolé, base vide
$env:APP_PORT = "4390"
$env:POLE_SCORING_DATA_DIR = "$PWD\data-test"
.venv\Scripts\python -m pole_scoring

# 2. Dans un autre terminal, une fois les deux apps demarrees (Node sur son
#    port habituel, Python sur 4390) :
powershell -ExecutionPolicy Bypass -File scripts\import-node-database.ps1
```

Le script s'appuie sur les routes `/api/db/export` (Node) et `/api/db/import`
(Python) déjà en place et testées en Phase 5 — `export` fait un checkpoint
WAL puis renvoie un instantané cohérent du fichier, même pendant que Node
tourne et écrit ; `import` **remplace entièrement** la base cible. Aucun
risque pour la base Node : l'export est une opération de lecture (le
checkpoint WAL est une opération de maintenance normale et sans danger),
rien n'est jamais écrit côté Node.

Par défaut le script part de `http://127.0.0.1:4380` (Node) vers
`http://127.0.0.1:4390` (Python) ; à ajuster avec `-NodeUrl`/`-PythonUrl` si
besoin, par exemple :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\import-node-database.ps1 -PythonUrl "http://127.0.0.1:4391"
```

### Remettre une base à vide (hors juges/utilisateurs/grilles)

Pour repartir de zéro sur les compétitions/compétiteurs/scores (données de
test) sans perdre les comptes utilisateurs, les juges enregistrés ni les
grilles de notation :

```powershell
.venv\Scripts\python scripts\reset-test-data.py --data-dir data-test --confirm
```

Sans `--confirm`, le script se contente d'afficher l'état des tables ciblées
sans rien modifier. Une copie de sauvegarde horodatée du fichier `.sqlite`
est créée juste avant la suppression (dans le même dossier). Tables vidées :
`competitions` (cascade vers compétiteurs/scores/présences/affectations
juges), `athletes`, `sync_events`. Tables conservées : `access_accounts`,
`access_sessions`, `access_recovery_codes`, `judges`, `scoring_grids` (et
leurs versions/critères), `settings`.

## Tests

```powershell
.venv\Scripts\pip install -e ".[dev]"
.venv\Scripts\python -m pytest -q
```

`tests/test_reference_db.py` valide le portage sur une **copie isolée** (backup API SQLite,
lecture seule) de la vraie base `app_pole/data/pole-scoring.sqlite` — jamais le fichier
utilisé par l'application Node en cours d'exécution. Chemin surchargeable via la variable
`POLE_SCORING_REFERENCE_DB`.

## Packaging Windows

- Bundle portable (dossier autonome, PyInstaller) :
  - `powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1`
  - Sortie : `dist\pole-scoring\pole-scoring.exe` (+ `_internal\`)
  - Nécessite le venv de dev déjà créé (`.venv\Scripts\pip install -e ".[dev]"`)

- Installateur EXE (Inno Setup) :
  - `powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1`
  - Sortie : `dist\installer\pole-scoring-setup.exe`
  - Enchaîne automatiquement `build-portable.ps1`, puis cherche `ISCC.exe`
    (`C:\Tools\InnoSetup\`, `Program Files\Inno Setup 6\`, ou dans le `PATH`)
  - Si `ISCC.exe` est introuvable, le script s'arrête proprement après le
    bundle portable (même repli que `build-installer.ps1` côté Node) — pas
    d'erreur bloquante, juste l'installateur final qui n'est pas produit

- Données locales en exécution installée : `%LOCALAPPDATA%\PoleScoringLocal\data`
  (identique à la version Node, via `platformdirs` côté Python)

Validé de bout en bout sur ce poste : build PyInstaller → compilation Inno Setup
→ installation silencieuse (`/VERYSILENT`) → vérification que l'app installée
répond → désinstallation silencieuse via l'uninstaller généré, sans rien laisser
derrière (dossier, raccourcis, registre).

## État de la migration

Migration menée phase par phase, chaque phase étant testée avant de passer à la
suivante (voir l'échange initial de conception pour le détail complet).

- [x] Phase 0 — scaffolding : fenêtre native + `/api/health` + frontend servi tel quel
- [x] Phase 1 — couche base de données (schéma, hashing, journal d'événements)
- [x] Phase 2 — comptes/accès, compétitions, compétiteurs, juges (CRUD)
- [x] Phase 3 — moteur de notation (grilles/critères versionnés, scores, saisie manuelle)
- [x] Phase 4 — présentateur, résultats, statistiques
- [x] Phase 5 — PDF, exports/archives, synchronisation inter-poste
- [x] Phase 6 — packaging Windows (PyInstaller + Inno Setup)
- [x] Phase 6bis — fenêtres popup multiples (tablet-recap, saisie manuelle...)
- [ ] Phase 7 — marche en parallèle, bascule finale
- [ ] Phase 8 — refonte du fonctionnement des grilles de notation (à planifier)
- [ ] Phase 9 — étude de faisabilité : synchronisation automatique de la base locale (à planifier)

### Phase 6bis

Remonté par l'utilisateur en testant : envoyer un passage aux tablettes
depuis le Conducteur affiche "le navigateur a bloqué une fenêtre" et la
fenêtre tablet-recap s'ouvre dans le navigateur système (Edge) au lieu
d'une fenêtre de l'application. Exigence explicite de l'utilisateur : le
scrutateur doit pouvoir suivre la notation en direct dans une fenêtre
séparée **tout en continuant à travailler dans la fenêtre principale** —
donc une vraie fenêtre indépendante, pas une modale bloquante dans la même
fenêtre.

**Cause racine, vérifiée dans le code source de pywebview installé**
(`.venv/Lib/site-packages/webview/platforms/edgechromium.py`, méthode
`on_new_window_request`) : pywebview intercepte systématiquement tout appel
JS à `window.open()` via l'événement WebView2 `NewWindowRequested`
(`args.set_Handled(True)` inconditionnel) et, selon le réglage
`webview.settings['OPEN_EXTERNAL_LINKS_IN_BROWSER']` (`True` par défaut),
soit ouvre l'URL dans le navigateur système (`webbrowser.open()`), soit
navigue dans la fenêtre courante à la place. Aucun réglage ne permet
d'obtenir le comportement natif d'un navigateur (vraie fenêtre enfant liée).
Ce n'est pas spécifique à Node (qui utilise un vrai navigateur, sans ce
problème) — c'est propre à l'architecture pywebview de la version Python.

**Conséquence plus large que le message d'erreur** : `public/app.js` (copié
dans `webui/`) utilise `window.opener` + `postMessage` pour que les fenêtres
popup (tablet-recap, saisie manuelle, saisie en lot, classement catégorie)
préviennent le tableau de bord de leurs événements (fermeture, validation,
sauvegarde) — cf. `openDedicatedWindow()` et le listener `window.addEventListener('message', ...)`
dans `app.js`, et `notifyConductor()` dans `tablet-recap.js`. Ce lien
`window.opener` n'existe que si la fenêtre a été ouverte par un vrai
`window.open()` du navigateur ; dès que pywebview intercepte et redirige,
ce lien est cassé silencieusement, quelle que soit la fenêtre où la page
popup finit par s'afficher.

Point rassurant : le bouton "Libérer les tablettes" (cf. plus bas) reste
fiable malgré ça, car il relit toujours l'état réel depuis
`/api/presenter/state` plutôt que de dépendre d'une référence de fenêtre.
Seule la fermeture automatique de la popup ne fonctionnerait pas dans ce
cas précis.

**Correctif implémenté**, concerne uniquement `webui/` (pas
`app_pole/public/`, qui n'a pas ce problème — divergence volontaire et
documentée) :
1. `desktop_api.py` (nouveau) : classe `DesktopApi` exposée à la fenêtre
   principale via `js_api=` dans `__main__.py`, avec `open_window(url, name,
   width, height)` qui appelle `webview.create_window(...)` côté Python pour
   créer une vraie fenêtre native indépendante, et `close_window(name)` pour
   la fermer à la demande. Les fenêtres ouvertes sont suivies dans un
   dictionnaire (par `name`) pour réutiliser/refocaliser une fenêtre déjà
   ouverte plutôt que d'en dupliquer une.
2. `openDedicatedWindow()` (`webui/app.js`) détecte `window.pywebview.api.open_window`
   et l'utilise à la place de `window.open()` quand disponible ; un objet
   `{ closed, focus(), close() }` minimal est renvoyé pour rester compatible
   avec le code existant (`conductorState.activeRecapPopup`, etc.).
   Comportement Node/navigateur strictement inchangé sinon.
3. `ensureConductorTabletSyncPolling()` (`webui/app.js`) : sondage de
   `/api/presenter/state` toutes les 3 secondes sur la vue Conducteur,
   actif uniquement quand `window.pywebview` est présent (compense la perte
   de `postMessage` sans rien changer pour Node, où `postMessage` continue
   de fonctionner instantanément).

**Validé sur la vraie fenêtre pywebview**, pas seulement via un navigateur
headless classique (qui ne peut pas reproduire ce bug, propre à
l'interception WebView2) : `POLE_SCORING_REMOTE_DEBUG_PORT` (nouvelle
variable d'env, dev uniquement) active `webview.settings['REMOTE_DEBUGGING_PORT']`,
ce qui permet de piloter la vraie fenêtre native avec Playwright via
`chromium.connectOverCDP(...)`. Confirmé ainsi : la fenêtre tablet-recap
s'ouvre comme une vraie fenêtre native (plus de bascule vers Edge), la
fenêtre principale reste pleinement utilisable pendant ce temps (navigation
testée en direct), le bandeau "Libérer les tablettes" s'affiche
correctement, et le bouton ferme bien la vraie fenêtre native.

### Phase 7 (à préparer)

Point noté par l'utilisateur le 2026-09-18 : au packaging final, l'installeur
doit embarquer des données de démarrage pour chaque poste scrutateur — les
**juges enregistrés** et les **comptes utilisateurs** (un accès par
scrutateur, à créer). Les **grilles de notation n'ont pas besoin d'être
embarquées** : elles sont déjà recréées automatiquement au premier démarrage
par `ensure_default_scoring_grids` (`services/scoring_grids.py`), vérifié sur
une base vierge (voir plus bas, table `reset-test-data.py`).

Piste retenue à ce stade : réutiliser `scripts/reset-test-data.py` (créé le
même jour, cf. plus bas) pour préparer, sur ce poste, une base ne contenant
que les comptes scrutateurs finaux et les juges (plus de compétitions/scores
de test), puis embarquer ce fichier `.sqlite` comme donnée de seed dans
l'installeur : au premier lancement, si aucune base n'existe encore dans
`LOCALAPPDATA`, l'application copierait ce fichier de seed au lieu de créer
une base vide. Point d'attention : ce fichier contient des hachages de mots
de passe des comptes scrutateurs, donc il devra rester hors du dépôt git
(comme `data-test/`), fourni en local aux scripts de build plutôt que
committé. Non implémenté — à faire en Phase 7, une fois les corrections et
tests de bout en bout en cours terminés.

### Phase 8 (à planifier plus tard)

Revoir la manière dont les grilles de notation sont créées/gérées (actuellement :
4 grilles fixes — artistique/technique × solo/duo — seedées avec des critères en
dur au démarrage, cf. `services/scoring_grids.py` et Phase 3). Le fonctionnement
cible reste à définir par l'utilisateur ; à traiter une fois les Phases 0 à 7
terminées et validées, pour ne pas mélanger fidélité du portage et refonte
fonctionnelle. Les Phases 3 à 7 sont donc portées à l'identique du comportement
Node existant en attendant.

### Phase 9 (à planifier plus tard)

Étude de faisabilité pour ne plus avoir à télécharger/importer manuellement un
export de base à chaque poste scrutateur : trouver un moyen de centraliser les
données (compétitions, compétiteurs, résultats...) et de mettre à jour
automatiquement la base locale à l'ouverture de l'application. L'utilisateur
dispose d'un nom de domaine et de plusieurs bases de données en ligne
mobilisables si besoin. Reste à étudier : source de vérité centrale envisagée
(une des bases en ligne existantes vs nouvelle base dédiée), articulation avec
le mécanisme de synchronisation par journal d'événements déjà présent
(`sync_events`, cf. Phase 5) qui gère aujourd'hui la fusion entre postes locaux,
et le comportement hors-ligne (l'application doit rester utilisable en
compétition sans réseau fiable). À traiter une fois les phases précédentes
terminées et validées.

### Détail Phase 6

Décision : abandon de Briefcase (choisi en Phase 0 pour son intérêt
multi-OS) au profit de **PyInstaller + Inno Setup**, une fois macOS écarté
du périmètre (pas d'accès à une machine Apple). Sans le besoin multi-OS,
Briefcase n'apportait plus rien et aurait demandé d'installer un nouvel
outil (WiX Toolset, nécessaire à son packaging Windows en `.msi`) alors
qu'Inno Setup — déjà utilisé pour la version Node, avec un script et une
icône déjà prêts à être réadaptés — était déjà disponible sur le poste de
build (`C:\Tools\InnoSetup\ISCC.exe`).

Mis en place :
- `entry_point.py` (racine du projet, hors du package) : PyInstaller traite
  le script d'analyse comme un module `__main__` isolé, donc les imports
  relatifs de `pole_scoring/__main__.py` ne se résolvent que si `pole_scoring`
  est importé normalement depuis un point d'entrée externe au package.
- `pole-scoring.spec` : mode `onedir` (un dossier `pole-scoring/` avec l'exe
  et ses dépendances, comme le `dist/portable` de la version Node plutôt
  qu'un `onefile` qui se décompresse à chaque lancement). Utilise
  `collect_all` pour `pythonnet`/`clr_loader`/`webview` : pywebview pilote la
  fenêtre via pythonnet/WebView2 sur Windows, et ces paquets embarquent des
  assemblies .NET que PyInstaller ne détecte pas tout seul par analyse de
  code. Les hooks communautaires (`pyinstaller-hooks-contrib`, installé
  automatiquement) couvrent uvicorn/pydantic/sqlite3/platformdirs sans
  configuration supplémentaire.
- `app.py` : `WEBUI_DIR` se résout désormais via `sys._MEIPASS` quand l'app
  est figée (`sys.frozen`), plutôt que `Path(__file__).parent` qui ne pointe
  vers rien d'utile une fois le code Python compilé/archivé par PyInstaller.
- `installer/pole-scoring.iss` : quasi identique au script Inno Setup de la
  version Node (même `AppId` changé pour rester distinct, même structure
  `[Files]`/`[Icons]`/`[Run]`), pointe sur `dist\pole-scoring` au lieu de
  `dist\portable`.
- `scripts/build-portable.ps1` et `scripts/build-installer.ps1` : même
  répartition des responsabilités et même repli que côté Node — si
  `ISCC.exe` est introuvable, le script s'arrête après le bundle portable
  sans erreur bloquante plutôt que d'échouer.

Validé de bout en bout sur ce poste (le poste de travail principal de
l'utilisateur, à sa demande) : build PyInstaller réussi du premier coup
(aucun hidden-import manuant à ajouter à la main), `.exe` autonome testé
(API + fenêtre native), compilation Inno Setup réussie (~20 Mo), puis
installation silencieuse réelle (`/VERYSILENT`), vérification que
l'application installée répond, et désinstallation silencieuse via
l'uninstaller généré — sans rien laisser derrière (dossier, raccourcis
Bureau/menu Démarrer, entrée de registre).

### Correctif post-Phase 6 : info-bulles du menu réduit

Bug historique (pas introduit par le portage) remonté par l'utilisateur en
testant la version Python : en mode menu réduit, l'info-bulle de chaque
icône était coupée par `overflow-x: hidden` sur `.sidebar` (nécessaire à son
ascenseur vertical). Porté depuis `app_pole` (commit `50f6301`) :
resynchronisation de `webui/app.js`, `webui/index.html` et `webui/styles.css`
— l'info-bulle est désormais un élément unique positionné en JS
(`position: fixed`, coordonnées via `getBoundingClientRect()`), qui échappe
au découpage de la sidebar. Aucun changement backend, correctif 100 %
frontend. Revalidé avec un navigateur piloté (Playwright) sur le backend
Python : résultat identique à la version Node, info-bulles entièrement
visibles à toutes les hauteurs du menu.

### Correctif post-Phase 6 : bouton "Libérer les tablettes"

Cas réel remonté en compétition (prestation interrompue en cours de notation
tablette) : fermer la fenêtre tablet-recap sans cliquer "Valider" laissait le
passage actif bloqué côté serveur, sans signal visible, empêchant l'envoi du
passage suivant. Porté depuis `app_pole` (version Node, commit `df0efde`) :
bandeau + bouton "Libérer les tablettes" dans la vue Conducteur
(`#conductor-active-summary`), qui relit l'état serveur avant d'agir, ferme
la fenêtre tablet-recap si elle est encore ouverte, remet le toggle Manuel/
Tablettes du compétiteur à Manuel, et permet d'envoyer un nouveau passage
immédiatement.

Aucun changement backend nécessaire : `services/presenter.py::finalize_presenter_active_passage`
avait déjà été porté fidèlement en Phase 4 avec le même comportement que côté
Node (aucune exigence que les juges aient terminé pour libérer le passage).
Seuls `webui/app.js` et `webui/styles.css` ont été resynchronisés avec
`app_pole/public/` (diff vérifié : uniquement ce correctif, rien d'autre
n'avait divergé entre les deux copies du frontend). Revalidé de bout en bout
avec un navigateur piloté (Playwright, captures d'écran), sur le backend
Python cette fois : bandeau affiché, libération, fermeture automatique de la
popup, toggle et bandeau revenus à l'état initial.

### Correctif post-Phase 6 : simplification du modèle de rôles (admin/scrutateur)

Demande explicite de l'utilisateur : ne garder que 2 rôles d'accès —
**Administrateur** (accès total) et **Scrutateur** (tout sauf
"Administration", ex-"Paramétrages"). Porté depuis `app_pole` (version Node)
: le rôle `presenter` est supprimé (confirmé sans risque — `presenter.html`
n'a jamais requis d'authentification, `/api/presenter/*` ne vérifie aucune
session), et les valeurs internes `super_admin`/`admin` sont renommées
`admin`/`scrutateur` (`services/access.py`, `api/access.py`,
`api/db_admin.py`, `api/scoring.py`, `webui/app.js`, `webui/index.html`) —
le menu "Administration" est aussi repositionné juste avant "Déconnexion"
dans la sidebar.

Migration des comptes existants : `db/bootstrap.py::_migrate_access_roles`,
verrouillée par un indicateur dans `settings` (`access_role_migration_v1`)
pour ne s'exécuter qu'une seule fois. Point important, identifié et corrigé
côté Node avant le portage : une première version avec de simples `UPDATE
... WHERE role = 'admin'` n'était **pas idempotente** — `'admin'` est à la
fois une ancienne valeur (l'ex-Scrutateur) et la nouvelle valeur cible (le
nouvel Administrateur), donc rejouer la migration au démarrage suivant
rétrogradait les comptes déjà migrés. D'où le verrou en base plutôt qu'un
simple `UPDATE` répété à chaque démarrage. Couvert par un test dédié
(`tests/test_access.py::test_legacy_roles_are_migrated_once_and_idempotently`),
qui vérifie explicitement l'absence de régression au second passage.

Par sécurité, les valeurs de repli (rôle par défaut si non fourni, à la
création d'un compte comme dans le formulaire) sont passées de `'admin'` à
`'scrutateur'` — avant le renommage, `'admin'` désignait le rôle le moins
privilégié ; le garder tel quel après renommage aurait accordé les pleins
droits par défaut à tout compte créé sans rôle explicite.

### Correctif post-Phase 6 : checkpoint WAL manquant à la fermeture de l'appli

Remonté par l'utilisateur en comparant les dates de modification des
fichiers `.sqlite`/`.sqlite-wal`/`.sqlite-shm` dans l'explorateur Windows :
le fichier `.sqlite` restait figé à la date du dernier checkpoint SQLite
automatique (seuil interne ~1000 pages de WAL), alors que `.sqlite-wal`
continuait de grossir avec les écritures de sessions ultérieures — y
compris après avoir fermé l'application. Aucune perte de données (SQLite
relit le WAL a l'ouverture suivante), mais un fichier `.sqlite` trompeur
pour qui l'ouvre seul dans un outil externe (ex. SQLiteStudio) sans les
fichiers `-wal`/`-shm` a côté.

Cause : ni `webview.events.closed`, ni la fin de `main()` ne déclenchaient
de `PRAGMA wal_checkpoint` ni de fermeture propre de la connexion SQLite —
le process se terminait simplement, laissant les écritures récentes dans
le WAL. Corrigé dans `__main__.py` : `_checkpoint_and_close_database()`
est appelée juste après le retour de `webview.start()` (qui bloque tant
qu'une fenêtre reste ouverte, donc s'exécute exactement à la fermeture de
l'appli), et fait le checkpoint puis ferme la connexion.

Vérifié par un test direct (hors suite pytest, car il s'agit d'un
comportement de processus complet plutôt que d'une fonction de service) :
20 écritures créent bien un `.sqlite-wal` de plusieurs centaines de Ko sans
que `.sqlite` ne bouge, puis l'appel du correctif fait disparaître
totalement `.sqlite-wal`/`.sqlite-shm` et met à jour `.sqlite`, dont le
contenu (les 20 lignes) est confirmé après réouverture. Suite de 129 tests
toujours au vert.

Spécifique à la version Python : n'affecte pas Node, qui tourne en serveur
persistant plutôt que d'être fermé/rouvert comme une appli desktop.

### Correctif post-Phase 6 : dimension d'ouverture de la fenêtre + plein écran (F11)

Demande de l'utilisateur : côté Node, la fenêtre est celle du navigateur
(souvent déjà maximisée) ; côté Python, `webview.create_window()` ouvrait à
une taille fixe (1280×800), trop petite sur certains écrans. Premier essai
avec `maximized=True` : rejeté par l'utilisateur ("ça fait moins
application"). Fixé sur une largeur d'ouverture de **1475px** (hauteur
inchangée à 800px, fenêtre normale, redimensionnable) dans `__main__.py`.
Ajouté en complément un vrai plein écran (F11) pour les petits écrans, via
`DesktopApi.toggle_fullscreen()` (`desktop_api.py`) déclenché par un
listener clavier dans `webui/app.js` (divergence Python uniquement, Node
bénéficie déjà du plein écran natif du navigateur).

Piège rencontré et corrigé sur le plein écran : `webview.active_window()`
(utilisé dans une première version) s'appuie sur `WinForms.Form.ActiveForm`
(`platforms/winforms.py`), qui s'est révélé peu fiable appelé depuis le
thread des callbacks `js_api` (différent du thread UI) — il renvoyait
`None`, faisant silencieusement échouer le toggle. Remplacé par une
référence directe à la fenêtre principale, assignée à
`DesktopApi.main_window` juste après `webview.create_window()` dans
`__main__.py` (l'instance `DesktopApi` doit exister avant la création de
la fenêtre, pour être passée en `js_api=...`, d'où l'assignation après
coup plutôt qu'au constructeur). Vérifié sur la vraie fenêtre native (CDP +
Playwright, écran 1920×1080) : F11 → 1920×1080 (plein écran réel, aucune
bordure/barre de titre) ; second F11 → retour à l'état normal.

En creusant le retour de l'utilisateur (capture d'écran à l'appui), la
vraie cause de sa gêne n'était pas tant la largeur de fenêtre en soi que le
tableau "Compétiteurs inscrits" (`public/app.js::renderCompetitorsTable`,
classe `.competitor-table`) qui n'avait aucun mécanisme de repli — en
dessous d'une certaine largeur, la colonne Actions (boutons
Désistement/Forfait) sortait purement et simplement de l'écran, sans barre
de défilement pour l'atteindre. Corrigé (Node d'abord, puis porté à
l'identique) : `.competitor-table` passe en `overflow-x: auto`, et
`.competitor-table-row` reçoit un `min-width: 1000px` qui déclenche le
défilement horizontal dès que le conteneur est plus étroit que ça (guardé
par un `min-width: 0` dans le media query `max-width: 900px` existant, qui
bascule déjà la ligne en une seule colonne empilée sur mobile — sans ce
garde-fou les deux stratégies responsive seraient entrées en conflit).
Vérifié en direct (Playwright, viewport 1050px) : le bouton "Désistement"
est hors-écran (x≈1116) avant défilement, atteignable (x≈738) après.

Deuxième retour de l'utilisateur sur ce même correctif : avec beaucoup de
compétiteurs, il fallait défiler la page tout en bas de la liste avant que
la barre de défilement horizontale n'apparaisse — normal, un navigateur
place la scrollbar horizontale au bas de sa boîte de défilement, et cette
boîte (`.competitor-table`, alors non bornée en hauteur) grandissait avec
le nombre de lignes. Premier essai : `.competitor-table` bornée à
`max-height: 60vh`. Insuffisant sur la vraie fenêtre 1475×800 (zone client
~1460×790) : les cartes "Choisir une compétition"/"Importer une liste"
au-dessus du tableau ont une hauteur variable (celle du formulaire d'import,
le plus grand des deux, la grille les étirant à l'identique), et pouvaient
à elles seules dépasser `100vh - 480px` — un simple offset fixe en `calc()`
s'est révélé structurellement peu fiable (dépend de la largeur de fenêtre,
du texte qui se répartit sur plus ou moins de lignes, du contenu du
formulaire).

Corrigé en faisant remplir au tableau tout l'espace vertical réellement
disponible, plutôt que de le deviner : `.workspace` passe en
`display: flex; flex-direction: column`, `.view.is-active` devient
`flex: 1; min-height: 0`, et toute la chaîne jusqu'à `.competitor-table`
(`#view-competitors.is-active`, `.competitors-management-grid` avec
`grid-template-rows: auto auto minmax(0, 1fr)`, `.competitors-table-card`,
`#competitors-table`) relaie ce `flex: 1; min-height: 0`, avec un plancher
`min-height: 110px` sur `.competitor-table` lui-même pour toujours garantir
au moins une ligne visible. Piège rencontré en chemin : une règle
`.competitors-management-grid { align-items: start; }` préexistante
empêchait le `stretch` par défaut de CSS Grid de s'appliquer à
`.competitors-table-card` — corrigé avec un `align-self: stretch` ciblé
sur cette seule carte, sans toucher aux 3 autres cartes de la grille.

Changement partagé (`.workspace`/`.view.is-active`) revérifié visuellement
sur toutes les autres vues (Vue d'ensemble, Compétitions, Juges,
Conducteur, Statistiques) : aucune régression, comportement identique à
avant. Vérifié en direct (Playwright, 25 compétiteurs, fenêtre 1460×790
réelle) : le bas du tableau tient exactement dans le viewport, **aucun
défilement de page nécessaire** (contre ~1300px de trop avec l'approche
`60vh`). Sur une fenêtre nettement réduite (1050×700), l'amélioration
reste nette même si un léger défilement de page redevient nécessaire dans
ce cas extrême (fenêtre bien plus petite que l'ouverture par défaut) :
l'essentiel est que la scrollbar horizontale n'est plus jamais enterrée
sous des dizaines de lignes.

Suite de 129 tests toujours au vert (aucun de ces changements n'est
couvert par un test unitaire : comportement de fenêtre native ou de mise
en page CSS, pas une fonction de service).

### Détail Phase 5

Portés : export PDF (pilotage d'Edge/Chrome headless installé sur le poste,
identique à la version Node), index des exports, nettoyage des PDF d'une
compétition à sa clôture (`exportsCleanup`, branché dans la route `PUT
/api/competitions/{id}` — c'était un stub depuis la Phase 2), navigateur de
fichiers exportés (`/api/pdf/browse`), export/import de la base SQLite
complète, archivage par saison (garder N saisons, déplacer le reste dans un
fichier `.sqlite` séparé, purge optionnelle), restauration d'une archive par
fusion (`INSERT OR IGNORE`, ne casse jamais les données déjà présentes), et la
synchronisation inter-poste (export/import d'un instantané complet + rejeu du
journal `sync_events`, avec dédoublonnage automatique par id).

Les actions qui touchent au système local (export PDF, ouverture d'un dossier)
sont protégées par un contrôle d'origine (`require_local_system_control`) :
refusées si la requête ne vient pas de `127.0.0.1`, pour qu'une tablette juge
sur le réseau local ne puisse jamais les déclencher — équivalent de
`requireLocalSystemControl` côté Node.

Deux bugs réels détectés et corrigés pendant cette phase :

1. Plusieurs fonctions d'export/archivage (`export_database_snapshot`,
   `checkpoint_wal_and_get_db_files_size`, `create_archive_file_for_seasons`,
   `list_database_archives`, `export_database_archive`) lisaient le chemin de
   base **global** (`config.DB_FILE`/`DATA_DIR`) au lieu du chemin réel de
   l'instance `Database` reçue en paramètre. Invisible en usage normal (un
   seul poste = une seule base via `get_db()`), mais faux dès qu'on manipule
   plusieurs bases dans le même process — exactement le scénario des tests
   "deux postes" qui a révélé le problème. Corrigé en exposant `db_file` /
   `data_dir` / `archives_dir` comme propriétés de `Database`
   ([db/connection.py](src/pole_scoring/db/connection.py)) et en les utilisant
   partout dans `db_maintenance.py` plutôt que les constantes globales.
2. Bug de test (pas de code applicatif) : `bootstrapped_db` dépendant de la
   fixture `db`, demander les deux dans la même fonction de test renvoie le
   **même** objet Python (mise en cache des fixtures pytest par test), pas
   deux bases séparées — ce qui invalidait plusieurs tests "export d'un poste
   vers un autre". Corrigé en ajoutant une fixture `other_db` réellement
   indépendante (fichier temporaire distinct) pour ces cas.

Comme pour le bug `running_order` de la Phase 3, la leçon se répète : les
tests HTTP/multi-instances de bout en bout trouvent des classes de bugs que
les tests unitaires isolés ne peuvent pas voir — à garder en tête pour les
phases suivantes.

Test manuel supplémentaire (au-delà des 126 tests pytest) : génération d'un
vrai PDF via l'app réelle (Edge/Chrome headless, 1091 octets produits,
ouverture automatique de l'Explorateur Windows confirmée), export/import de
base SQLite et export sync via `curl` sur le port isolé.

### Détail Phase 4

Portés : état complet du présentateur (`getPresenterState` — passage actif,
compétition active, progression des juges validés/en attente, URL des
résultats), activation/finalisation d'un passage, activation/désactivation de
l'affichage des résultats, état du tableau de bord (`getDashboardState`), et
la route `/api/bootstrap` qui agrège tout ça au chargement de l'app (résumé,
dashboard, chemin de la base, URLs LAN, compétitions, juges).

Confirmé en relisant le frontend (`individual-statistics.js`,
`competition-results.js`, `category-results.js`, `tablet-recap.js`) : il n'y a
pas d'endpoint « statistiques » séparé côté serveur — ces pages consomment les
endpoints déjà portés (`results`, `competitors`, `scoring-profile`,
`judge-assignments`) et calculent l'affichage côté client. Le seul morceau
encore manquant pour ces pages est l'export PDF (Phase 5).

### Détail Phase 3

Portés : CRUD complet des grilles/critères de notation (versioning, activation),
assignations de juges par compétition (y compris détection de double
affectation), présence/état d'accès juge (`getJudgeAccessState`), connexion
juge (`judge-login`), enregistrement des scores (ajout direct, brouillon en
direct, fiche finale de juge, saisie manuelle par lot), historique de notation
par catégorie, profil de notation d'une compétition, et le recalcul global des
résumés de scores au démarrage (`refreshAllCompetitorScoreSummaries`). Un
sous-ensemble minimal de l'état présentateur (`services/presenter.py` :
passage actif get/clear) a été pulled forward en avance de phase car la
validation d'un score en dépend ; le reste (activer/finaliser un passage,
activer les résultats) reste en Phase 4.

Un bug réel a été détecté grâce aux tests HTTP de bout en bout (et non par les
tests directs sur les services) : `running_order` devenait `NULL` en base
lorsqu'il transitait par `require_number` (qui renvoie un flottant) puis par un
`int(str(valeur))` côté service — `str(1.0)` donne `"1.0"` en Python, que
`int()` ne sait pas parser, alors que l'équivalent JS (`Number.parseInt`)
s'en sort car `String(1.0)` vaut `"1"` côté JavaScript. Corrigé via un
nouvel utilitaire partagé `utils/validation.py::parse_int_like_js`, qui
reproduit fidèlement la conversion JS. Ce type d'écart (mêmes règles métier,
sémantiques numériques différentes entre JS et Python) est le principal risque
de cette migration — les tests HTTP de bout en bout, en plus des tests
unitaires par service, restent donc importants pour la suite.

### Détail Phase 2

Portés : comptes d'accès (bootstrap, login, mot de passe, codes de récupération,
CRUD des comptes réservé aux super-admins), compétitions (CRUD, unicité nom+date,
une seule compétition active à la fois), compétiteurs (CRUD, résolution/déduplication
des athlètes en duo via `athletes`/`competitor_members`), juges (CRUD, activation).
Un sous-ensemble minimal du moteur de grilles de notation (`services/scoring_grids.py`)
a été porté en avance de phase car `create_competition` en dépend (attribution d'une
version active de grille par défaut) ; le CRUD complet des grilles/critères reste en
Phase 3.

Volontairement laissés pour la Phase 3, car couplés aux grilles de notation et aux
assignations juges : `/api/judge-login` (`getJudgeAccessState`), les assignations
juges par compétition, `refreshAllCompetitorScoreSummaries`, les migrations
historiques de libellés/clés de critères (`migrateScoringCriterionLabels/Keys`,
sans effet sur une base déjà à jour) et la réinitialisation du présentateur au
démarrage (`clearPresenterActivePassage`, Phase 4). Le nettoyage des PDF à la
clôture d'une compétition (`exportsCleanup`) est un stub en attendant la Phase 5.
