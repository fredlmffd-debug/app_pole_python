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
- [ ] Phase 7 — marche en parallèle, bascule finale
- [ ] Phase 8 — refonte du fonctionnement des grilles de notation (à planifier)
- [ ] Phase 9 — étude de faisabilité : synchronisation automatique de la base locale (à planifier)

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
