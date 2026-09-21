# app_pole_python — notes opérationnelles pour Claude Code

Ce fichier documente la mécanique de lancement/test du projet, pour éviter
de la redécouvrir à chaque nouvelle conversation. Les préférences et
méthodes de travail transverses (workflow Node d'abord, popups live
obligatoires, périmètre de commit) sont dans l'auto-memory et se
rechargent déjà automatiquement — pas besoin de les répéter ici.

Ce repo est le port Python (FastAPI + uvicorn) de `app_pole` (Node), un
dépôt Git séparé et voisin sous `D:\PoleScoring\`. Une fonctionnalité ou
un correctif se fait toujours d'abord sur Node, s'y vérifie en live, puis
n'est porté ici que sur demande explicite de l'utilisateur — vérifier
aussi en live côté Python une fois porté.

Le dossier `src/pole_scoring/webui/` (`index.html`, `app.js`, `styles.css`)
est une quasi-copie de `app_pole/public/`. Les deux doivent rester
identiques sauf divergences volontaires et documentées inline dans
`app.js` avec le commentaire "divergence volontaire entre webui/app.js et
public/app.js" (spécifique à l'intégration pywebview : ouverture de
fenêtres, plein écran F11, fermeture de fenêtre). Toujours diff-vérifier
après un portage.

## Ne jamais toucher à la production

Le serveur de production (mode desktop packagé) tourne sur le port
**4380**. Ne jamais lancer de test dessus. Toute vérification live doit
utiliser un port et un dossier de données isolés (voir ci-dessous).

## Démarrer le serveur en dev

```powershell
python -m venv .venv          # une seule fois
.venv\Scripts\pip install -e .   # une seule fois
$env:POLE_SCORING_DATA_DIR = "$PWD\data"
.venv\Scripts\python -m pole_scoring
```

## Lancer une instance isolée pour tests live (Playwright)

Mêmes variables d'environnement que côté Node :
- `APP_PORT` (défaut 4380)
- `POLE_SCORING_DATA_DIR`

Exemple (bash, depuis la racine du repo) :
```bash
APP_PORT=4491 POLE_SCORING_DATA_DIR="/c/Users/.../scratchpad/mon-test-py" \
  .venv/Scripts/python.exe -m pole_scoring > /c/Users/.../scratchpad/mon-test-py/server.log 2>&1 &
disown
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4491/
```
Utiliser un dossier sous le scratchpad de la session pour les données de
test. Penser à tuer le process (`netstat -ano | grep ":<port>"` puis
`taskkill //F //PID <pid>`) une fois le test terminé.

Raccourci existant : `scripts\run-test-mode.ps1` (port 4390 / dossier
`data-test\` par défaut, `-Port`/`-DataDir` en options) — utile pour tester
avec les vraies données Node importées via `scripts\import-node-database.ps1`,
pas systématiquement adapté pour un test isolé jetable.

## Connexion à l'appli (dialog d'accès)

Identique à Node — au premier lancement (base vide, aucun compte), le
dialog affiche des champs de bootstrap en plus :
- `#app-access-dialog-last-name`, `#app-access-dialog-first-name`
- `#app-access-dialog-login`, `#app-access-dialog-password`
- bouton `#app-access-dialog-confirm` (texte "Créer et ouvrir")

Une fois un compte admin créé, le dialog ne montre plus que login/mot de
passe (mêmes ids, bouton "Se connecter").

## Navigation dans l'appli

Identique à Node : libellés texte cliquables dans la sidebar ("Vue
d'ensemble", "Compétitions", "Juges", "Compétiteurs", "Conducteur",
"Résultats & Statistiques", "Synchronisation"). Avec Playwright :
`page.click('text=Juges')`, etc.

## Playwright hors du projet

Playwright n'est pas une dépendance du projet. Pour l'utiliser dans un
script Node autonome (le venv Python ne le fournit pas) :
```bash
npx --yes playwright --version
find "$LOCALAPPDATA/npm-cache/_npx" -maxdepth 3 -iname playwright -type d
NODE_PATH="C:\\Users\\...\\npm-cache\\_npx\\<hash>\\node_modules" node mon-script.js
```
Le hash du dossier `_npx/<hash>` peut varier d'un poste à l'autre — toujours
le retrouver avec `find` plutôt que de le supposer identique à une session
précédente.

## Tests

```powershell
.venv\Scripts\python -m pytest -q
```

## Git

Voir la section "## Git — mémo rapide" dans `README.md` pour les commandes
courantes (l'utilisateur les exécute lui-même la plupart du temps).
