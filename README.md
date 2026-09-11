# Pole Scoring — portage desktop Python

Portage de l'application [`app_pole`](../app_pole) (Node.js + navigateur) vers une
application desktop native Python, sans dépendance à un navigateur externe.

L'original Node.js n'est pas modifié : ce dossier est un projet séparé, indépendant,
qui vit en parallèle le temps de la migration.

## Architecture

- Fenêtre native : [pywebview](https://pywebview.flowrl.com/) (WebView2 sur Windows,
  WKWebView sur macOS)
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
- Packaging : [Briefcase](https://briefcase.readthedocs.io/) pour produire un `.exe`
  Windows et un `.app` macOS depuis le même projet

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
resources/         icônes pour le packaging (.ico / .icns)
```

## Développement

```powershell
python -m venv .venv
.venv\Scripts\pip install -e .
$env:POLE_SCORING_DATA_DIR = "$PWD\data"
.venv\Scripts\python -m pole_scoring
```

## État de la migration

Migration menée phase par phase, chaque phase étant testée avant de passer à la
suivante (voir l'échange initial de conception pour le détail complet).

- [x] Phase 0 — scaffolding : fenêtre native + `/api/health` + frontend servi tel quel
- [ ] Phase 1 — couche base de données (schéma, hashing, journal d'événements)
- [ ] Phase 2 — comptes/accès, compétitions, compétiteurs, juges (CRUD)
- [ ] Phase 3 — moteur de notation (grilles/critères versionnés, scores, saisie manuelle)
- [ ] Phase 4 — présentateur, résultats, statistiques
- [ ] Phase 5 — PDF, exports/archives, synchronisation inter-poste
- [ ] Phase 6 — packaging Briefcase (Windows + macOS)
- [ ] Phase 7 — marche en parallèle, bascule finale
