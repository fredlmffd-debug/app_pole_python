async function request(path, options = {}) {
  const accessToken = getAccessSessionToken();
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { 'X-Access-Token': accessToken } : {})
    },
    ...options
  });

  const rawPayload = await response.text();
  let payload = null;

  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = { error: rawPayload };
    }
  }

  if (!response.ok) {
    throw new Error(payload.error ?? 'Erreur API');
  }

  return payload ?? {};
}

/*
 * Structure rapide du fichier:
 * 1) Etat global et helpers transverses
 * 2) Fenetres popup et synchronisation inter-fenetres
 * 3) Authentification / session d'acces
 * 4) Tunnel competitions (create/edit/delete)
 * 5) Import Excel competiteurs
 * 6) Conducteur
 * 7) Parametrages (criteres + comptes d'acces)
 * 8) Bootstrap UI (listeners + refresh initial)
 */

const sectionMeta = {
  dashboard: {
    kicker: 'Centre de contrôle',
    title: 'Vue d\'ensemble',
    subtitle: 'Statut réseau, activité et accès rapides.'
  },
  competitions: {
    kicker: 'Evénement',
    title: 'Compétitions',
    subtitle: 'Créer, modifier ou supprimer un événement.'
  },
  judges: {
    kicker: 'Base des juges',
    title: 'Juges',
    subtitle: 'Créer, supprimer ou rendre inactif un juge.'
  },
  competitors: {
    kicker: 'Plateaux',
    title: 'Compétiteurs',
    subtitle: 'Ordre de passage et catégories.'
  },
  conductor: {
    kicker: 'Conduite',
    title: 'Conducteur',
    subtitle: 'Pilotage de la notation manuelle ou tablettes.'
  },
  statistics: {
    kicker: 'Analyse',
    title: 'Résultats & Statistiques',
    subtitle: 'Analyse des notes, passages et tendances de compétition.'
  },
  settings: {
    kicker: 'Administration',
    title: 'Administration',
    subtitle: ''
  },
  sync: {
    kicker: 'Consolidation',
    title: 'Synchronisation',
    subtitle: 'Fusion des bases et transfert inter-scrutateurs.'
  }
};

const competitionLevelOptions = [
  { value: 'defi', label: 'Défi danse' },
  { value: 'regional', label: 'Régional' },
  { value: 'national', label: 'National' }
];

const competitionJudgeCountOptions = Array.from({ length: 20 }, (_, index) => {
  const judgeCount = index + 1;
  return {
    value: String(judgeCount),
    label: `${judgeCount} juge${judgeCount > 1 ? 's' : ''}`
  };
});

const judgeAssignmentRoleOptions = [
  { value: '', label: 'Choisir rôle' },
  { value: 'head', label: 'Head Judge' },
  { value: 'artistique', label: 'Juge Artistique' },
  { value: 'technique', label: 'Juge Technique' }
];

const competitionRegionZones = {
  'Sud-Est': 'Sud',
  'Sud-Ouest': 'Sud',
  'Nord-Est': 'Nord',
  'Nord-Ouest': 'Nord',
  'Antilles-Guyane': 'Outre-Mer',
  'Reunion-Tahiti': 'Outre-Mer'
};

const competitionModes = new Set(['create', 'edit', 'delete']);
const competitionCreateSteps = ['general', 'judges', 'competitors'];
let activeSection = 'dashboard';
let activeCompetitionMode = 'create';
let isCompetitionDirectoryVisible = false;
let competitionsState = [];
let judgesState = [];
let scoringSettingsState = createScoringSettingsState();
let accessState = createAccessState();
let activeCompetitionSeasonFilter = getCurrentSeasonValue();
let competitionWizardState = createCompetitionWizardState();
let competitionEditState = createCompetitionEditState();
let competitorManagementState = createCompetitorManagementState();
let conductorState = createConductorState();
let statisticsOtherCompetitionId = '';
let accessLogoutInProgress = false;
let serverControlInProgress = false;
let presenterResultsPublished = false;
let storageState = {
  dbFile: ''
};
let conductorPresenceRefreshTimer = null;
let conductorTabletSyncTimer = null;
let accessDialogMandatory = false;
let accessRecoveryDialogResolver = null;
let accessRecoveryDialogActiveElement = null;
let forcePasswordDialogResolver = null;
let forcePasswordDialogActiveElement = null;
let conductorIncludeShadowTabletJudges = false;
const CONDUCTOR_PRESENCE_REFRESH_MS = 10_000;
const CONDUCTOR_TABLET_SYNC_REFRESH_MS = 3_000;

// Etat global: ces fabriques centralisent les valeurs par defaut des sous-modules UI.

function createScoringSettingsState() {
  return {
    grids: [],
    criteria: [],
    panel: '',
    selectedGridKey: 'artistic_solo'
  };
}

function createAccessState() {
  return {
    hasAccounts: false,
    currentAccount: null,
    accounts: [],
    panel: 'login',
    settingsAction: 'create',
    editAccountId: '',
    accessFormMode: 'create',
    recoveryCodesByAccount: {},
    expandedRecoveryAccountId: '',
    recoveryCodesLoadingAccountId: ''
  };
}

function createCompetitionEditState() {
  return {
    competitionId: '',
    assignments: []
  };
}

function createConductorState() {
  return {
    activeCompetitionId: '',
    dispatchModes: {},
    validatedPassages: {},
    manualBatchSelections: {},
    presenterActivePassageId: '',
    activeRecapPopup: null
  };
}

function getConductorPassageKey(competitionId, competitorId) {
  return `${competitionId}:${competitorId}`;
}

function syncConductorStateForCompetition(competitionId) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();

  if (conductorState.activeCompetitionId === normalizedCompetitionId) {
    return;
  }

  conductorState.activeCompetitionId = normalizedCompetitionId;
  conductorState.dispatchModes = {};
  conductorState.manualBatchSelections = {};
  conductorState.presenterActivePassageId = '';
}

function getConductorDispatchMode(competitorId) {
  return conductorState.dispatchModes[competitorId] === 'tablet' ? 'tablet' : 'manual';
}

function setConductorDispatchMode(competitorId, mode) {
  conductorState.dispatchModes[competitorId] = mode === 'tablet' ? 'tablet' : 'manual';
}

function isConductorPassageValidated(competitionId, competitorId) {
  return Boolean(conductorState.validatedPassages[getConductorPassageKey(competitionId, competitorId)]);
}

function setConductorPassageValidated(competitionId, competitorId, validated) {
  const key = getConductorPassageKey(competitionId, competitorId);

  if (validated) {
    conductorState.validatedPassages[key] = true;
    return;
  }

  delete conductorState.validatedPassages[key];
}

function reconcileConductorTabletValidatedState(competitionId, activePresenterCompetitorId) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const normalizedActiveCompetitorId = String(activePresenterCompetitorId ?? '').trim();

  conductorState.presenterActivePassageId = normalizedActiveCompetitorId;

  Object.keys(conductorState.validatedPassages).forEach((key) => {
    if (!key.startsWith(`${normalizedCompetitionId}:`)) {
      return;
    }

    const competitorId = key.slice(normalizedCompetitionId.length + 1);

    if (getConductorDispatchMode(competitorId) !== 'tablet') {
      return;
    }

    if (!normalizedActiveCompetitorId || competitorId !== normalizedActiveCompetitorId) {
      delete conductorState.validatedPassages[key];
    }
  });

  if (normalizedActiveCompetitorId && getConductorDispatchMode(normalizedActiveCompetitorId) === 'tablet') {
    conductorState.validatedPassages[getConductorPassageKey(normalizedCompetitionId, normalizedActiveCompetitorId)] = true;
  }
}

function isConductorManualBatchSelected(competitorId) {
  return Boolean(conductorState.manualBatchSelections[String(competitorId ?? '').trim()]);
}

function setConductorManualBatchSelected(competitorId, selected) {
  const normalizedCompetitorId = String(competitorId ?? '').trim();

  if (!normalizedCompetitorId) {
    return;
  }

  if (selected) {
    conductorState.manualBatchSelections[normalizedCompetitorId] = true;
    return;
  }

  delete conductorState.manualBatchSelections[normalizedCompetitorId];
}

function clearConductorManualBatchSelections() {
  conductorState.manualBatchSelections = {};
}

// Fenetres dediees a la saisie manuelle et au classement categorie.

// Dans l'application desktop (pywebview), window.open() est intercepte par
// le backend WebView2 et redirige vers le navigateur systeme plutot que
// d'ouvrir une fenetre de l'application (cf. README, "Phase 6bis") : on
// passe alors par l'API Python exposee en js_api, qui ouvre une vraie
// fenetre pywebview independante. Comportement navigateur/Node inchange
// sinon (divergence volontaire entre webui/app.js et public/app.js).
function isPywebviewHost() {
  return Boolean(window.pywebview && window.pywebview.api && typeof window.pywebview.api.open_window === 'function');
}

// F11 pour basculer en plein ecran natif (utile sur petit ecran) : la
// fenetre pywebview s'ouvre agrandie ("maximized") par defaut mais garde
// la barre de titre/taskbar, contrairement au plein ecran natif.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'F11' || !isPywebviewHost() || typeof window.pywebview.api.toggle_fullscreen !== 'function') {
    return;
  }

  event.preventDefault();
  window.pywebview.api.toggle_fullscreen().catch(() => {});
});

function createPywebviewWindowHandle(windowName) {
  return {
    closed: false,
    focus() {},
    close() {
      if (this.closed) {
        return;
      }

      this.closed = true;
      window.pywebview.api.close_window(windowName).catch(() => {});
    }
  };
}

function openDedicatedWindow({ url, windowName, popupWidth, popupHeight }) {
  if (isPywebviewHost()) {
    const absoluteUrl = new URL(url, window.location.origin).href;

    window.pywebview.api.open_window(absoluteUrl, windowName, popupWidth, popupHeight).catch((error) => {
      console.error(`Impossible d'ouvrir la fenetre ${windowName}`, error);
    });

    return createPywebviewWindowHandle(windowName);
  }

  const left = Math.max(0, Math.round(window.screenX + ((window.outerWidth - popupWidth) / 2)));
  const top = Math.max(0, Math.round(window.screenY + ((window.outerHeight - popupHeight) / 2)));
  const features = `popup=yes,width=${popupWidth},height=${popupHeight},left=${left},top=${top},resizable=yes,scrollbars=yes`;
  const popup = window.open(url, windowName, features);

  if (popup) {
    popup.focus();
    return popup;
  }

  const newTab = window.open(url, '_blank');

  if (newTab) {
    newTab.focus();
    return newTab;
  }

  return null;
}

function openManualScoringWindow({ competitionId, competitorId }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const normalizedCompetitorId = String(competitorId ?? '').trim();
  const popupWidth = 1000;
  const popupHeight = 920;

  if (!normalizedCompetitionId || !normalizedCompetitorId) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId,
    competitorId: normalizedCompetitorId
  });

  return openDedicatedWindow({
    url: `/manual-scoring.html?${params.toString()}`,
    windowName: `manual-scoring-${normalizedCompetitorId}`,
    popupWidth,
    popupHeight
  });
}

function openManualScoringBatchWindow({ competitionId, competitorIds }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const normalizedCompetitorIds = Array.isArray(competitorIds)
    ? competitorIds.map((competitorId) => String(competitorId ?? '').trim()).filter(Boolean)
    : [];
  const popupWidth = 1280;
  const popupHeight = 940;

  if (!normalizedCompetitionId || !normalizedCompetitorIds.length) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId,
    competitorIds: normalizedCompetitorIds.join(',')
  });

  return openDedicatedWindow({
    url: `/manual-scoring-batch.html?${params.toString()}`,
    windowName: `manual-scoring-batch-${normalizedCompetitionId}`,
    popupWidth,
    popupHeight
  });
}

function openCategoryResultsWindow({ competitionId, category }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const normalizedCategory = String(category ?? '').trim();
  const popupWidth = 980;
  const popupHeight = 860;

  if (!normalizedCompetitionId || !normalizedCategory) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId,
    category: normalizedCategory
  });

  return openDedicatedWindow({
    url: `/category-results.html?${params.toString()}`,
    windowName: `category-results-${normalizedCompetitionId}-${normalizedCategory}`,
    popupWidth,
    popupHeight
  });
}

function openCompetitionResultsWindow({ competitionId, view = 'all' }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const normalizedView = String(view ?? '').trim().toLowerCase();
  const popupWidth = 1160;
  const popupHeight = 920;

  if (!normalizedCompetitionId) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId,
    view: normalizedView === 'podium' || normalizedView === 'ranking' ? normalizedView : 'all'
  });

  return openDedicatedWindow({
    url: `/competition-results.html?${params.toString()}`,
    windowName: `competition-results-${normalizedCompetitionId}-${params.get('view')}`,
    popupWidth,
    popupHeight
  });
}

function openIndividualStatisticsWindow({ competitionId }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const popupWidth = 1320;
  const popupHeight = 940;

  if (!normalizedCompetitionId) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId
  });

  return openDedicatedWindow({
    url: `/individual-statistics.html?${params.toString()}`,
    windowName: `individual-statistics-${normalizedCompetitionId}`,
    popupWidth,
    popupHeight
  });
}

function openScoringSheetsWindow({ competitionId, onlyShadows = false }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const popupWidth = 1220;
  const popupHeight = 920;

  if (!normalizedCompetitionId) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId
  });

  if (onlyShadows) {
    params.set('onlyShadows', '1');
  }

  return openDedicatedWindow({
    url: `/scoring-sheets.html?${params.toString()}`,
    windowName: `scoring-sheets${onlyShadows ? '-shadows' : ''}-${normalizedCompetitionId}`,
    popupWidth,
    popupHeight
  });
}

function openTabletRecapWindow({ competitionId, competitor }) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();
  const normalizedCompetitorId = String(competitor?.id ?? '').trim();
  const popupWidth = 1220;
  const popupHeight = 900;

  if (!normalizedCompetitionId || !normalizedCompetitorId) {
    return null;
  }

  const params = new URLSearchParams({
    competitionId: normalizedCompetitionId,
    competitorId: normalizedCompetitorId,
    runningOrder: String(competitor?.runningOrder ?? '').trim(),
    stageName: String(formatCompetitorAthleteLabel(competitor) ?? '').trim(),
    category: String(competitor?.category ?? '').trim()
  });

  return openDedicatedWindow({
    url: `/tablet-recap.html?${params.toString()}`,
    windowName: `tablet-recap-${normalizedCompetitionId}-${normalizedCompetitorId}`,
    popupWidth,
    popupHeight
  });
}

function getOpenConductorCategories() {
  const accordionRoot = document.querySelector('#conductor-category-accordion');

  if (!accordionRoot) {
    return new Set();
  }

  const openCategories = new Set();

  accordionRoot.querySelectorAll('.conductor-category-item[open] .conductor-category-label').forEach((labelNode) => {
    const label = String(labelNode.textContent ?? '').trim();

    if (label) {
      openCategories.add(label);
    }
  });

  return openCategories;
}

// Synchronisation de l'etat conducteur apres sauvegarde/fermeture des popups de saisie.

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) {
    return;
  }

  const payload = event.data ?? {};

  if (![
    'manual-scoring-saved',
    'manual-scoring-closed',
    'manual-scoring-batch-saved',
    'tablet-recap-closed',
    'tablet-recap-finalized'
  ].includes(payload.type)) {
    return;
  }

  const activeCompetitionId = String(conductorState.activeCompetitionId ?? '').trim();

  if (!activeCompetitionId || payload.competitionId !== activeCompetitionId) {
    return;
  }

  const activeCompetition = competitionsState.find((competition) => competition.id === payload.competitionId) ?? null;

  if (!activeCompetition) {
    return;
  }

  if (payload.type === 'manual-scoring-closed') {
    setConductorPassageValidated(payload.competitionId, payload.competitorId, false);
  }

  if (payload.type === 'manual-scoring-saved') {
    const competitorId = String(payload.competitorId ?? '').trim();

    if (competitorId) {
      setConductorPassageValidated(payload.competitionId, competitorId, !Boolean(payload.cleared));
    }
  }

  if (payload.type === 'manual-scoring-batch-saved') {
    const savedCompetitorIds = Array.isArray(payload.competitorIds)
      ? payload.competitorIds.map((competitorId) => String(competitorId ?? '').trim()).filter(Boolean)
      : [];

    savedCompetitorIds.forEach((competitorId) => {
      setConductorPassageValidated(payload.competitionId, competitorId, !Boolean(payload.cleared));
      setConductorManualBatchSelected(competitorId, false);
    });
  }

  if (payload.type === 'tablet-recap-closed' || payload.type === 'tablet-recap-finalized') {
    const competitorId = String(payload.competitorId ?? '').trim();

    if (competitorId) {
      setConductorPassageValidated(payload.competitionId, competitorId, false);
    }

    conductorState.activeRecapPopup = null;
  }

  const openCategoriesState = getOpenConductorCategories();
  refreshConductorSection(activeCompetition, { openCategories: openCategoriesState }).catch(() => {
    // No-op: un echec de refresh n'empeche pas la saisie popup de continuer.
  });
});

// Session d'acces back-office (settings): token, role et cycle deconnexion.

function getAccessSessionToken() {
  const sessionToken = window.sessionStorage.getItem('access-session-token') ?? '';

  if (sessionToken) {
    return sessionToken;
  }

  const legacyToken = window.localStorage.getItem('access-session-token') ?? '';

  if (legacyToken) {
    window.sessionStorage.setItem('access-session-token', legacyToken);
    window.localStorage.removeItem('access-session-token');
  }

  return legacyToken;
}

function setAccessSessionToken(token) {
  const normalizedToken = String(token ?? '').trim();

  if (!normalizedToken) {
    window.sessionStorage.removeItem('access-session-token');
    window.localStorage.removeItem('access-session-token');
    return;
  }

  window.sessionStorage.setItem('access-session-token', normalizedToken);
  window.localStorage.removeItem('access-session-token');
}

function getAccessRoleLabel(role) {
  switch (role) {
    case 'admin':
      return 'Administrateur';
    case 'scrutateur':
      return 'Scrutateur';
    default:
      return 'Compte';
  }
}

function saveAccessSession(session) {
  if (!session?.token) {
    return;
  }

  setAccessSessionToken(session.token);
  accessState.currentAccount = session.account ?? null;
  syncAccessDrivenNavigation();
}

function clearAccessSession() {
  setAccessSessionToken('');
  accessState.currentAccount = null;
  syncAccessDrivenNavigation();
}

async function logoutAccessSession({ keepSession = false } = {}) {
  const token = getAccessSessionToken();

  if (!token || accessLogoutInProgress) {
    if (!keepSession) {
      clearAccessSession();
    }
    return;
  }

  accessLogoutInProgress = true;

  try {
    await fetch('/api/access/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': token
      },
      keepalive: true
    });
  } catch {
  } finally {
    accessLogoutInProgress = false;
    if (!keepSession) {
      clearAccessSession();
    }
  }
}

function canCurrentUserAccessSettings() {
  return accessState.currentAccount?.role === 'admin';
}

function canCurrentUserManageAccess() {
  return accessState.currentAccount?.role === 'admin';
}

function canCurrentUserManageArchive() {
  return accessState.currentAccount?.role === 'admin';
}

function canCurrentUserEditCriteria() {
  return accessState.currentAccount?.role === 'admin';
}

function canCurrentUserAccessSection(section) {
  if (section === 'login') {
    return !accessState.currentAccount;
  }

  const role = String(accessState.currentAccount?.role ?? '').trim();

  if (!role) {
    return section === 'dashboard';
  }

  if (role === 'admin') {
    return true;
  }

  if (role === 'scrutateur') {
    return section !== 'settings';
  }

  return section === 'dashboard';
}

function syncAccessDrivenNavigation() {
  document.querySelectorAll('.nav-item[data-section]').forEach((button) => {
    const section = button.dataset.section;
    const isVisible = canCurrentUserAccessSection(section);
    button.hidden = !isVisible;
  });

  document.querySelectorAll('[data-nav-action="logout"]').forEach((button) => {
    button.hidden = !Boolean(accessState.currentAccount);
  });

  document.querySelectorAll('[data-section-target]').forEach((button) => {
    const section = button.dataset.sectionTarget;
    button.hidden = !canCurrentUserAccessSection(section);
  });

  if (!canCurrentUserAccessSection(activeSection)) {
    setActiveSection('dashboard');
  }
}

async function openSettingsAfterAuthentication(session, mode) {
  if (!session?.account) {
    return;
  }

  if (session.account.role !== 'admin') {
    showToast('Accès réservé à l\'administrateur.', 'error');
    return;
  }

  saveAccessSession(session);
  await enforcePasswordChangeIfRequired(session);
  await refreshAccessState();
  await refresh();
  setActiveSection('settings');

  if (session.account.role === 'admin') {
    openScoringSettingsPanel('criteria');
    return;
  }

  if (mode === 'bootstrap') {
    openScoringSettingsPanel('access');
    return;
  }

  openScoringSettingsPanel('');
}

function createCompetitionWizardState() {
  return {
    step: 'general',
    competitionId: '',
    presenterEnabled: false,
    assignments: [],
    competitors: [],
    competitorImport: createCompetitionCompetitorImportState()
  };
}

function createCompetitionCompetitorImportState() {
  return {
    fileName: '',
    sheetName: '',
    rows: [],
    stats: {
      soloCount: 0,
      duoCount: 0,
      paraCount: 0,
      residentCount: 0,
      skippedCount: 0
    }
  };
}

function createCompetitorManagementState() {
  return {
    competitionId: '',
    competitors: [],
    importState: createCompetitionCompetitorImportState()
  };
}

function resetCompetitorManagement() {
  competitorManagementState = createCompetitorManagementState();
}

function clearJudgeCredentialInputs() {
  const loginInput = document.querySelector('#judge-form input[name="login"]');
  const passwordInput = document.querySelector('#judge-form input[name="password"]');

  if (loginInput) {
    loginInput.value = '';
  }

  if (passwordInput) {
    passwordInput.value = '';
  }
}

// Navigation principale: active la vue, applique les gardes et reset les etats transitoires.

function setActiveSection(section) {
  if (section === 'login') {
    const mode = accessState.hasAccounts ? 'login' : 'bootstrap';

    openAccessAuthDialog(mode, { mandatory: false }).then((session) => {
      if (session?.account) {
        saveAccessSession(session);
        enforcePasswordChangeIfRequired(session).then(() => refreshAccessState()).then(() => refresh()).then(() => {
          setActiveSection('dashboard');
        }).catch((error) => {
          showToast(error.message, 'error');
        });
      }
    });

    return;
  }

  const nextSection = sectionMeta[section] ? section : 'dashboard';

  if (nextSection === 'settings' && !canCurrentUserAccessSettings()) {
    if (!accessState.currentAccount) {
      openAccessAuthDialog(accessState.hasAccounts ? 'login' : 'bootstrap', { mandatory: true }).then((session) => {
        if (session) {
          openSettingsAfterAuthentication(session, accessState.hasAccounts ? 'login' : 'bootstrap').catch((error) => {
            showToast(error.message, 'error');
          });
        }
      });
      return;
    }

    showToast('Accès réservé à l\'admin.', 'error');
    return;
  }

  if (!canCurrentUserAccessSection(nextSection)) {
    return;
  }

  const isLeavingCompetitions = activeSection === 'competitions' && nextSection !== 'competitions';
  const isLeavingCompetitors = activeSection === 'competitors' && nextSection !== 'competitors';

  if (isLeavingCompetitions) {
    resetCompetitionWizard();
    resetCompetitionEditState();
    setCompetitionMode('create');
    setCompetitionDirectoryVisibility(false);
  }

  if (isLeavingCompetitors) {
    resetCompetitorManagement();
  }

  const isOpeningConductor = activeSection !== 'conductor' && nextSection === 'conductor';

  if (isOpeningConductor) {
    clearConductorManualBatchSelections();
  }

  activeSection = nextSection;
  const meta = sectionMeta[nextSection] ?? sectionMeta.dashboard;
  const viewKickerNode = document.querySelector('#view-kicker');
  const viewTitleNode = document.querySelector('#view-title');
  const viewSubtitleNode = document.querySelector('#view-subtitle');

  if (viewKickerNode) {
    viewKickerNode.textContent = meta.kicker;
  }

  if (viewTitleNode) {
    viewTitleNode.textContent = meta.title;
  }

  if (viewSubtitleNode) {
    viewSubtitleNode.textContent = meta.subtitle;
  }

  document.querySelectorAll('.nav-item[data-section]').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.section === nextSection);
  });

  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('is-active', view.dataset.view === nextSection);
  });

  if (nextSection === 'competitions') {
    setCompetitionDirectoryVisibility(true);
  }

  if (nextSection === 'competitors') {
    renderCompetitorManagementSection().catch((error) => {
      showToast(error.message, 'error');
    });
  }

  if (nextSection === 'settings') {
    scoringSettingsState.panel = accessState.currentAccount?.role === 'admin' ? 'access' : '';
    accessState.settingsAction = 'create';
    resetAccessAccountForm();
    renderScoringSettings();
  }

  if (nextSection === 'conductor') {
    const activeCompetition = competitionsState.find((competition) => competition.status === 'active') ?? null;
    refreshConductorSection(activeCompetition).catch(() => {
    });
  }

  if (nextSection === 'judges') {
    clearJudgeCredentialInputs();
    window.requestAnimationFrame(() => {
      clearJudgeCredentialInputs();
    });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function competitionOption(competition) {
  return `
    <option value="${competition.id}">${escapeHtml(`${competition.name} · ${formatCompetitionMetaLabel(competition)}`)}</option>
  `;
}

function competitionDirectoryOption(competition) {
  return `
    <option value="${competition.id}">
      ${escapeHtml(`${formatFrenchDate(competition.eventDate)} | ${competition.name} | ${formatCompetitionMetaLabel(competition)}`)}
    </option>
  `;
}

function normalizeCompetitionLevelValue(value) {
  return competitionLevelOptions.some((option) => option.value === value) ? value : 'defi';
}

function formatCompetitionLevelLabel(value) {
  const normalizedValue = normalizeCompetitionLevelValue(value);
  return competitionLevelOptions.find((option) => option.value === normalizedValue)?.label ?? 'Défi danse';
}

function formatCompetitionTerritoryLabel(competition) {
  if (normalizeCompetitionLevelValue(competition.competitionLevel) !== 'regional') {
    return '';
  }

  const parts = [competition.region, competition.zone].filter(Boolean);
  return parts.join(' · ');
}

function formatCompetitionMetaLabel(competition) {
  const territory = formatCompetitionTerritoryLabel(competition);
  return [
    formatSeasonLabel(competition.season, competition.eventDate),
    formatCompetitionLevelLabel(competition.competitionLevel),
    territory
  ].filter(Boolean).join(' · ');
}

function normalizeCompetitionJudgeCountValue(value) {
  const parsedValue = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsedValue)) {
    return 3;
  }

  return Math.min(Math.max(parsedValue, 1), 20);
}

function formatCompetitionJudgeCountLabel(value) {
  const judgeCount = normalizeCompetitionJudgeCountValue(value);
  return `${judgeCount} juge${judgeCount > 1 ? 's' : ''} prévu${judgeCount > 1 ? 's' : ''}`;
}

function normalizeImportLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function formatImportedCompetitorMember(lastName, firstName) {
  const parts = [String(lastName ?? '').trim(), String(firstName ?? '').trim()].filter(Boolean);
  return parts.join(' ').trim();
}

function buildImportedCompetitionStageName(row) {
  const participantOne = formatImportedCompetitorMember(row[2], row[3]);
  const participantTwo = formatImportedCompetitorMember(row[7], row[8]);

  if (participantOne && participantTwo) {
    return `${participantOne} / ${participantTwo}`;
  }

  return participantOne || participantTwo;
}

function buildImportedCompetitionMembers(row) {
  return [
    {
      memberOrder: 1,
      lastName: String(row[2] ?? '').trim(),
      firstName: String(row[3] ?? '').trim(),
      birthDate: String(row[4] ?? '').trim(),
      isResident: parseImportedResidentFlag(row[6])
    },
    {
      memberOrder: 2,
      lastName: String(row[7] ?? '').trim(),
      firstName: String(row[8] ?? '').trim(),
      birthDate: String(row[9] ?? '').trim(),
      isResident: parseImportedResidentFlag(row[11])
    }
  ].filter((member) => member.lastName || member.firstName || member.birthDate);
}

function buildImportedCompetitionNames(row) {
  const members = buildImportedCompetitionMembers(row);
  const lastNames = members.map((member) => member.lastName).filter(Boolean);
  const firstNames = members.map((member) => member.firstName).filter(Boolean);

  return {
    lastName: lastNames.join(' / '),
    firstName: firstNames.join(' / ')
  };
}

function parseImportedResidentFlag(value) {
  const normalizedValue = normalizeImportLabel(value);
  return normalizedValue === 'resident'
    || normalizedValue === 'resid'
    || normalizedValue === 'r'
    || normalizedValue === 'oui'
    || normalizedValue === 'yes'
    || normalizedValue === 'true'
    || normalizedValue === '1';
}

// Import Excel (feuille Candidats): parsing, normalisation et preparation de l'import API.

async function parseCompetitionCompetitorWorkbook(file) {
  if (!window.XLSX?.read || !window.XLSX?.utils?.sheet_to_json) {
    throw new Error('La lecture Excel n\'est pas disponible sur ce poste');
  }

  const workbook = window.XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    cellDates: false
  });

  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length < 2) {
    throw new Error('Le classeur doit contenir au moins deux feuilles');
  }

  const sheetName = workbook.SheetNames[1];
  const worksheet = workbook.Sheets[sheetName];
  const matrix = window.XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false
  }).filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''));

  if (matrix.length < 3) {
    throw new Error('La deuxième feuille ne contient pas de données exploitables');
  }

  const headerRow = matrix[1].map((cell) => String(cell ?? '').trim());
  const normalizedHeaders = headerRow.map(normalizeImportLabel);
  const expectedHeaders = ['passage', 'categorie', 'nom en majuscules', 'prenom', 'date de naissance'];

  if (!expectedHeaders.every((header, index) => normalizedHeaders[index] === header)) {
    throw new Error('La feuille Candidats ne correspond pas au modèle attendu');
  }

  const dataRows = matrix.slice(2);
  const rows = [];
  const stats = {
    soloCount: 0,
    duoCount: 0,
    paraCount: 0,
    residentCount: 0,
    skippedCount: 0
  };

  for (const [index, row] of dataRows.entries()) {
    const values = Array.from({ length: 14 }, (_, cellIndex) => String(row[cellIndex] ?? '').trim());
    const runningOrder = normalizeImportedRunningOrder(values[0]);
    const category = values[1];
    const stageName = buildImportedCompetitionStageName(values);
    const members = buildImportedCompetitionMembers(values);
    const names = buildImportedCompetitionNames(values);
    const hasParticipantTwo = Boolean(values[7] || values[8] || values[9] || values[10] || values[11]);
    const isResident = parseImportedResidentFlag(values[6]) || parseImportedResidentFlag(values[11]);
    const isPara = values[12] === 'OUI';

    if (!runningOrder || !category || !stageName) {
      if (values.some(Boolean)) {
        stats.skippedCount += 1;
      }
      continue;
    }

    if (hasParticipantTwo) {
      stats.duoCount += 1;
    } else {
      stats.soloCount += 1;
    }

    if (isPara) {
      stats.paraCount += 1;
    }

    if (isResident) {
      stats.residentCount += 1;
    }

    rows.push({
      rowNumber: index + 3,
      runningOrder,
      category,
      stageName,
      firstName: names.firstName,
      lastName: names.lastName,
      members,
      isResident,
      isPara,
      isDuo: hasParticipantTwo
    });
  }

  if (rows.length === 0) {
    throw new Error('Aucune ligne exploitable à importer depuis la feuille Candidats');
  }

  return {
    fileName: file.name,
    sheetName,
    rows,
    stats
  };
}

function renderCompetitionCompetitorImportPanel() {
  const state = competitionWizardState.competitorImport;
  const sheetLabel = document.querySelector('#competition-competitor-import-sheet');
  const config = document.querySelector('#competition-competitor-import-config');
  const summary = document.querySelector('#competition-competitor-import-summary');
  const submitButton = document.querySelector('#competition-competitor-import-submit');
  const resetButton = document.querySelector('#competition-competitor-import-reset');

  if (!sheetLabel || !config || !summary || !submitButton || !resetButton) {
    return;
  }

  sheetLabel.textContent = state.fileName
    ? `${state.fileName} · feuille 2 : ${state.sheetName}`
    : 'Aucun fichier chargé.';

  if (state.rows.length === 0) {
    config.hidden = true;
    summary.textContent = '';
    resetButton.disabled = true;
    submitButton.disabled = true;
    return;
  }

  config.hidden = false;
  const { soloCount, duoCount, paraCount, residentCount, skippedCount } = state.stats;
  summary.textContent = [
    `${state.rows.length} ligne${state.rows.length > 1 ? 's' : ''} prête${state.rows.length > 1 ? 's' : ''} à l'import`,
    `${soloCount} solo${soloCount > 1 ? 's' : ''}`,
    `${duoCount} duo${duoCount > 1 ? 's' : ''}`,
    `${paraCount} parapole`,
    `${residentCount} résident${residentCount > 1 ? 's' : ''}`
  ].join(' • ') + (skippedCount > 0 ? ` • ${skippedCount} ligne(s) incomplète(s) ignorée(s)` : '');
  submitButton.disabled = state.rows.length === 0;
  resetButton.disabled = false;
}

function normalizeImportedRunningOrder(value) {
  const match = String(value ?? '').trim().match(/\d+/);

  if (!match) {
    return null;
  }

  const parsedValue = Number.parseInt(match[0], 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function buildImportedCompetitorIdentity(stageName, runningOrder) {
  return `${normalizeImportLabel(stageName)}::${runningOrder}`;
}

function clearCompetitionCompetitorImport() {
  competitionWizardState.competitorImport = createCompetitionCompetitorImportState();
  const fileInput = document.querySelector('#competition-competitor-import-file');

  if (fileInput) {
    fileInput.value = '';
  }

  renderCompetitionCompetitorImportPanel();
}

async function importCompetitionCompetitorsFromWorkbook() {
  if (!competitionWizardState.competitionId) {
    throw new Error('Enregistrez d\'abord la compétition avant d\'importer les compétiteurs');
  }

  const importState = competitionWizardState.competitorImport;

  if (!importState.rows.length) {
    throw new Error('Chargez d\'abord un classeur Excel');
  }

  const knownCompetitors = new Set(
    competitionWizardState.competitors.map((competitor) => buildImportedCompetitorIdentity(competitor.stageName, competitor.runningOrder))
  );
  const rowsToImport = [];
  let skippedCount = importState.stats.skippedCount;

  for (const row of importState.rows) {
    const identity = buildImportedCompetitorIdentity(row.stageName, row.runningOrder);

    if (knownCompetitors.has(identity)) {
      skippedCount += 1;
      continue;
    }

    knownCompetitors.add(identity);
    rowsToImport.push({
      stageName: row.stageName,
      firstName: row.firstName,
      lastName: row.lastName,
      members: row.members,
      category: row.category,
      isResident: row.isResident,
      runningOrder: row.runningOrder
    });
  }

  if (rowsToImport.length === 0) {
    throw new Error('Aucune ligne exploitable à importer depuis la deuxième feuille');
  }

  let importedCount = 0;

  for (const competitor of rowsToImport) {
    await request(`/api/competitions/${competitionWizardState.competitionId}/competitors`, {
      method: 'POST',
      body: JSON.stringify(competitor)
    });
    importedCount += 1;
  }

  clearCompetitionCompetitorImport();
  await hydrateCompetitionWizardData();
  await refresh();
  setCompetitionMode('create');
  setCompetitionWizardStep('competitors');
  showToast(
    skippedCount > 0
      ? `Import Excel terminé: ${importedCount} compétiteur(s) ajouté(s), ${skippedCount} ligne(s) ignorée(s).`
      : `Import Excel terminé: ${importedCount} compétiteur(s) ajouté(s).`,
    'success'
  );
}

function buildCompetitionUpdatePayload(competition, overrides = {}) {
  return {
    name: competition.name ?? '',
    location: competition.location ?? '',
    eventDate: competition.eventDate ?? '',
    season: competition.season ?? getCurrentSeasonValue(),
    competitionLevel: competition.competitionLevel ?? 'defi',
    region: competition.region ?? '',
    zone: competition.zone ?? '',
    judgeCount: competition.judgeCount ?? 3,
    scrutateurName: competition.scrutateurName ?? '',
    status: competition.status ?? 'draft',
    ...overrides
  };
}

function formatSeasonLabel(value, eventDate = '') {
  return `Saison ${normalizeSeasonValue(value, eventDate)}`;
}

// Helpers de saison et options de formulaires competitions.

function getCurrentSeasonValue() {
  const currentDate = new Date();
  const startYear = currentDate.getMonth() + 1 >= 9
    ? currentDate.getFullYear()
    : currentDate.getFullYear() - 1;
  return `${startYear}/${startYear + 1}`;
}

function getSeasonValueFromEventDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return getCurrentSeasonValue();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 9 ? year : year - 1;
  return `${startYear}/${startYear + 1}`;
}

function normalizeSeasonValue(value, eventDate = '') {
  const rawValue = String(value ?? '').trim().replace(/^saison\s+/i, '').replace(/\s+/g, '');
  const match = rawValue.match(/^(\d{4})\/(\d{4})$/);

  if (match && Number(match[2]) === Number(match[1]) + 1) {
    return `${match[1]}/${match[2]}`;
  }

  return getSeasonValueFromEventDate(eventDate);
}

function getSeasonStartYear(value, eventDate = '') {
  const normalizedValue = normalizeSeasonValue(value, eventDate);
  const match = normalizedValue.match(/^(\d{4})\/(\d{4})$/);
  return match ? Number(match[1]) : 0;
}

function buildAvailableSeasonValues(extraValues = []) {
  const currentStartYear = getSeasonStartYear(getCurrentSeasonValue());
  const values = [];

  for (let year = currentStartYear + 1; year >= 2000; year -= 1) {
    values.push(`${year}/${year + 1}`);
  }

  return [...new Set([
    ...extraValues.map((value) => normalizeSeasonValue(value)).filter(Boolean),
    ...values
  ])].sort((left, right) => getSeasonStartYear(right) - getSeasonStartYear(left));
}

function setSeasonSelectOptions(select, selectedValue, { includeAll = false } = {}) {
  if (!select) {
    return '';
  }

  const seasonValues = buildAvailableSeasonValues([
    ...competitionsState.map((competition) => competition.season),
    selectedValue
  ]);
  const recentValues = seasonValues.slice(0, 4);
  const archiveValues = seasonValues.slice(4);
  const normalizedSelectedValue = includeAll && selectedValue === 'all'
    ? 'all'
    : normalizeSeasonValue(selectedValue);

  select.innerHTML = `
    ${includeAll ? '<option value="all">Toutes les saisons</option>' : ''}
    <optgroup label="Saisons récentes">
      ${recentValues.map((seasonValue) => `
        <option value="${seasonValue}">${escapeHtml(formatSeasonLabel(seasonValue))}</option>
      `).join('')}
    </optgroup>
    ${archiveValues.length > 0 ? `
      <optgroup label="Archives">
        ${archiveValues.map((seasonValue) => `
          <option value="${seasonValue}">${escapeHtml(formatSeasonLabel(seasonValue))}</option>
        `).join('')}
      </optgroup>
    ` : ''}
  `;

  const fallbackValue = includeAll ? 'all' : recentValues[0] ?? getCurrentSeasonValue();
  select.value = includeAll && normalizedSelectedValue === 'all'
    ? 'all'
    : seasonValues.includes(normalizedSelectedValue)
      ? normalizedSelectedValue
      : fallbackValue;

  return select.value;
}

function setCompetitionLevelOptions(select, selectedValue = '', { allowEmpty = false } = {}) {
  if (!select) {
    return allowEmpty ? '' : 'defi';
  }

  const hasSelectedValue = competitionLevelOptions.some((option) => option.value === selectedValue);
  select.innerHTML = `${allowEmpty ? '<option value="">Sélectionnez un niveau</option>' : ''}${competitionLevelOptions.map((option) => `
    <option value="${option.value}">${escapeHtml(option.label)}</option>
  `).join('')}`;
  select.value = hasSelectedValue ? selectedValue : (allowEmpty ? '' : 'defi');
  return select.value;
}

function setSingleOptionSelect(select, label) {
  if (!select) {
    return '';
  }

  select.innerHTML = `<option value="">${escapeHtml(label)}</option>`;
  select.value = '';
  return '';
}

function setCompetitionStatusOptions(select, selectedValue = '', { allowEmpty = false } = {}) {
  if (!select) {
    return allowEmpty ? '' : 'draft';
  }

  const statusOptions = [
    { value: 'draft', label: 'Brouillon' },
    { value: 'active', label: 'Active' },
    { value: 'closed', label: 'Clôturée' }
  ];
  const hasSelectedValue = statusOptions.some((option) => option.value === selectedValue);

  select.innerHTML = `${allowEmpty ? '<option value="">Sélectionnez un statut</option>' : ''}${statusOptions.map((option) => `
    <option value="${option.value}">${escapeHtml(option.label)}</option>
  `).join('')}`;
  select.value = hasSelectedValue ? selectedValue : (allowEmpty ? '' : 'draft');
  return select.value;
}

function setCompetitionJudgeCountOptions(select, selectedValue = 3) {
  if (!select) {
    return '3';
  }

  const normalizedValue = String(normalizeCompetitionJudgeCountValue(selectedValue));
  select.innerHTML = competitionJudgeCountOptions.map((option) => `
    <option value="${option.value}">${escapeHtml(option.label)}</option>
  `).join('');
  select.value = normalizedValue;
  return select.value;
}

function setCompetitionRegionOptions(select, selectedValue = '') {
  if (!select) {
    return '';
  }

  const regions = Object.keys(competitionRegionZones);
  select.innerHTML = `
    <option value="">Sélectionnez une région</option>
    ${regions.map((region) => `<option value="${region}">${escapeHtml(region)}</option>`).join('')}
  `;
  select.value = regions.includes(selectedValue) ? selectedValue : '';
  return select.value;
}

function updateCompetitionRegionalFields(mode, preferredRegion = '') {
  const isEdit = mode === 'edit';
  const levelSelect = document.querySelector(isEdit ? '#competition-edit-level' : '#competition-level');
  const regionSelect = document.querySelector(isEdit ? '#competition-edit-region' : '#competition-region');
  const zoneInput = document.querySelector(isEdit ? '#competition-edit-zone' : '#competition-zone');
  const fieldSelector = isEdit ? '[data-edit-regional-field]' : '[data-regional-field]';
  const levelValue = levelSelect?.value ?? '';

  document.querySelectorAll(fieldSelector).forEach((field) => {
    field.hidden = levelValue !== 'regional';
  });

  if (levelValue !== 'regional') {
    if (regionSelect) {
      setCompetitionRegionOptions(regionSelect, '');
    }
    if (zoneInput) {
      zoneInput.value = '';
    }
    return;
  }

  const selectedRegion = setCompetitionRegionOptions(regionSelect, preferredRegion || regionSelect?.value || '');
  if (zoneInput) {
    zoneInput.value = selectedRegion ? competitionRegionZones[selectedRegion] ?? '' : '';
  }
}

function getFilteredCompetitions() {
  if (activeCompetitionSeasonFilter === 'all') {
    return competitionsState;
  }

  return competitionsState.filter((competition) => {
    return normalizeSeasonValue(competition.season, competition.eventDate) === activeCompetitionSeasonFilter;
  });
}

function formatJudgeDirectoryLabel(judge) {
  const lastName = String(judge.lastName ?? '').trim();
  const firstName = String(judge.firstName ?? '').trim();

  if (lastName && firstName) {
    return `${lastName} - ${firstName}`;
  }

  if (lastName) {
    return lastName;
  }

  if (firstName) {
    return firstName;
  }

  return String(judge.name ?? '').trim() || 'Juge sans nom';
}

let toastTimer = null;
let confirmDialogResolver = null;
let confirmDialogActiveElement = null;
let inputDialogResolver = null;
let inputDialogActiveElement = null;
let accessDialogResolver = null;
let accessDialogActiveElement = null;
let accessDialogMode = 'login';
let judgeEditDialogActiveElement = null;

// Composants de dialogue reutilisables (confirm/input/access + edition juge).

function hideConfirmDialog(confirmed) {
  const root = document.querySelector('#app-confirm-dialog');
  const resolve = confirmDialogResolver;

  if (!root || !resolve) {
    return;
  }

  confirmDialogResolver = null;
  root.hidden = true;
  document.removeEventListener('keydown', handleConfirmDialogKeydown);

  const activeElement = confirmDialogActiveElement;
  confirmDialogActiveElement = null;
  if (activeElement instanceof HTMLElement) {
    activeElement.focus();
  }

  resolve(confirmed);
}

function handleConfirmDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideConfirmDialog(false);
  }
}

function showConfirmDialog({
  title = 'Confirmer la suppression',
  message,
  confirmLabel = 'Supprimer',
  cancelLabel = 'Annuler'
}) {
  const root = document.querySelector('#app-confirm-dialog');
  const titleElement = document.querySelector('#app-confirm-dialog-title');
  const messageElement = document.querySelector('#app-confirm-dialog-message');
  const confirmButton = document.querySelector('#app-confirm-dialog-confirm');
  const cancelButton = document.querySelector('#app-confirm-dialog-cancel');

  if (!root || !titleElement || !messageElement || !confirmButton || !cancelButton) {
    return Promise.resolve(window.confirm(message));
  }

  if (confirmDialogResolver) {
    hideConfirmDialog(false);
  }

  if (inputDialogResolver) {
    hideInputDialog(null);
  }

  titleElement.textContent = title;
  messageElement.textContent = message;
  confirmButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  confirmDialogActiveElement = document.activeElement;
  root.hidden = false;
  document.addEventListener('keydown', handleConfirmDialogKeydown);

  return new Promise((resolve) => {
    confirmDialogResolver = resolve;
    window.requestAnimationFrame(() => {
      confirmButton.focus();
    });
  });
}

function hideInputDialog(value) {
  const root = document.querySelector('#app-input-dialog');
  const resolve = inputDialogResolver;

  if (!root || !resolve) {
    return;
  }

  inputDialogResolver = null;
  root.hidden = true;
  document.removeEventListener('keydown', handleInputDialogKeydown);

  const activeElement = inputDialogActiveElement;
  inputDialogActiveElement = null;
  if (activeElement instanceof HTMLElement) {
    activeElement.focus();
  }

  resolve(value);
}

function handleInputDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideInputDialog(null);
  }
}

function showInputDialog({
  title = 'Modifier',
  message = '',
  fieldLabel = 'Valeur',
  initialValue = '',
  confirmLabel = 'Enregistrer',
  cancelLabel = 'Annuler'
}) {
  const root = document.querySelector('#app-input-dialog');
  const titleElement = document.querySelector('#app-input-dialog-title');
  const messageElement = document.querySelector('#app-input-dialog-message');
  const fieldLabelElement = document.querySelector('.app-input-dialog__field > span');
  const inputElement = document.querySelector('#app-input-dialog-value');
  const confirmButton = document.querySelector('#app-input-dialog-confirm');
  const cancelButton = document.querySelector('#app-input-dialog-cancel');

  if (!root || !titleElement || !messageElement || !fieldLabelElement || !inputElement || !confirmButton || !cancelButton) {
    return Promise.resolve(window.prompt(message || title, String(initialValue ?? '')));
  }

  if (inputDialogResolver) {
    hideInputDialog(null);
  }

  if (confirmDialogResolver) {
    hideConfirmDialog(false);
  }

  titleElement.textContent = title;
  messageElement.textContent = message;
  fieldLabelElement.textContent = fieldLabel;
  inputElement.value = String(initialValue ?? '');
  confirmButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  inputDialogActiveElement = document.activeElement;
  root.hidden = false;
  document.addEventListener('keydown', handleInputDialogKeydown);

  return new Promise((resolve) => {
    inputDialogResolver = resolve;
    window.requestAnimationFrame(() => {
      inputElement.focus();
      inputElement.select();
    });
  });
}

function hideAccessAuthDialog(result) {
  const root = document.querySelector('#app-access-dialog');
  const resolve = accessDialogResolver;

  if (!root || !resolve) {
    return;
  }

  if (accessDialogMandatory && result === null) {
    return;
  }

  accessDialogResolver = null;
  root.hidden = true;
  document.removeEventListener('keydown', handleAccessDialogKeydown);

  const activeElement = accessDialogActiveElement;
  accessDialogActiveElement = null;
  if (activeElement instanceof HTMLElement) {
    activeElement.focus();
  }

  accessDialogMandatory = false;

  resolve(result);
}

function handleAccessDialogKeydown(event) {
  if (event.key === 'Escape') {
    if (accessDialogMandatory) {
      return;
    }

    event.preventDefault();
    hideAccessAuthDialog(null);
  }
}

function openAccessAuthDialog(mode = 'login', options = {}) {
  const root = document.querySelector('#app-access-dialog');
  const titleElement = document.querySelector('#app-access-dialog-title');
  const messageElement = document.querySelector('#app-access-dialog-message');
  const bootstrapFields = document.querySelector('.app-access-dialog__bootstrap-fields');
  const firstNameInput = document.querySelector('#app-access-dialog-first-name');
  const lastNameInput = document.querySelector('#app-access-dialog-last-name');
  const loginInput = document.querySelector('#app-access-dialog-login');
  const passwordInput = document.querySelector('#app-access-dialog-password');
  const forgotButton = document.querySelector('#app-access-dialog-forgot');
  const confirmButton = document.querySelector('#app-access-dialog-confirm');
  const cancelButton = document.querySelector('#app-access-dialog-cancel');

  if (!root || !titleElement || !messageElement || !bootstrapFields || !firstNameInput || !lastNameInput || !loginInput || !passwordInput || !confirmButton || !cancelButton || !forgotButton) {
    return Promise.resolve(null);
  }

  accessDialogMandatory = Boolean(options.mandatory);
  accessDialogMode = mode === 'bootstrap' ? 'bootstrap' : 'login';

  if (accessDialogResolver) {
    hideAccessAuthDialog(null);
  }

  titleElement.textContent = accessDialogMode === 'bootstrap'
    ? 'Créer le premier admin'
    : (accessDialogMandatory ? 'Connexion requise au démarrage' : 'Se connecter à l\'administration');
  messageElement.textContent = accessDialogMode === 'bootstrap'
    ? 'Aucun compte d\'accès n\'existe encore. Créez le premier admin pour ouvrir l\'administration.'
    : (accessDialogMandatory
      ? 'Identifiez-vous pour ouvrir l\'application et charger vos droits.'
      : 'Identifiez-vous avec votre login et votre mot de passe.');
  bootstrapFields.hidden = accessDialogMode !== 'bootstrap';
  firstNameInput.required = accessDialogMode === 'bootstrap';
  lastNameInput.required = accessDialogMode === 'bootstrap';
  firstNameInput.value = '';
  lastNameInput.value = '';
  loginInput.value = '';
  passwordInput.value = '';
  confirmButton.textContent = accessDialogMode === 'bootstrap' ? 'Créer et ouvrir' : 'Se connecter';
  forgotButton.hidden = accessDialogMode === 'bootstrap';
  cancelButton.textContent = 'Annuler';
  cancelButton.hidden = accessDialogMandatory;
  cancelButton.disabled = accessDialogMandatory;
  accessDialogActiveElement = document.activeElement;
  root.hidden = false;
  document.addEventListener('keydown', handleAccessDialogKeydown);

  return new Promise((resolve) => {
    accessDialogResolver = resolve;
    window.requestAnimationFrame(() => {
      (accessDialogMode === 'bootstrap' ? firstNameInput : loginInput).focus();
    });
  });
}

function hideAccessRecoveryDialog(result) {
  const root = document.querySelector('#app-access-recovery-dialog');
  const resolve = accessRecoveryDialogResolver;

  if (!root || !resolve) {
    return;
  }

  accessRecoveryDialogResolver = null;
  root.hidden = true;

  const activeElement = accessRecoveryDialogActiveElement;
  accessRecoveryDialogActiveElement = null;
  if (activeElement instanceof HTMLElement) {
    activeElement.focus();
  }

  resolve(result);
}

function openAccessRecoveryDialog() {
  const root = document.querySelector('#app-access-recovery-dialog');
  const loginInput = document.querySelector('#app-access-recovery-login');
  const codeInput = document.querySelector('#app-access-recovery-code');

  if (!root || !loginInput || !codeInput) {
    return Promise.resolve(null);
  }

  if (accessRecoveryDialogResolver) {
    hideAccessRecoveryDialog(null);
  }

  loginInput.value = '';
  codeInput.value = '';
  accessRecoveryDialogActiveElement = document.activeElement;
  root.hidden = false;

  return new Promise((resolve) => {
    accessRecoveryDialogResolver = resolve;
    window.requestAnimationFrame(() => {
      loginInput.focus();
    });
  });
}

function hideForcePasswordDialog(result) {
  const root = document.querySelector('#app-access-force-password-dialog');
  const resolve = forcePasswordDialogResolver;

  if (!root || !resolve) {
    return;
  }

  forcePasswordDialogResolver = null;
  root.hidden = true;

  const activeElement = forcePasswordDialogActiveElement;
  forcePasswordDialogActiveElement = null;
  if (activeElement instanceof HTMLElement) {
    activeElement.focus();
  }

  resolve(result);
}

function openForcePasswordDialog() {
  const root = document.querySelector('#app-access-force-password-dialog');
  const passwordInput = document.querySelector('#app-access-force-password');
  const confirmInput = document.querySelector('#app-access-force-password-confirm');
  const toggleButton = document.querySelector('#app-access-force-password-toggle');

  if (!root || !passwordInput || !confirmInput || !toggleButton) {
    return Promise.resolve(false);
  }

  if (forcePasswordDialogResolver) {
    hideForcePasswordDialog(false);
  }

  passwordInput.value = '';
  passwordInput.type = 'password';
  confirmInput.value = '';
  toggleButton.textContent = 'Afficher';
  toggleButton.setAttribute('aria-label', 'Afficher le mot de passe');
  forcePasswordDialogActiveElement = document.activeElement;
  root.hidden = false;

  return new Promise((resolve) => {
    forcePasswordDialogResolver = resolve;
    window.requestAnimationFrame(() => {
      passwordInput.focus();
    });
  });
}

async function enforcePasswordChangeIfRequired(session = null) {
  const mustChangePassword = Boolean(session?.account?.mustChangePassword ?? accessState.currentAccount?.mustChangePassword);

  if (!mustChangePassword) {
    return;
  }

  const completed = await openForcePasswordDialog();

  if (!completed) {
    await performSettingsLogout();
  }
}

function hideJudgeEditDialog() {
  const root = document.querySelector('#app-judge-edit-dialog');

  if (!root || root.hidden) {
    return;
  }

  root.hidden = true;
  document.removeEventListener('keydown', handleJudgeEditDialogKeydown);

  const activeElement = judgeEditDialogActiveElement;
  judgeEditDialogActiveElement = null;
  if (activeElement instanceof HTMLElement) {
    activeElement.focus();
  }
}

function handleJudgeEditDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideJudgeEditDialog();
  }
}

function openJudgeEditDialog(judge) {
  const root = document.querySelector('#app-judge-edit-dialog');
  const idInput = document.querySelector('#app-judge-edit-dialog-id');
  const lastNameInput = document.querySelector('#app-judge-edit-last-name');
  const firstNameInput = document.querySelector('#app-judge-edit-first-name');
  const loginInput = document.querySelector('#app-judge-edit-login');
  const passwordInput = document.querySelector('#app-judge-edit-password');

  if (!root || !idInput || !lastNameInput || !firstNameInput || !loginInput || !passwordInput) {
    return;
  }

  idInput.value = String(judge.id ?? '');
  lastNameInput.value = String(judge.lastName ?? '').trim();
  firstNameInput.value = String(judge.firstName ?? '').trim();
  loginInput.value = String(judge.login ?? '').trim();
  passwordInput.value = '';

  judgeEditDialogActiveElement = document.activeElement;
  root.hidden = false;
  document.addEventListener('keydown', handleJudgeEditDialogKeydown);
  window.requestAnimationFrame(() => {
    lastNameInput.focus();
    lastNameInput.select();
  });
}

function showToast(message, type = 'success') {
  const root = document.querySelector('#app-toast');

  if (!root) {
    return;
  }

  root.textContent = message;
  root.dataset.type = type;
  root.dataset.state = 'visible';

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    root.dataset.state = 'hidden';
  }, 2600);
}

function formatFrenchDate(value) {
  if (!value) {
    return 'Non définie';
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return value;
  }

  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}

function setServerControlButtonsDisabled(disabled) {
  document.querySelectorAll('[data-server-control]').forEach((button) => {
    button.disabled = Boolean(disabled);
  });
}

function syncPresenterResultsServerControlButton() {
  const button = document.querySelector('[data-server-control="presenter-results"]');

  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.textContent = presenterResultsPublished ? 'Annuler l\'envoi Résultats' : 'Envoi des résultats';
  button.classList.toggle('ghost-button', presenterResultsPublished);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function isFetchNetworkFailure(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('failed to fetch') || message.includes('networkerror');
}

async function waitForServerHealth(timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) {
        return true;
      }
    } catch {
    }

    await delay(650);
  }

  return false;
}

async function postServerControl(action) {
  const endpointCandidates = action === 'restart'
    ? ['/api/system/restart', '/api/server/restart']
    : ['/api/system/shutdown', '/api/server/shutdown'];

  let lastError = null;

  for (const endpoint of endpointCandidates) {
    try {
      return await request(endpoint, {
        method: 'POST',
        body: JSON.stringify({})
      });
    } catch (error) {
      lastError = error;
      const errorMessage = String(error?.message ?? '').toLowerCase();

      if (!errorMessage.includes('not found')) {
        throw error;
      }
    }
  }

  throw new Error('Commande serveur indisponible sur cette instance. Redémarrez l\'application locale pour charger la dernière version.');
}

async function handleServerShutdown() {
  if (serverControlInProgress) {
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'Arrêter le serveur local',
    message: 'Le poste ne sera plus accessible aux tablettes et au présentateur. Voulez-vous vraiment arrêter le serveur ?',
    confirmLabel: 'Quitter serveur',
    cancelLabel: 'Annuler'
  });

  if (!confirmed) {
    return;
  }

  serverControlInProgress = true;
  setServerControlButtonsDisabled(true);

  try {
    await postServerControl('shutdown');

    showToast('Serveur arrêté. Vous pouvez fermer cette fenêtre.', 'success');
  } catch (error) {
    if (isFetchNetworkFailure(error)) {
      // Le serveur peut se fermer avant la fin de la réponse HTTP.
      await delay(350);
      const stillReachable = await waitForServerHealth(2200);

      if (!stillReachable) {
        showToast('Serveur arrêté. Vous pouvez fermer cette fenêtre.', 'success');
        return;
      }
    }

    showToast(error.message, 'error');
    serverControlInProgress = false;
    setServerControlButtonsDisabled(false);
  }
}

async function handleServerRestart() {
  if (serverControlInProgress) {
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'Relancer le serveur local',
    message: 'Le serveur va redémarrer et les tablettes perdront momentanément la connexion. Continuer ?',
    confirmLabel: 'Relancer',
    cancelLabel: 'Annuler'
  });

  if (!confirmed) {
    return;
  }

  serverControlInProgress = true;
  setServerControlButtonsDisabled(true);

  try {
    await postServerControl('restart');
    showToast('Relance en cours...', 'success');

    const healthRecovered = await waitForServerHealth();

    if (!healthRecovered) {
      throw new Error('Le serveur ne répond pas après relance. Vérifiez le raccourci de lancement.');
    }

    await refresh();
    showToast('Serveur relancé avec succès.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    serverControlInProgress = false;
    setServerControlButtonsDisabled(false);
  }
}

async function handlePresenterResultsPublish() {
  if (serverControlInProgress) {
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'Envoyer les résultats au présentateur',
    message: 'Le bouton Résultats deviendra disponible sur la tablette présentateur pour la compétition active. Continuer ?',
    confirmLabel: 'Envoyer',
    cancelLabel: 'Annuler'
  });

  if (!confirmed) {
    return;
  }

  serverControlInProgress = true;
  setServerControlButtonsDisabled(true);

  try {
    await request('/api/presenter/results/enable', {
      method: 'POST',
      body: JSON.stringify({})
    });
    presenterResultsPublished = true;
    syncPresenterResultsServerControlButton();
    showToast('Résultats envoyés au présentateur.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    serverControlInProgress = false;
    setServerControlButtonsDisabled(false);
  }
}

async function handlePresenterResultsRevert() {
  if (serverControlInProgress) {
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'Annuler l\'envoi des résultats',
    message: 'Le bouton Résultats sera masqué sur la tablette présentateur. Confirmer l\'annulation ?',
    confirmLabel: 'Annuler l\'envoi',
    cancelLabel: 'Retour'
  });

  if (!confirmed) {
    return;
  }

  serverControlInProgress = true;
  setServerControlButtonsDisabled(true);

  try {
    await request('/api/presenter/results/disable', {
      method: 'POST',
      body: JSON.stringify({})
    });
    presenterResultsPublished = false;
    syncPresenterResultsServerControlButton();
    showToast('Envoi des résultats annulé.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    serverControlInProgress = false;
    setServerControlButtonsDisabled(false);
  }
}

async function handlePresenterResultsToggle() {
  if (presenterResultsPublished) {
    await handlePresenterResultsRevert();
    return;
  }

  await handlePresenterResultsPublish();
}

document.querySelector('#app-confirm-dialog')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    hideConfirmDialog(false);
  }
});

document.querySelector('#app-confirm-dialog-cancel')?.addEventListener('click', () => {
  hideConfirmDialog(false);
});

document.querySelector('#app-confirm-dialog-confirm')?.addEventListener('click', () => {
  hideConfirmDialog(true);
});

document.querySelector('#app-input-dialog')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    hideInputDialog(null);
  }
});

document.querySelector('#app-input-dialog-cancel')?.addEventListener('click', () => {
  hideInputDialog(null);
});

document.querySelector('#app-input-dialog-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const inputElement = document.querySelector('#app-input-dialog-value');
  hideInputDialog(inputElement?.value ?? '');
});

document.querySelector('#app-access-dialog')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    hideAccessAuthDialog(null);
  }
});

document.querySelector('#app-access-dialog-cancel')?.addEventListener('click', () => {
  hideAccessAuthDialog(null);
});

document.querySelector('#app-access-dialog-forgot')?.addEventListener('click', async () => {
  const recoverySession = await openAccessRecoveryDialog();

  if (!recoverySession?.account) {
    return;
  }

  saveAccessSession(recoverySession);
  hideAccessAuthDialog(recoverySession);
});

document.querySelector('#app-access-dialog-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const login = document.querySelector('#app-access-dialog-login')?.value ?? '';
  const password = document.querySelector('#app-access-dialog-password')?.value ?? '';
  const firstName = document.querySelector('#app-access-dialog-first-name')?.value ?? '';
  const lastName = document.querySelector('#app-access-dialog-last-name')?.value ?? '';

  try {
    const session = accessDialogMode === 'bootstrap'
      ? await request('/api/access/bootstrap-super-admin', {
        method: 'POST',
        body: JSON.stringify({ firstName, lastName, login, password })
      })
      : await request('/api/access/login', {
        method: 'POST',
        body: JSON.stringify({ login, password })
      });

    saveAccessSession(session);
    hideAccessAuthDialog(session);
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#app-access-recovery-dialog')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    hideAccessRecoveryDialog(null);
  }
});

document.querySelector('#app-access-recovery-cancel')?.addEventListener('click', () => {
  hideAccessRecoveryDialog(null);
});

document.querySelector('#app-access-recovery-dialog-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const login = document.querySelector('#app-access-recovery-login')?.value ?? '';
  const code = document.querySelector('#app-access-recovery-code')?.value ?? '';

  try {
    const session = await request('/api/access/recovery/login-with-code', {
      method: 'POST',
      body: JSON.stringify({ login, code })
    });

    hideAccessRecoveryDialog(session);
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#app-access-force-password-dialog-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const password = document.querySelector('#app-access-force-password')?.value ?? '';
  const passwordConfirm = document.querySelector('#app-access-force-password-confirm')?.value ?? '';

  if (!password.trim()) {
    showToast('Le nouveau mot de passe est obligatoire.', 'error');
    return;
  }

  if (password !== passwordConfirm) {
    showToast('La confirmation du mot de passe ne correspond pas.', 'error');
    return;
  }

  try {
    await request('/api/access/change-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword: password })
    });

    await refreshAccessState();
    hideForcePasswordDialog(true);
    showToast('Mot de passe mis à jour.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#app-access-force-password-toggle')?.addEventListener('click', () => {
  const passwordInput = document.querySelector('#app-access-force-password');
  const toggleButton = document.querySelector('#app-access-force-password-toggle');

  if (!(passwordInput instanceof HTMLInputElement) || !(toggleButton instanceof HTMLButtonElement)) {
    return;
  }

  const shouldReveal = passwordInput.type === 'password';
  passwordInput.type = shouldReveal ? 'text' : 'password';
  toggleButton.textContent = shouldReveal ? 'Masquer' : 'Afficher';
  toggleButton.setAttribute('aria-label', shouldReveal ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
});

document.querySelector('#app-judge-edit-dialog')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    hideJudgeEditDialog();
  }
});

document.querySelector('#app-judge-edit-dialog-cancel')?.addEventListener('click', () => {
  hideJudgeEditDialog();
});

document.querySelector('#app-judge-edit-dialog-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const judgeId = document.querySelector('#app-judge-edit-dialog-id')?.value ?? '';
  const firstName = document.querySelector('#app-judge-edit-first-name')?.value ?? '';
  const lastName = document.querySelector('#app-judge-edit-last-name')?.value ?? '';
  const login = document.querySelector('#app-judge-edit-login')?.value ?? '';
  const password = document.querySelector('#app-judge-edit-password')?.value ?? '';

  if (!judgeId) {
    showToast('Juge introuvable.', 'error');
    return;
  }

  try {
    await request(`/api/judges/${judgeId}`, {
      method: 'PUT',
      body: JSON.stringify({ firstName, lastName, login, password })
    });
    hideJudgeEditDialog();
    await refresh();
    showToast('Juge mis à jour.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

window.addEventListener('pagehide', () => {
  logoutAccessSession({ keepSession: true });
});

window.addEventListener('beforeunload', () => {
  logoutAccessSession({ keepSession: true });
});

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(parsedDate);
}

function setCompetitionMode(mode) {
  const previousMode = activeCompetitionMode;
  activeCompetitionMode = competitionModes.has(mode) ? mode : 'create';

  if (previousMode !== activeCompetitionMode) {
    resetCompetitionEditState();
  }

  if (isCompetitionDirectoryVisible) {
    setCompetitionDirectoryVisibility(false);
  }

  document.querySelectorAll('[data-competition-mode]').forEach((button) => {
    const isActive = button.dataset.competitionMode === activeCompetitionMode;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  document.querySelectorAll('[data-competition-panel]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.competitionPanel === activeCompetitionMode);
  });

  if (activeCompetitionMode === 'create' && (previousMode !== 'create' || isCompetitionDirectoryVisible)) {
    resetCompetitionWizard();
  }
}

function setCompetitionDirectoryVisibility(visible) {
  const nextVisibility = Boolean(visible);
  const wasDirectoryVisible = isCompetitionDirectoryVisible;

  isCompetitionDirectoryVisible = nextVisibility;

  const directory = document.querySelector('[data-competition-directory]');
  const toggle = document.querySelector('[data-competition-directory-toggle]');
  const panels = document.querySelector('.competition-panels');

  document.querySelectorAll('[data-competition-mode]').forEach((button) => {
    const isActive = !isCompetitionDirectoryVisible && button.dataset.competitionMode === activeCompetitionMode;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  if (panels) {
    panels.hidden = isCompetitionDirectoryVisible;
  }

  if (directory) {
    directory.hidden = !isCompetitionDirectoryVisible;
  }

  if (toggle) {
    toggle.classList.toggle('is-active', isCompetitionDirectoryVisible);
    toggle.setAttribute('aria-pressed', isCompetitionDirectoryVisible ? 'true' : 'false');
  }

  // When the user switches to the directory list, clear edit/delete selections and form fields.
  if (isCompetitionDirectoryVisible && !wasDirectoryVisible) {
    resetCompetitionEditState();
  }
}

function getCompetitionWizardCompetition() {
  return competitionsState.find((competition) => competition.id === competitionWizardState.competitionId) ?? null;
}

function setCompetitionWizardStep(step) {
  competitionWizardState.step = competitionCreateSteps.includes(step) ? step : 'general';
  renderCompetitionWizard();
}

function getNextCompetitionWizardStep(step) {
  const currentIndex = competitionCreateSteps.indexOf(step);
  return competitionCreateSteps[Math.min(currentIndex + 1, competitionCreateSteps.length - 1)] ?? 'competitors';
}

function getPreviousCompetitionWizardStep(step) {
  const currentIndex = competitionCreateSteps.indexOf(step);
  return competitionCreateSteps[Math.max(currentIndex - 1, 0)] ?? 'general';
}

function renderCompetitionWizardSummary() {
  const root = document.querySelector('#competition-wizard-summary');
  const competition = getCompetitionWizardCompetition();

  if (!root) {
    return;
  }

  if (!competition) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }

  if (competitionWizardState.step === 'general') {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }

  if (competitionWizardState.step === 'judges') {
    root.hidden = false;
    root.innerHTML = `
      <p class="competition-wizard-summary-line">
        ${escapeHtml(formatFrenchDate(competition.eventDate))}
        <span>•</span>
        <strong>${escapeHtml(competition.name)}</strong>
        <span>•</span>
        ${escapeHtml(competition.location || 'Lieu non défini')}
      </p>
    `;
    return;
  }

  root.hidden = false;
  root.innerHTML = `
    <div>
      <strong>${escapeHtml(competition.name)}</strong>
      <p>${escapeHtml(formatSeasonLabel(competition.season, competition.eventDate))}</p>
    </div>
    <div class="competition-wizard-summary-meta">
      <span>${escapeHtml(formatFrenchDate(competition.eventDate))}</span>
      <span>${escapeHtml(competition.location || 'Lieu non défini')}</span>
      <span>${escapeHtml(formatCompetitionLevelLabel(competition.competitionLevel))}</span>
      ${formatCompetitionTerritoryLabel(competition) ? `<span>${escapeHtml(formatCompetitionTerritoryLabel(competition))}</span>` : ''}
      <span>${escapeHtml(formatCompetitionJudgeCountLabel(competition.judgeCount))}</span>
      <span>${getCompetitionWizardAssignedJudgeCount()} juge(s) affecté(s)</span>
      <span>${competitionWizardState.competitors.length} compétiteur(s)</span>
    </div>
  `;
}

function formatJudgeDisplayName(judge) {
  const fullName = [judge.firstName, judge.lastName].map((value) => String(value ?? '').trim()).filter(Boolean).join(' ');
  return fullName || judge.name || 'Juge sans nom';
}

function getCompetitionWizardAssignedJudgeCount() {
  return competitionWizardState.assignments.filter((assignment) => assignment.judgeId).length;
}

function getCompetitionWizardCompletedAssignmentCount() {
  return competitionWizardState.assignments.filter((assignment) => assignment.judgeId && assignment.judgeRole).length;
}

function getCompetitionWizardTraineeCount() {
  return competitionWizardState.assignments.filter((assignment) => assignment.judgeId && assignment.isTrainee).length;
}

function formatJudgeAssignmentRowLabel(slotIndex) {
  return String.fromCharCode(64 + Math.max(1, Math.min(26, slotIndex)));
}

function getJudgeSortKey(judge) {
  return formatJudgeDirectoryLabel(judge).toLocaleLowerCase('fr');
}

function isJudgeActive(judge) {
  return judge?.isActive === true || judge?.isActive === 1;
}

function getSortedJudges() {
  return [...judgesState].sort((left, right) => getJudgeSortKey(left).localeCompare(getJudgeSortKey(right), 'fr'));
}

function getSortedActiveJudges() {
  return getSortedJudges().filter((judge) => isJudgeActive(judge));
}

function buildJudgeAssignmentRoleOptions(selectedValue = '') {
  return judgeAssignmentRoleOptions.map((option) => `
    <option value="${option.value}" ${option.value === selectedValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>
  `).join('');
}

function buildJudgeAssignmentJudgeOptions(assignments, currentAssignment) {
  const usedJudgeIds = new Set(
    assignments
      .filter((assignment) => assignment.slotIndex !== currentAssignment.slotIndex && assignment.judgeId)
      .map((assignment) => assignment.judgeId)
  );

  const availableJudges = getSortedActiveJudges().filter((judge) => !usedJudgeIds.has(judge.id));
  const placeholder = availableJudges.length === 0 ? 'Aucun juge disponible' : 'Choisir juge';

  return `
    <option value="">${escapeHtml(placeholder)}</option>
    ${availableJudges.map((judge) => `
      <option value="${judge.id}" ${judge.id === currentAssignment.judgeId ? 'selected' : ''}>${escapeHtml(formatJudgeDirectoryLabel(judge))}</option>
    `).join('')}
  `;
}

function renderCompetitionWizardJudges() {
  const root = document.querySelector('#competition-wizard-judges');
  const competition = getCompetitionWizardCompetition();

  if (!root) {
    return;
  }

  if (!competitionWizardState.competitionId) {
    root.innerHTML = '<p class="empty-state">Enregistrez d\'abord les informations générales.</p>';
    return;
  }

  if (!competition) {
    root.innerHTML = '<p class="empty-state">Compétition introuvable.</p>';
    return;
  }

  const plannedJudgeCount = normalizeCompetitionJudgeCountValue(competition.judgeCount);
  const assignedJudgeCount = getCompetitionWizardAssignedJudgeCount();
  const completedAssignmentCount = getCompetitionWizardCompletedAssignmentCount();
  const traineeCount = getCompetitionWizardTraineeCount();
  const hasNoJudges = getSortedActiveJudges().length === 0;

  const assignmentRows = competitionWizardState.assignments.map((assignment) => {
      return `
        <div class="competition-judge-assignment-row" role="row">
          <div class="competition-judge-assignment-badge" aria-hidden="true">${formatJudgeAssignmentRowLabel(assignment.slotIndex)}</div>
          <label class="field-row field-row-condensed competition-judge-assignment-field" role="cell">
            <select data-assignment-slot="${assignment.slotIndex}" data-assignment-field="judgeRole">
              ${buildJudgeAssignmentRoleOptions(assignment.judgeRole)}
            </select>
          </label>
          <label class="field-row field-row-condensed competition-judge-assignment-field" role="cell">
            <select data-assignment-slot="${assignment.slotIndex}" data-assignment-field="judgeId">
              ${buildJudgeAssignmentJudgeOptions(competitionWizardState.assignments, assignment)}
            </select>
          </label>
          <label class="competition-judge-shadow-cell" role="cell" aria-label="Shadow">
            <input type="checkbox" data-assignment-slot="${assignment.slotIndex}" data-assignment-field="isTrainee" ${assignment.isTrainee ? 'checked' : ''}>
          </label>
        </div>
      `;
    })
    .join('');

  root.innerHTML = `
    <section class="mini-card competition-judge-selection-card">
      <div class="competition-judge-selection-head">
        <div>
          <strong>Attribution des juges</strong>
          <p>Renseignez exactement ${plannedJudgeCount} ligne${plannedJudgeCount > 1 ? 's' : ''} avec un rôle et un juge, dans l'ordre qui vous convient.</p>
        </div>
        <div class="competition-judge-counter">
          <strong>${completedAssignmentCount}/${plannedJudgeCount}</strong>
          <span>lignes complètes</span>
        </div>
      </div>

      <div class="competition-judge-selection-meta">
        <span>${assignedJudgeCount} juge${assignedJudgeCount > 1 ? 's' : ''} sélectionné${assignedJudgeCount > 1 ? 's' : ''}</span>
        <span>${plannedJudgeCount - assignedJudgeCount} ligne${plannedJudgeCount - assignedJudgeCount > 1 ? 's' : ''} sans juge</span>
        <span>${traineeCount} stagiaire${traineeCount > 1 ? 's' : ''}</span>
      </div>

      ${hasNoJudges
        ? '<p class="empty-state">La base des juges est vide pour le moment.</p>'
        : `
          <div class="competition-judge-assignment-table" role="table" aria-label="Affectation des juges">
            <div class="competition-judge-assignment-row competition-judge-assignment-head" role="row">
              <span role="presentation"></span>
              <span role="columnheader">Rôle</span>
              <span role="columnheader">Juge</span>
              <span role="columnheader">Shadow</span>
            </div>
            ${assignmentRows}
          </div>
        `}
    </section>
  `;
}

function getCompetitionEditAssignedJudgeCount() {
  return competitionEditState.assignments.filter((assignment) => assignment.judgeId).length;
}

function getCompetitionEditCompletedAssignmentCount() {
  return competitionEditState.assignments.filter((assignment) => assignment.judgeId && assignment.judgeRole).length;
}

function getCompetitionEditTraineeCount() {
  return competitionEditState.assignments.filter((assignment) => assignment.judgeId && assignment.isTrainee).length;
}

function getDefaultJudgeRoleForSlot(slotIndex) {
  if (slotIndex === 1) {
    return 'head';
  }

  if (slotIndex === 2) {
    return 'artistique';
  }

  if (slotIndex === 3) {
    return 'technique';
  }

  return '';
}

function renderCompetitionEditJudges() {
  const root = document.querySelector('#competition-edit-judges');
  const competition = competitionsState.find((item) => item.id === competitionEditState.competitionId);

  if (!root) {
    return;
  }

  if (!competitionEditState.competitionId || !competition) {
    root.innerHTML = '<p class="empty-state">Sélectionnez d\'abord une compétition à modifier.</p>';
    return;
  }

  if (!competitionEditState.assignments.length) {
    root.innerHTML = '<p class="empty-state">Chargement des affectations...</p>';
    return;
  }

  const plannedJudgeCount = normalizeCompetitionJudgeCountValue(competition.judgeCount);
  const assignedJudgeCount = getCompetitionEditAssignedJudgeCount();
  const completedAssignmentCount = getCompetitionEditCompletedAssignmentCount();
  const traineeCount = getCompetitionEditTraineeCount();
  const hasNoJudges = getSortedActiveJudges().length === 0;

  const assignmentRows = competitionEditState.assignments
    .map((assignment) => {
      return `
        <div class="competition-judge-assignment-row" role="row">
          <div class="competition-judge-assignment-badge" aria-hidden="true">${formatJudgeAssignmentRowLabel(assignment.slotIndex)}</div>
          <label class="field-row field-row-condensed competition-judge-assignment-field" role="cell">
            <select data-edit-assignment-slot="${assignment.slotIndex}" data-edit-assignment-field="judgeRole">
              ${buildJudgeAssignmentRoleOptions(assignment.judgeRole)}
            </select>
          </label>
          <label class="field-row field-row-condensed competition-judge-assignment-field" role="cell">
            <select data-edit-assignment-slot="${assignment.slotIndex}" data-edit-assignment-field="judgeId">
              ${buildJudgeAssignmentJudgeOptions(competitionEditState.assignments, assignment)}
            </select>
          </label>
          <label class="competition-judge-shadow-cell" role="cell" aria-label="Shadow">
            <input type="checkbox" data-edit-assignment-slot="${assignment.slotIndex}" data-edit-assignment-field="isTrainee" ${assignment.isTrainee ? 'checked' : ''}>
          </label>
        </div>
      `;
    })
    .join('');

  root.innerHTML = `
    <div class="competition-judge-selection-meta">
      <span>${assignedJudgeCount} juge${assignedJudgeCount > 1 ? 's' : ''} sélectionné${assignedJudgeCount > 1 ? 's' : ''}</span>
      <span>${plannedJudgeCount - assignedJudgeCount} ligne${plannedJudgeCount - assignedJudgeCount > 1 ? 's' : ''} sans juge</span>
      <span>${traineeCount} stagiaire${traineeCount > 1 ? 's' : ''}</span>
      <span>${completedAssignmentCount}/${plannedJudgeCount} ligne${plannedJudgeCount > 1 ? 's' : ''} complète${plannedJudgeCount > 1 ? 's' : ''}</span>
    </div>

    ${hasNoJudges
      ? '<p class="empty-state">La base des juges est vide pour le moment.</p>'
      : `
        <div class="competition-judge-assignment-table" role="table" aria-label="Affectation des juges en modification">
          <div class="competition-judge-assignment-row competition-judge-assignment-head" role="row">
            <span role="presentation"></span>
            <span role="columnheader">Rôle</span>
            <span role="columnheader">Juge</span>
            <span role="columnheader">Shadow</span>
          </div>
          ${assignmentRows}
        </div>
      `}

    <div class="competition-judge-assignment-actions">
      <button type="button" id="competition-edit-add-judge-slot" class="ghost-button" ${plannedJudgeCount >= 20 ? 'disabled' : ''}>+ Ajouter un juge</button>
    </div>
  `;
}

async function hydrateCompetitionEditAssignments(competitionId) {
  const normalizedCompetitionId = String(competitionId ?? '').trim();

  if (!normalizedCompetitionId) {
    competitionEditState.competitionId = '';
    competitionEditState.assignments = [];
    renderCompetitionEditJudges();
    return;
  }

  competitionEditState.competitionId = normalizedCompetitionId;
  competitionEditState.assignments = [];
  renderCompetitionEditJudges();

  try {
    let assignments = await request(`/api/competitions/${normalizedCompetitionId}/judge-assignments`);

    const missingRoleAssignments = assignments.filter((assignment) => {
      return assignment.judgeId && !assignment.judgeRole && getDefaultJudgeRoleForSlot(assignment.slotIndex);
    });

    if (missingRoleAssignments.length > 0) {
      for (const assignment of missingRoleAssignments) {
        assignments = await request(`/api/competitions/${normalizedCompetitionId}/judge-assignments`, {
          method: 'POST',
          body: JSON.stringify({
            slotIndex: assignment.slotIndex,
            judgeId: assignment.judgeId,
            judgeRole: getDefaultJudgeRoleForSlot(assignment.slotIndex),
            isTrainee: Boolean(assignment.isTrainee)
          })
        });
      }

      showToast('Rôles manquants restaurés automatiquement.', 'success');
    }

    if (competitionEditState.competitionId !== normalizedCompetitionId) {
      return;
    }

    competitionEditState.assignments = assignments;
    renderCompetitionEditJudges();
  } catch (error) {
    if (competitionEditState.competitionId !== normalizedCompetitionId) {
      return;
    }

    competitionEditState.assignments = [];
    const root = document.querySelector('#competition-edit-judges');

    if (root) {
      root.innerHTML = `<p class="empty-state">${escapeHtml(error.message || 'Erreur de chargement des affectations')}</p>`;
    }
  }
}

async function addCompetitionEditJudgeSlot() {
  const competitionId = competitionEditState.competitionId;
  const competition = competitionsState.find((item) => item.id === competitionId);

  if (!competitionId || !competition) {
    return;
  }

  const currentJudgeCount = normalizeCompetitionJudgeCountValue(competition.judgeCount);

  if (currentJudgeCount >= 20) {
    showToast('Nombre maximum de juges atteint (20).', 'error');
    return;
  }

  const formElement = document.querySelector('#competition-edit-form');
  const payload = Object.fromEntries(new FormData(formElement).entries());
  payload.judgeCount = String(currentJudgeCount + 1);

  try {
    await request(`/api/competitions/${competitionId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    await refresh();
    fillCompetitionEditForm(competitionId);
    showToast('Ligne de juge ajoutée.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderCompetitionWizardCompetitors() {
  const root = document.querySelector('#competition-wizard-competitors');

  if (!root) {
    return;
  }

  if (!competitionWizardState.competitionId) {
    root.innerHTML = '<p class="empty-state">Enregistrez d\'abord les informations générales.</p>';
    return;
  }

  root.innerHTML = competitionWizardState.competitors.length === 0
    ? '<p class="empty-state">Aucun compétiteur ajouté pour le moment.</p>'
    : `
      <div class="competitor-table" role="table" aria-label="Compétiteurs ajoutés">
        <div class="competitor-table-row competitor-table-head" role="row">
          <span role="columnheader">Statut</span>
          <span role="columnheader">Ordre</span>
          <span role="columnheader">Catégorie</span>
          <span role="columnheader">Athlète</span>
          <span role="columnheader">Actions</span>
        </div>
        ${competitionWizardState.competitors.map((competitor) => {
          const status = getCompetitorStatusMeta(competitor.status);
          const athleteLabel = formatCompetitorAthleteLabel(competitor);
          const withdrawalLabel = competitor.status === 'withdrawn' ? 'Réactiver' : 'Désistement';
          const forfeitLabel = competitor.status === 'forfeit' ? 'Réactiver' : 'Forfait';

          return `
            <div class="competitor-table-row is-${status.modifier}" role="row">
              <span role="cell"><span class="competitor-status-badge is-${status.modifier}">${escapeHtml(status.label)}</span></span>
              <span role="cell">${escapeHtml(String(competitor.runningOrder))}</span>
              <span role="cell">${escapeHtml(competitor.category || '-')}</span>
              <span role="cell">${escapeHtml(athleteLabel)}</span>
              <span role="cell">
                <div class="competitor-row-actions">
                  <button type="button" class="ghost-button competitor-status-button" disabled>${escapeHtml(withdrawalLabel)}</button>
                  <button type="button" class="ghost-button competitor-status-button" disabled>${escapeHtml(forfeitLabel)}</button>
                </div>
              </span>
            </div>
          `;
        }).join('')}
      </div>
    `;
}

function renderCompetitionWizard() {
  renderCompetitionWizardSummary();
  renderCompetitionWizardJudges();
  renderCompetitionCompetitorImportPanel();
  renderCompetitionWizardCompetitors();

  document.querySelectorAll('[data-create-step-target]').forEach((button) => {
    const targetStep = button.dataset.createStepTarget;
    const isActive = targetStep === competitionWizardState.step;
    const requiresCompetition = targetStep !== 'general';

    button.classList.toggle('is-active', isActive);
    button.disabled = requiresCompetition && !competitionWizardState.competitionId;
  });

  document.querySelectorAll('[data-create-step]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.createStep === competitionWizardState.step);
  });

  document.querySelectorAll('[data-create-nav="next"]').forEach((button) => {
    button.disabled = !competitionWizardState.competitionId;
  });

  document.querySelectorAll('[data-create-nav="prev"]').forEach((button) => {
    button.disabled = competitionWizardState.step === 'general';
  });
}

async function hydrateCompetitionWizardData() {
  if (!competitionWizardState.competitionId) {
    competitionWizardState.assignments = [];
    competitionWizardState.competitors = [];
    renderCompetitionWizard();
    return;
  }

  const [assignments, competitors] = await Promise.all([
    request(`/api/competitions/${competitionWizardState.competitionId}/judge-assignments`),
    request(`/api/competitions/${competitionWizardState.competitionId}/competitors`)
  ]);

  competitionWizardState.assignments = assignments;
  competitionWizardState.competitors = competitors;
  renderCompetitionWizard();
}

function resetCompetitionWizard() {
  const generalForm = document.querySelector('#competition-form');
  const competitorForm = document.querySelector('#competition-wizard-competitor-form');
  const competitorImportFile = document.querySelector('#competition-competitor-import-file');

  competitionWizardState = createCompetitionWizardState();
  generalForm?.reset();
  competitorForm?.reset();
  if (competitorImportFile) {
    competitorImportFile.value = '';
  }
  setSeasonSelectOptions(document.querySelector('#competition-season'), getCurrentSeasonValue());
  setCompetitionJudgeCountOptions(document.querySelector('#competition-judge-count'), 3);
  setCompetitionLevelOptions(document.querySelector('#competition-level'), '', { allowEmpty: true });
  updateCompetitionRegionalFields('create');
  renderCompetitionWizard();
}

function resetCompetitionEditState(options = {}) {
  const { focusEditSelect = false } = options;
  const editSelect = document.querySelector('#competition-edit-select');
  const deleteSelect = document.querySelector('#competition-delete-select');
  const editForm = document.querySelector('#competition-edit-form');

  competitionEditState = createCompetitionEditState();

  editForm?.reset();

  if (editSelect) {
    editSelect.value = '';
  }

  if (deleteSelect) {
    deleteSelect.value = '';
  }

  fillCompetitionEditForm('');
  renderCompetitionDeleteSummary('');

  if (focusEditSelect && editSelect) {
    window.requestAnimationFrame(() => {
      editSelect.focus();
    });
  }
}

function setCompetitionSelectOptions(select, competitions, emptyLabel, preferredValue = '') {
  if (!select) {
    return '';
  }

  if (competitions.length === 0) {
    select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>`;
    select.value = '';
    return '';
  }

  const selectedValue = competitions.some((competition) => competition.id === preferredValue)
    ? preferredValue
    : '';

  select.innerHTML = `
    <option value="" selected>${escapeHtml(emptyLabel)}</option>
    ${competitions.map(competitionDirectoryOption).join('')}
  `;
  select.value = selectedValue;
  return selectedValue;
}

function fillCompetitionEditForm(competitionId) {
  const competition = competitionsState.find((item) => item.id === competitionId);
  const editForm = document.querySelector('#competition-edit-form');
  const nameInput = document.querySelector('#competition-edit-name');
  const locationInput = document.querySelector('#competition-edit-location');
  const dateInput = document.querySelector('#competition-edit-date');
  const seasonSelect = document.querySelector('#competition-edit-season');
  const judgeCountSelect = document.querySelector('#competition-edit-judge-count');
  const levelSelect = document.querySelector('#competition-edit-level');
  const statusSelect = document.querySelector('#competition-edit-status');
  const submitButton = document.querySelector('#competition-edit-form button[type="submit"]');
  const emptyEditLabel = 'Sélectionnez d\'abord une compétition dans la liste';

  const setEditFieldsDisabled = (disabled) => {
    editForm?.querySelectorAll('input, select').forEach((field) => {
      if (field.id === 'competition-edit-select') {
        return;
      }

      field.disabled = disabled;
    });
  };

  if (!competition) {
    setEditFieldsDisabled(true);
    nameInput.value = '';
    nameInput.placeholder = emptyEditLabel;
    locationInput.value = '';
    locationInput.placeholder = emptyEditLabel;
    dateInput.value = '';
    setSingleOptionSelect(seasonSelect, emptyEditLabel);
    setSingleOptionSelect(judgeCountSelect, emptyEditLabel);
    setCompetitionLevelOptions(levelSelect, '', { allowEmpty: true });
    levelSelect.querySelector('option[value=""]').textContent = emptyEditLabel;
    updateCompetitionRegionalFields('edit');
    setCompetitionStatusOptions(statusSelect, '', { allowEmpty: true });
    statusSelect.querySelector('option[value=""]').textContent = emptyEditLabel;
    submitButton.disabled = true;
    hydrateCompetitionEditAssignments('');
    return;
  }

  setEditFieldsDisabled(false);
  nameInput.value = competition.name ?? '';
  nameInput.placeholder = 'Ex. Championnat régional 2026';
  locationInput.value = competition.location ?? '';
  locationInput.placeholder = 'Ex. Palais des sports de Lyon';
  dateInput.value = competition.eventDate ?? '';
  setSeasonSelectOptions(seasonSelect, competition.season ?? getCurrentSeasonValue());
  setCompetitionJudgeCountOptions(judgeCountSelect, competition.judgeCount ?? 3);
  setCompetitionLevelOptions(levelSelect, competition.competitionLevel ?? 'defi');
  updateCompetitionRegionalFields('edit', competition.region ?? '');
  setCompetitionStatusOptions(statusSelect, competition.status ?? 'draft');
  submitButton.disabled = false;
  hydrateCompetitionEditAssignments(competition.id);
}

function renderCompetitionDeleteSummary(competitionId) {
  const summary = document.querySelector('#competition-delete-summary');
  const submitButton = document.querySelector('#competition-delete-form button[type="submit"]');
  const passwordRow = document.querySelector('#competition-delete-password-row');
  const passwordInput = document.querySelector('#competition-delete-password');
  const competition = competitionsState.find((item) => item.id === competitionId);
  const isPasswordRequired = Boolean(competition?.hasDeletionPassword);

  if (passwordRow) {
    passwordRow.hidden = !isPasswordRequired;
  }

  if (!isPasswordRequired && passwordInput) {
    passwordInput.value = '';
  }

  if (!competition) {
    summary.innerHTML = '';
    summary.hidden = true;
    submitButton.disabled = true;
    return;
  }

  summary.hidden = false;
  summary.innerHTML = `
    <strong>${escapeHtml(competition.name)}</strong>
    <p>${escapeHtml(formatSeasonLabel(competition.season, competition.eventDate))}</p>
    <p>${escapeHtml(formatCompetitionLevelLabel(competition.competitionLevel))}${formatCompetitionTerritoryLabel(competition) ? ` · ${escapeHtml(formatCompetitionTerritoryLabel(competition))}` : ''}</p>
    <p>${escapeHtml(formatCompetitionJudgeCountLabel(competition.judgeCount))}</p>
    <p>${isPasswordRequired ? 'Suppression protégée par mot de passe' : 'Aucun mot de passe de suppression défini'}</p>
    <p>Date: ${escapeHtml(formatFrenchDate(competition.eventDate))}</p>
    <p>Lieu: ${escapeHtml(competition.location || 'Non défini')}</p>
  `;
  submitButton.disabled = false;
}

function refreshCompetitionManagementControls() {
  const editSelect = document.querySelector('#competition-edit-select');
  const deleteSelect = document.querySelector('#competition-delete-select');
  const createSeasonSelect = document.querySelector('#competition-season');
  const createJudgeCountSelect = document.querySelector('#competition-judge-count');
  const createLevelSelect = document.querySelector('#competition-level');
  const filterSelect = document.querySelector('#competition-season-filter');

  setSeasonSelectOptions(createSeasonSelect, createSeasonSelect?.value || getCurrentSeasonValue());
  setCompetitionJudgeCountOptions(createJudgeCountSelect, createJudgeCountSelect?.value || 3);
  setCompetitionLevelOptions(createLevelSelect, createLevelSelect?.value || '', { allowEmpty: true });
  updateCompetitionRegionalFields('create');
  activeCompetitionSeasonFilter = setSeasonSelectOptions(filterSelect, activeCompetitionSeasonFilter, { includeAll: true });
  const filteredCompetitions = getFilteredCompetitions();

  const selectedEditId = setCompetitionSelectOptions(
    editSelect,
    filteredCompetitions,
    filteredCompetitions.length === 0 ? 'Aucune compétition à modifier' : 'Sélectionnez une compétition à modifier',
    editSelect?.value ?? ''
  );
  const selectedDeleteId = setCompetitionSelectOptions(
    deleteSelect,
    filteredCompetitions,
    filteredCompetitions.length === 0 ? 'Aucune compétition à supprimer' : 'Sélectionnez une compétition à supprimer',
    deleteSelect?.value ?? ''
  );

  fillCompetitionEditForm(selectedEditId);
  renderCompetitionDeleteSummary(selectedDeleteId);
  renderCompetitionWizard();
  setCompetitionDirectoryVisibility(isCompetitionDirectoryVisible);
}

function renderActiveCompetitionInfo(data) {
  const root = document.querySelector('#active-competition-info');
  const dashboard = data.dashboard ?? { activeCompetition: null };

  if (!dashboard.activeCompetition) {
    root.innerHTML = '';
    return;
  }

  const competition = dashboard.activeCompetition;
  const competitionLevel = formatCompetitionLevelLabel(competition.competitionLevel);
  const territory = formatCompetitionTerritoryLabel(competition);
  const levelLabel = [competitionLevel, territory].filter(Boolean).join(' · ');

  root.innerHTML = `
    <div class="active-competition-stack">
      <div>
        <h4>${escapeHtml(competition.name)}</h4>
        ${levelLabel ? `<p class="competition-season-text">${escapeHtml(levelLabel)}</p>` : ''}
      </div>
      <div class="active-competition-details">
        <p><strong>Lieu</strong><span>${escapeHtml(competition.location || 'Non défini')}</span></p>
        <p><strong>Date</strong><span>${escapeHtml(formatFrenchDate(competition.eventDate))}</span></p>
      </div>
    </div>
  `;
}

function renderStatisticsSection() {
  const individualStatsButton = document.querySelector('#statistics-open-individual');
  const titleNode = document.querySelector('#statistics-active-competition');
  const hintNode = document.querySelector('#statistics-active-hint');
  const rankingButton = document.querySelector('#statistics-open-ranking');
  const podiumButton = document.querySelector('#statistics-open-podium');
  const otherHintNode = document.querySelector('#statistics-other-hint');
  const otherSelect = document.querySelector('#statistics-other-competition-select');
  const otherRankingButton = document.querySelector('#statistics-other-open-ranking');
  const otherPodiumButton = document.querySelector('#statistics-other-open-podium');
  const activeCompetition = competitionsState.find((competition) => competition.status === 'active') ?? null;

  if (!individualStatsButton || !titleNode || !hintNode || !rankingButton || !podiumButton || !otherHintNode || !otherSelect || !otherRankingButton || !otherPodiumButton) {
    return;
  }

  if (!activeCompetition) {
    titleNode.textContent = 'Aucune compétition active';
    hintNode.textContent = 'Passez une compétition en statut Active pour ouvrir les résultats imprimables.';
    individualStatsButton.disabled = true;
    rankingButton.disabled = true;
    podiumButton.disabled = true;
  } else {
    titleNode.textContent = activeCompetition.name;
    hintNode.textContent = `${formatFrenchDate(activeCompetition.eventDate)} • ${activeCompetition.location || 'Lieu non défini'}`;
    individualStatsButton.disabled = false;
    rankingButton.disabled = false;
    podiumButton.disabled = false;
  }

  const orderedCompetitions = [...competitionsState].sort((left, right) => {
    const leftDate = String(left?.eventDate ?? '');
    const rightDate = String(right?.eventDate ?? '');

    if (leftDate !== rightDate) {
      return rightDate.localeCompare(leftDate);
    }

    return String(left?.name ?? '').localeCompare(String(right?.name ?? ''), 'fr');
  });

  const selectableCompetitions = orderedCompetitions.filter((competition) => competition.id !== activeCompetition?.id);

  if (!selectableCompetitions.length) {
    statisticsOtherCompetitionId = '';
    otherSelect.innerHTML = '<option value="" selected>Aucune autre compétition disponible</option>';
    otherHintNode.textContent = 'Ajoutez une autre compétition pour consulter ses résultats.';
    otherRankingButton.disabled = true;
    otherPodiumButton.disabled = true;
    return;
  }

  if (!selectableCompetitions.some((competition) => competition.id === statisticsOtherCompetitionId)) {
    statisticsOtherCompetitionId = '';
  }

  otherSelect.innerHTML = [
    `<option value=""${statisticsOtherCompetitionId ? '' : ' selected'}>Sélectionnez une compétition</option>`,
    ...selectableCompetitions.map((competition) => `
      <option value="${competition.id}"${competition.id === statisticsOtherCompetitionId ? ' selected' : ''}>${escapeHtml(competition.name)} • ${escapeHtml(formatFrenchDate(competition.eventDate))}</option>
    `)
  ].join('');

  const selectedCompetition = selectableCompetitions.find((competition) => competition.id === statisticsOtherCompetitionId) ?? null;

  otherHintNode.textContent = 'Choisissez une compétition pour ouvrir ses résultats dans une fenêtre séparée.';
  otherRankingButton.disabled = !selectedCompetition;
  otherPodiumButton.disabled = !selectedCompetition;
}

function renderCompetitions(competitions) {
  const root = document.querySelector('#competitions');
  competitionsState = competitions;
  refreshCompetitionManagementControls();
  const filteredCompetitions = getFilteredCompetitions();

  if (competitions.length === 0) {
    root.innerHTML = '<p class="empty-state">Aucune compétition pour le moment.</p>';
    return;
  }

  if (filteredCompetitions.length === 0) {
    root.innerHTML = `<p class="empty-state">Aucune compétition pour ${escapeHtml(formatSeasonLabel(activeCompetitionSeasonFilter))}.</p>`;
    return;
  }

  root.innerHTML = `
    <div class="competitions-table" role="table" aria-label="Compétitions enregistrées">
      <div class="competitions-table-row competitions-table-head" role="row">
        <span role="columnheader">Date</span>
        <span role="columnheader">Titre</span>
        <span role="columnheader">Lieu</span>
        <span role="columnheader">Actions</span>
      </div>
      ${filteredCompetitions.map((competition) => `
        <div class="competition-directory-entry">
          <div class="competitions-table-row" role="row">
            <span role="cell">${escapeHtml(formatFrenchDate(competition.eventDate))}</span>
            <span role="cell">
              <span class="competition-title-cell">
                <strong>${escapeHtml(competition.name)}</strong>
                ${(() => {
                  const indicator = getCompetitionDirectoryIndicatorMeta(competition);
                  return `
                <span
                  class="competition-security-badge ${indicator.modifier}"
                  role="img"
                  aria-label="${escapeHtml(indicator.label)}"
                  title="${escapeHtml(indicator.label)}"
                ></span>
                  `;
                })()}
              </span>
            </span>
            <span role="cell">${escapeHtml(competition.location || 'Lieu non défini')}</span>
            <span role="cell" class="competition-directory-action-cell">
              ${competition.status !== 'active' && competition.status !== 'closed'
                ? `<button
                    type="button"
                    class="competition-directory-action-button ${competition.canGenerateJudgeSheets ? 'is-ready' : 'is-disabled'}"
                    data-competition-action="generate-judge-sheets"
                    data-competition-id="${escapeHtml(competition.id)}"
                    ${competition.canGenerateJudgeSheets ? '' : 'disabled'}
                    title="${competition.canGenerateJudgeSheets ? 'Générer les feuilles juges en PDF' : 'Complétez les informations pour activer la génération PDF'}"
                  >Scoring-sheets</button>
                  <button
                    type="button"
                    class="competition-directory-action-button ${competition.canGenerateJudgeSheets && competition.hasShadowJudges ? 'is-ready-shadow' : 'is-disabled'}"
                    data-competition-action="generate-judge-shadow-sheets"
                    data-competition-id="${escapeHtml(competition.id)}"
                    ${competition.canGenerateJudgeSheets && competition.hasShadowJudges ? '' : 'disabled'}
                    title="${!competition.canGenerateJudgeSheets
                      ? 'Complétez les informations pour activer la génération PDF'
                      : competition.hasShadowJudges
                        ? 'Générer uniquement les feuilles des juges shadow en PDF'
                        : 'Aucun juge shadow enregistré pour cette compétition'}"
                  >Scoring-shadows</button>`
                : ''}
            </span>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  root.querySelectorAll('[data-competition-action="generate-judge-sheets"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) {
        return;
      }

      const popup = openScoringSheetsWindow({
        competitionId: button.dataset.competitionId
      });

      if (!popup) {
        showToast('Le navigateur a bloque l\'ouverture de la fenetre Scoring-sheets.', 'error');
        return;
      }

      showToast('Fenetre Scoring-sheets ouverte.', 'success');
    });
  });

  root.querySelectorAll('[data-competition-action="generate-judge-shadow-sheets"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) {
        return;
      }

      const popup = openScoringSheetsWindow({
        competitionId: button.dataset.competitionId,
        onlyShadows: true
      });

      if (!popup) {
        showToast('Le navigateur a bloque l\'ouverture de la fenetre Scoring-shadows.', 'error');
        return;
      }

      showToast('Fenetre Scoring-shadows ouverte.', 'success');
    });
  });
}

function renderJudges(judges) {
  const root = document.querySelector('#judges');
  const deleteSelect = document.querySelector('#judge-delete-select');
  const sortedJudges = [...judges].sort((left, right) => {
    const leftKey = `${left.lastName ?? ''} ${left.firstName ?? ''} ${left.name ?? ''}`.trim().toLocaleLowerCase('fr');
    const rightKey = `${right.lastName ?? ''} ${right.firstName ?? ''} ${right.name ?? ''}`.trim().toLocaleLowerCase('fr');
    return leftKey.localeCompare(rightKey, 'fr');
  });

  deleteSelect.innerHTML = sortedJudges.length === 0
    ? '<option value="">Aucun juge à supprimer</option>'
    : `
      <option value="" selected>Sélectionnez un juge à supprimer</option>
      ${sortedJudges.map((judge) => `
        <option value="${judge.id}">${escapeHtml(formatJudgeDirectoryLabel(judge))}</option>
      `).join('')}
    `;

  root.innerHTML = sortedJudges.length === 0
    ? '<p class="empty-state">Aucun juge.</p>'
    : `
      <div class="judges-table" role="table" aria-label="Juges enregistrés">
        <div class="judges-table-row judges-table-head" role="row">
          <span role="columnheader">Nom</span>
          <span role="columnheader">Prénom</span>
          <span role="columnheader">Login</span>
          <span role="columnheader">Statut</span>
          <span role="columnheader">Action</span>
        </div>
        ${sortedJudges.map((judge) => `
          <div class="judges-table-row" role="row">
            <span role="cell">${escapeHtml(judge.lastName || judge.name || '-')}</span>
            <span role="cell">${escapeHtml(judge.firstName || '-')}</span>
            <span role="cell">${escapeHtml(judge.login || 'Aucun login')}</span>
            <span role="cell">
              <span class="judge-activity-badge ${isJudgeActive(judge) ? 'is-active' : 'is-inactive'}">${isJudgeActive(judge) ? 'Actif' : 'Désactivé'}</span>
            </span>
            <span role="cell">
              <div class="judge-row-actions">
                <button type="button" class="ghost-button judge-edit-button" data-judge-edit="${judge.id}">Modifier</button>
                <button type="button" class="ghost-button judge-activity-button" data-judge-toggle="${judge.id}" data-judge-next-active="${isJudgeActive(judge) ? '0' : '1'}">${isJudgeActive(judge) ? 'Désactiver' : 'Réactiver'}</button>
              </div>
            </span>
          </div>
        `).join('')}
      </div>
    `;
}

async function renderCompetitorLineup(competitionId) {
  return competitionId;
}

function getCompetitionStatusLabel(status) {
  if (status === 'active') {
    return 'Active';
  }

  if (status === 'draft') {
    return 'Brouillon';
  }

  if (status === 'closed') {
    return 'Clôturée';
  }

  return 'Inconnue';
}

function getCompetitionDirectoryIndicatorMeta(competition) {
  if (competition?.status === 'closed') {
    return {
      modifier: 'is-closed',
      label: 'Compétition clôturée'
    };
  }

  if (competition?.status === 'draft') {
    return {
      modifier: 'is-draft',
      label: 'Compétition en brouillon'
    };
  }

  if (competition?.hasDeletionPassword) {
    return {
      modifier: 'is-protected',
      label: 'Compétition protégée par mot de passe'
    };
  }

  return {
    modifier: 'is-unprotected',
    label: 'Compétition sans mot de passe de suppression'
  };
}

function getCompetitorStatusMeta(status) {
  if (status === 'withdrawn') {
    return { label: 'Désistement', modifier: 'withdrawn' };
  }

  if (status === 'forfeit') {
    return { label: 'Forfait', modifier: 'forfeit' };
  }

  if (status === 'disqualified') {
    return { label: 'Disqualifié', modifier: 'disqualified' };
  }

  return { label: 'Engagé', modifier: 'registered' };
}

function splitCompetitorMembers(value) {
  return String(value ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatAthleteNameFirstLast(firstName, lastName) {
  const normalizedFirstName = String(firstName ?? '').trim();
  const normalizedLastName = String(lastName ?? '').trim();

  if (normalizedFirstName && normalizedLastName) {
    return `${normalizedFirstName} ${normalizedLastName.toLocaleUpperCase('fr-FR')}`;
  }

  if (normalizedFirstName) {
    return normalizedFirstName;
  }

  if (normalizedLastName) {
    return normalizedLastName.toLocaleUpperCase('fr-FR');
  }

  return '';
}

function formatCompetitorAthleteLabel(competitor) {
  const lastNames = splitCompetitorMembers(competitor.lastName);
  const firstNames = splitCompetitorMembers(competitor.firstName);
  const memberCount = Math.max(lastNames.length, firstNames.length);

  if (memberCount > 0) {
    const members = Array.from({ length: memberCount }, (_, index) => {
      const fullName = formatAthleteNameFirstLast(firstNames[index], lastNames[index]);

      return fullName;
    }).filter(Boolean);

    if (members.length > 0) {
      return members.join(' & ');
    }
  }

  return String(competitor.stageName ?? '').trim() || '-';
}

function clearCompetitorManagementImport() {
  competitorManagementState.importState = createCompetitionCompetitorImportState();
  const fileInput = document.querySelector('#competitor-import-file');

  if (fileInput) {
    fileInput.value = '';
  }
}

function renderCompetitorManagementSummary(competition, competitors) {
  const root = document.querySelector('#competitor-management-summary');

  if (!root) {
    return;
  }

  if (!competition) {
    root.innerHTML = `
      <strong>Aucune compétition sélectionnée</strong>
      <p>Choisissez une compétition en brouillon ou active pour afficher sa liste de compétiteurs.</p>
    `;
    return;
  }

  root.innerHTML = `
    <strong>${escapeHtml(competition.name)}</strong>
    <p>${escapeHtml(formatFrenchDate(competition.eventDate))} • ${escapeHtml(competition.location || 'Lieu non défini')}</p>
    <p>${escapeHtml(getCompetitionStatusLabel(competition.status))}</p>
  `;
}

function renderCompetitorManagementImportPanel(competition, competitors) {
  const hint = document.querySelector('#competitor-import-hint');
  const sheetLabel = document.querySelector('#competitor-import-sheet');
  const config = document.querySelector('#competitor-import-config');
  const summary = document.querySelector('#competitor-import-summary');
  const submitButton = document.querySelector('#competitor-import-submit');
  const resetButton = document.querySelector('#competitor-import-reset');
  const fileInput = document.querySelector('#competitor-import-file');
  const state = competitorManagementState.importState;
  const canImport = Boolean(competition && competition.status === 'draft');
  const hasExistingList = competitors.length > 0;

  if (!hint || !sheetLabel || !config || !summary || !submitButton || !resetButton || !fileInput) {
    return;
  }

  fileInput.disabled = !canImport;
  submitButton.textContent = hasExistingList ? 'Remplacer la liste' : 'Charger la liste';

  if (!competition) {
    hint.textContent = 'Sélectionnez d\'abord une compétition en brouillon ou active.';
    sheetLabel.textContent = 'Aucun fichier chargé.';
    config.hidden = true;
    summary.textContent = '';
    resetButton.disabled = true;
    submitButton.disabled = true;
    return;
  }

  if (competition.status !== 'draft') {
    hint.textContent = 'L\'import est réservé aux compétitions en brouillon.';
    sheetLabel.textContent = 'Aucun fichier chargé.';
    config.hidden = true;
    summary.textContent = '';
    resetButton.disabled = true;
    submitButton.disabled = true;
    return;
  }

  hint.innerHTML = hasExistingList
    ? 'Chargez un nouveau fichier Excel pour <strong>remplacer entièrement</strong> la liste actuelle de cette compétition en brouillon.'
    : 'Chargez ici la liste initiale des compétiteurs pour cette compétition en brouillon.';
  sheetLabel.textContent = state.fileName
    ? `${state.fileName} · feuille 2 : ${state.sheetName}`
    : 'Aucun fichier chargé.';

  if (state.rows.length === 0) {
    config.hidden = true;
    summary.textContent = '';
    resetButton.disabled = true;
    submitButton.disabled = true;
    return;
  }

  const { soloCount, duoCount, paraCount, skippedCount } = state.stats;
  config.hidden = false;
  summary.textContent = [
    `${state.rows.length} ligne${state.rows.length > 1 ? 's' : ''} prête${state.rows.length > 1 ? 's' : ''} à l'import`,
    `${soloCount} solo${soloCount > 1 ? 's' : ''}`,
    `${duoCount} duo${duoCount > 1 ? 's' : ''}`,
    `${paraCount} parapole`
  ].join(' • ') + (skippedCount > 0 ? ` • ${skippedCount} ligne(s) incomplète(s) ignorée(s)` : '');
  resetButton.disabled = false;
  submitButton.disabled = false;
}

function renderCompetitorsTable(competition, competitors) {
  const root = document.querySelector('#competitors-table');

  if (!root) {
    return;
  }

  if (!competition) {
    root.innerHTML = '<p class="empty-state">Sélectionnez une compétition pour afficher les engagés.</p>';
    return;
  }

  if (competitors.length === 0) {
    root.innerHTML = competition.status === 'draft'
      ? '<p class="empty-state">Aucun compétiteur pour cette compétition. Vous pouvez charger la liste depuis le panneau d\'import.</p>'
      : '<p class="empty-state">Aucun compétiteur enregistré pour cette compétition.</p>';
    return;
  }

  root.innerHTML = `
    <div class="competitor-table" role="table" aria-label="Compétiteurs inscrits">
      <div class="competitor-table-row competitor-table-head" role="row">
        <span role="columnheader">Statut</span>
        <span role="columnheader">Ordre</span>
        <span role="columnheader">Catégorie</span>
        <span role="columnheader">Athlète</span>
        <span role="columnheader">Actions</span>
      </div>
      ${competitors.map((competitor) => {
        const status = getCompetitorStatusMeta(competitor.status);
        const athleteLabel = formatCompetitorAthleteLabel(competitor);
        const residentBadge = competitor.isResident ? '<span class="competitor-resident-badge" title="Résident" aria-label="Résident">R</span>' : '';
        const withdrawalLabel = competitor.status === 'withdrawn' ? 'Réactiver' : 'Désistement';
        const forfeitLabel = competitor.status === 'forfeit' ? 'Réactiver' : 'Forfait';

        return `
          <div class="competitor-table-row is-${status.modifier}" role="row">
            <span role="cell"><span class="competitor-status-badge is-${status.modifier}">${escapeHtml(status.label)}</span></span>
            <span role="cell">${escapeHtml(String(competitor.runningOrder))}</span>
            <span role="cell">${escapeHtml(competitor.category || '-')}</span>
            <span role="cell"><span class="competitor-athlete-cell">${residentBadge}${escapeHtml(athleteLabel)}</span></span>
            <span role="cell">
              <div class="competitor-row-actions">
                <button type="button" class="ghost-button competitor-status-button${competitor.status === 'withdrawn' ? ' is-selected' : ''}" data-competitor-id="${competitor.id}" data-competitor-status="withdrawn" data-current-status="${competitor.status}">${escapeHtml(withdrawalLabel)}</button>
                <button type="button" class="ghost-button competitor-status-button${competitor.status === 'forfeit' ? ' is-selected' : ''}" data-competitor-id="${competitor.id}" data-competitor-status="forfeit" data-current-status="${competitor.status}">${escapeHtml(forfeitLabel)}</button>
              </div>
            </span>
          </div>
        `;
      }).join('')}
    </div>
  `;

  root.querySelectorAll('[data-competitor-id][data-competitor-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextStatus = button.dataset.currentStatus === button.dataset.competitorStatus
        ? 'registered'
        : button.dataset.competitorStatus;

      try {
        await request(`/api/competitors/${button.dataset.competitorId}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: nextStatus })
        });
        await renderCompetitorManagementSection();
        showToast('Statut compétiteur mis à jour.', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
}

function formatConductorCategoryLabel(category) {
  const normalizedCategory = String(category ?? '').trim();
  return normalizedCategory || 'Sans catégorie';
}

function groupCompetitorsByCategory(competitors) {
  const categoryMap = new Map();

  competitors.forEach((competitor) => {
    const categoryLabel = formatConductorCategoryLabel(competitor.category);

    if (!categoryMap.has(categoryLabel)) {
      categoryMap.set(categoryLabel, []);
    }

    categoryMap.get(categoryLabel).push(competitor);
  });

  return Array.from(categoryMap.entries())
    .map(([category, items]) => ({
      category,
      items: [...items].sort((left, right) => {
        const leftOrder = Number(left.runningOrder) || 0;
        const rightOrder = Number(right.runningOrder) || 0;
        return leftOrder - rightOrder;
      }),
      firstRunningOrder: [...items].reduce((minOrder, competitor) => {
        const runningOrder = Number(competitor.runningOrder) || Number.MAX_SAFE_INTEGER;
        return Math.min(minOrder, runningOrder);
      }, Number.MAX_SAFE_INTEGER)
    }))
    .sort((left, right) => {
      if (left.firstRunningOrder !== right.firstRunningOrder) {
        return left.firstRunningOrder - right.firstRunningOrder;
      }

      return left.category.localeCompare(right.category, 'fr');
    });
}

function buildConductorProgress(competitionId, competitors) {
  const activeCompetitors = competitors
    .filter((competitor) => competitor.status !== 'withdrawn' && competitor.status !== 'forfeit' && competitor.status !== 'disqualified')
    .sort((left, right) => {
      const leftOrder = Number(left.runningOrder) || 0;
      const rightOrder = Number(right.runningOrder) || 0;
      return leftOrder - rightOrder;
    });

  const excludedCount = competitors.length - activeCompetitors.length;
  const completedCount = activeCompetitors.filter((competitor) => isConductorPassageValidated(competitionId, competitor.id)).length;
  const currentCompetitor = completedCount > 0
    ? activeCompetitors.find((competitor) => !isConductorPassageValidated(competitionId, competitor.id)) ?? null
    : null;
  const progressPercent = activeCompetitors.length > 0
    ? Math.round((completedCount / activeCompetitors.length) * 100)
    : 0;

  return {
    current: currentCompetitor,
    completedCount,
    currentIndex: currentCompetitor ? completedCount + 1 : 0,
    total: activeCompetitors.length,
    excludedCount,
    progressPercent
  };
}

function isConductorDuoCompetitor(competitor) {
  if (Array.isArray(competitor?.members) && competitor.members.length > 1) {
    return true;
  }

  return String(competitor?.stageName ?? '').includes('/');
}

function normalizeConductorCriteria(criteria) {
  return (criteria ?? [])
    .filter((criterion) => criterion?.isEnabled)
    .slice()
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
}

function formatConductorJudgeRoleLabel(role) {
  if (role === 'artistique') {
    return 'Artistique';
  }

  if (role === 'head') {
    return 'Head';
  }

  if (role === 'technique') {
    return 'Technique';
  }

  return 'Juge';
}

function formatConductorJudgeLabel(assignment) {
  const explicitName = String(assignment?.judgeName ?? '').trim();

  if (explicitName) {
    return explicitName;
  }

  const fullName = [
    String(assignment?.judgeFirstName ?? '').trim(),
    String(assignment?.judgeLastName ?? '').trim()
  ].filter(Boolean).join(' ');

  if (fullName) {
    return fullName;
  }

  const slotIndex = Number(assignment?.slotIndex ?? 0);
  return Number.isFinite(slotIndex) && slotIndex > 0 ? `Juge ${slotIndex}` : 'Juge';
}

function formatConductorScoreValue(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '—';
  }

  return parsed.toFixed(2).replace('.', ',');
}

function computeConductorSummaryFallback(competitorId, allScores = [], judgeAssignments = []) {
  const cid = String(competitorId ?? '').trim();

  if (!cid) {
    return {
      artisticScore: null,
      technicalScore: null,
      penaltyTotal: null,
      finalScore: null
    };
  }

  const artisticJudgeIds = new Set();
  const technicalJudgeIds = new Set();
  const headJudgeIds = new Set();
  const technicalDenominatorJudgeIds = new Set();

  (judgeAssignments ?? []).forEach((assignment) => {
    if (assignment?.isTrainee) {
      return;
    }

    const judgeId = String(assignment?.judgeId ?? '').trim();

    if (!judgeId) {
      return;
    }

    const role = String(assignment?.judgeRole ?? '').trim();

    if (role === 'artistique') {
      artisticJudgeIds.add(judgeId);
      technicalDenominatorJudgeIds.add(judgeId);
      return;
    }

    if (role === 'head') {
      headJudgeIds.add(judgeId);
      technicalJudgeIds.add(judgeId);
      technicalDenominatorJudgeIds.add(judgeId);
      return;
    }

    if (role === 'technique') {
      technicalJudgeIds.add(judgeId);
    }
  });

  let artisticTotal = 0;
  let technicalTotal = 0;
  let penaltyTotal = 0;

  (allScores ?? []).forEach((score) => {
    if (String(score?.competitorId ?? '').trim() !== cid) {
      return;
    }

    const judgeId = String(score?.judgeId ?? '').trim();
    const criterion = String(score?.criterion ?? '').trim();
    const value = Number(score?.score);

    if (!Number.isFinite(value)) {
      return;
    }

    if (criterion.startsWith('artistic:') && artisticJudgeIds.has(judgeId)) {
      artisticTotal += value;
      return;
    }

    if (criterion.startsWith('technical:') && technicalJudgeIds.has(judgeId)) {
      technicalTotal += value;
      return;
    }

    if (criterion.startsWith('penalty:') && headJudgeIds.has(judgeId)) {
      penaltyTotal += value;
    }
  });

  const artisticDenominator = artisticJudgeIds.size;
  const technicalDenominator = technicalDenominatorJudgeIds.size;

  const artisticScore = artisticDenominator > 0
    ? artisticTotal / artisticDenominator
    : null;
  const technicalScore = technicalDenominator > 0
    ? (technicalTotal - penaltyTotal) / technicalDenominator
    : null;
  const finalScore = Number.isFinite(artisticScore) && Number.isFinite(technicalScore)
    ? artisticScore + technicalScore
    : null;

  return {
    artisticScore,
    technicalScore,
    penaltyTotal,
    finalScore: artisticScore !== null || technicalScore !== null ? finalScore : null
  };
}

function buildConductorScoreDetailsHtml(judgingState, summary = null) {
  const lines = Array.isArray(judgingState?.scoreLines) ? judgingState.scoreLines : [];
  const artisticLabel = formatConductorScoreValue(summary?.artisticScore);
  const technicalLabel = formatConductorScoreValue(summary?.technicalScore);
  const globalLabel = formatConductorScoreValue(summary?.finalScore);
  const penaltyValue = Number(summary?.penaltyTotal);
  const hasPenalty = Number.isFinite(penaltyValue) && Math.abs(penaltyValue) > 0;
  const penaltyLabel = formatConductorScoreValue(Math.abs(penaltyValue));

  const summaryBlock = `
    <div class="conductor-scores-summary" aria-label="Synthese des notes">
      <p><strong>Note artistique</strong><span>${escapeHtml(artisticLabel)}</span></p>
      <p><strong>Note technique</strong><span>${escapeHtml(technicalLabel)}</span></p>
      <p><strong>Note globale</strong><span>${escapeHtml(globalLabel)}</span></p>
      ${hasPenalty ? `<p class="is-penalty"><strong>Pénalités</strong><span>-${escapeHtml(penaltyLabel)}</span></p>` : ''}
    </div>
  `;

  if (!lines.length) {
    return `
      <div class="conductor-scores-layout">
        ${summaryBlock}
        <div class="conductor-scores-content">
          <p class="conductor-scores-empty">Aucun detail de notes disponible.</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="conductor-scores-layout">
      ${summaryBlock}
      <div class="conductor-scores-content">
        <div class="conductor-scores-list">
          ${lines.map((line) => `
            <p class="conductor-scores-line">
              <strong>${escapeHtml(line.judgeLabel)} (${escapeHtml(line.sectorLabel)})</strong>
              ${Array.isArray(line.notes) && line.notes.length
                ? `<span class="conductor-scores-notes">${line.notes.map((note) => `
                    <span class="conductor-score-chip" tabindex="0" role="note" data-tooltip="${escapeHtml(note.tooltip || '')}" aria-label="Critere: ${escapeHtml(note.tooltip || '')}">${escapeHtml(note.value)}</span>
                  `).join('<span class="conductor-score-separator">|</span>')}</span>`
                : `<span>${escapeHtml(line.notesLabel)}</span>`}
            </p>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function buildConductorJudgingStateMap({ competitors, scores, judgeAssignments, scoringProfile }) {
  const judgingStateMap = new Map();

  const mainAssignments = (judgeAssignments ?? []).filter((assignment) => assignment?.judgeId && !assignment?.isTrainee);
  const artisticAssignments = mainAssignments.filter((assignment) => assignment.judgeRole === 'artistique');
  const technicalAssignments = mainAssignments.filter((assignment) => assignment.judgeRole === 'technique' || assignment.judgeRole === 'head');

  const artisticSoloCriteria = normalizeConductorCriteria(scoringProfile?.profile?.artisticSolo?.criteria);
  const artisticDuoCriteria = normalizeConductorCriteria(scoringProfile?.profile?.artisticDuo?.criteria);
  const technicalSoloCriteria = normalizeConductorCriteria(scoringProfile?.profile?.technicalSolo?.criteria);
  const technicalDuoCriteria = normalizeConductorCriteria(scoringProfile?.profile?.technicalDuo?.criteria);

  const scoresByCompetitor = new Map();

  (scores ?? []).forEach((score) => {
    const competitorId = String(score?.competitorId ?? '').trim();

    if (!competitorId) {
      return;
    }

    if (!scoresByCompetitor.has(competitorId)) {
      scoresByCompetitor.set(competitorId, []);
    }

    scoresByCompetitor.get(competitorId).push(score);
  });

  (competitors ?? []).forEach((competitor) => {
    const competitorId = String(competitor?.id ?? '').trim();

    if (!competitorId) {
      return;
    }

    const isDuo = isConductorDuoCompetitor(competitor);
    const artisticCriteria = isDuo ? artisticDuoCriteria : artisticSoloCriteria;
    const technicalCriteria = isDuo ? technicalDuoCriteria : technicalSoloCriteria;
    const criterionLabelByKey = new Map();

    artisticCriteria.forEach((criterion) => {
      const criterionKey = `artistic:${criterion.criterionKey}`;
      criterionLabelByKey.set(criterionKey, String(criterion?.label ?? criterion?.criterionKey ?? '').trim());
    });

    technicalCriteria.forEach((criterion) => {
      const criterionKey = `technical:${criterion.criterionKey}`;
      criterionLabelByKey.set(criterionKey, String(criterion?.label ?? criterion?.criterionKey ?? '').trim());
    });

    const requiredKeys = new Set();
    const orderedKeysByJudge = new Map();

    artisticAssignments.forEach((assignment) => {
      const judgeId = String(assignment?.judgeId ?? '').trim();

      if (!judgeId) {
        return;
      }

      if (!orderedKeysByJudge.has(judgeId)) {
        orderedKeysByJudge.set(judgeId, []);
      }

      artisticCriteria.forEach((criterion) => {
        const criterionKey = `artistic:${criterion.criterionKey}`;
        requiredKeys.add(`${judgeId}::${criterionKey}`);
        orderedKeysByJudge.get(judgeId).push(criterionKey);
      });
    });

    technicalAssignments.forEach((assignment) => {
      const judgeId = String(assignment?.judgeId ?? '').trim();

      if (!judgeId) {
        return;
      }

      if (!orderedKeysByJudge.has(judgeId)) {
        orderedKeysByJudge.set(judgeId, []);
      }

      technicalCriteria.forEach((criterion) => {
        const criterionKey = `technical:${criterion.criterionKey}`;
        requiredKeys.add(`${judgeId}::${criterionKey}`);
        orderedKeysByJudge.get(judgeId).push(criterionKey);
      });
    });

    const existingKeys = new Set();
    const scoreByJudgeAndCriterion = new Map();

    (scoresByCompetitor.get(competitorId) ?? []).forEach((score) => {
      const judgeId = String(score?.judgeId ?? '').trim();
      const criterion = String(score?.criterion ?? '').trim();

      if (!judgeId || !criterion || (!criterion.startsWith('artistic:') && !criterion.startsWith('technical:'))) {
        return;
      }

      existingKeys.add(`${judgeId}::${criterion}`);
      scoreByJudgeAndCriterion.set(`${judgeId}::${criterion}`, score?.score);
    });

    const requiredCount = requiredKeys.size;
    const filledRequiredCount = Array.from(requiredKeys).filter((key) => existingKeys.has(key)).length;

    let stateKey = 'to-judge';
    let label = 'À juger';

    if (requiredCount > 0 && filledRequiredCount >= requiredCount) {
      stateKey = 'judged';
      label = 'Jugé';
    }

    const orderedMainAssignments = [...mainAssignments]
      .sort((left, right) => {
        const leftIsHead = left?.judgeRole === 'head' ? 1 : 0;
        const rightIsHead = right?.judgeRole === 'head' ? 1 : 0;
        return leftIsHead - rightIsHead;
      });

    const scoreLines = orderedMainAssignments
      .map((assignment) => {
        const judgeId = String(assignment?.judgeId ?? '').trim();
        const orderedCriteriaKeys = orderedKeysByJudge.get(judgeId) ?? [];

        if (!judgeId || !orderedCriteriaKeys.length) {
          return null;
        }

        const notes = orderedCriteriaKeys.map((criterionKey) => {
          const value = formatConductorScoreValue(scoreByJudgeAndCriterion.get(`${judgeId}::${criterionKey}`));
          const criterionLabel = criterionLabelByKey.get(criterionKey) || criterionKey;

          return {
            value,
            tooltip: criterionLabel
          };
        });

        const notesLabel = notes.map((note) => note.value).join(' | ');

        return {
          judgeLabel: formatConductorJudgeLabel(assignment),
          sectorLabel: formatConductorJudgeRoleLabel(assignment?.judgeRole),
          notes,
          notesLabel
        };
      })
      .filter(Boolean);

    judgingStateMap.set(competitorId, {
      stateKey,
      label,
      requiredCount,
      filledRequiredCount,
      scoreLines
    });
  });

  return judgingStateMap;
}

function renderConductorSection(activeCompetition, competitors, options = {}, scoresMap = new Map(), judgingStateMap = new Map(), scoreSummaryMap = new Map()) {
  const summaryRoot = document.querySelector('#conductor-active-summary');
  const progressValue = document.querySelector('#conductor-progress-value');
  const progressCurrent = document.querySelector('#conductor-progress-current');
  const progressBar = document.querySelector('#conductor-progress-bar');
  const accordionRoot = document.querySelector('#conductor-category-accordion');
  const openCategories = options.openCategories instanceof Set ? options.openCategories : new Set();

  if (!summaryRoot || !progressValue || !progressCurrent || !progressBar || !accordionRoot) {
    return;
  }

  if (!activeCompetition) {
    syncConductorStateForCompetition('');
    renderConductorJudgePresence(null, []);
    summaryRoot.innerHTML = `
      <strong>Aucune compétition active</strong>
      <p>Passez une compétition en statut Active pour afficher les catégories et leurs passages.</p>
    `;
    progressValue.textContent = '0 / 0';
    progressCurrent.textContent = '';
    progressBar.style.width = '0%';
    accordionRoot.innerHTML = '<p class="empty-state conductor-empty-state">Aucune liste à afficher sans compétition active.</p>';
    return;
  }

  syncConductorStateForCompetition(activeCompetition.id);

  const presenterActiveCompetitorId = String(conductorState.presenterActivePassageId ?? '').trim();
  const presenterActiveCompetitor = presenterActiveCompetitorId
    ? competitors.find((competitor) => String(competitor.id ?? '').trim() === presenterActiveCompetitorId) ?? null
    : null;

  summaryRoot.innerHTML = `
    <strong>${escapeHtml(activeCompetition.name)}</strong>
    <p>${escapeHtml(formatFrenchDate(activeCompetition.eventDate))} • ${escapeHtml(activeCompetition.location || 'Lieu non défini')}</p>
    ${presenterActiveCompetitor ? `
      <div class="conductor-tablet-release-banner">
        <p>Passage actif sur tablettes : <strong>N° ${escapeHtml(String(presenterActiveCompetitor.runningOrder || '-'))} · ${escapeHtml(formatCompetitorAthleteLabel(presenterActiveCompetitor))}</strong></p>
        <button type="button" class="ghost-button conductor-release-button" data-conductor-action="release-tablets">Libérer les tablettes</button>
      </div>
    ` : ''}
  `;

  const releaseTabletsButton = summaryRoot.querySelector('[data-conductor-action="release-tablets"]');

  if (releaseTabletsButton) {
    releaseTabletsButton.addEventListener('click', async () => {
      releaseTabletsButton.disabled = true;
      releaseTabletsButton.textContent = 'Libération...';

      try {
        const freshPresenterState = await request('/api/presenter/state');
        const activePassage = freshPresenterState?.activePassage ?? null;

        if (activePassage?.id) {
          await request('/api/presenter/finalize', {
            method: 'POST',
            body: JSON.stringify({
              competitionId: activePassage.competitionId,
              competitorId: activePassage.id
            })
          });

          setConductorPassageValidated(activePassage.competitionId, activePassage.id, false);
          setConductorDispatchMode(activePassage.id, 'manual');
        }

        if (conductorState.activeRecapPopup && !conductorState.activeRecapPopup.closed) {
          conductorState.activeRecapPopup.close();
        }
        conductorState.activeRecapPopup = null;
        conductorState.presenterActivePassageId = '';

        showToast('Tablettes libérées. Vous pouvez envoyer un nouveau passage.', 'success');

        const openCategoriesState = getOpenConductorCategories();
        renderConductorSection(activeCompetition, competitors, { openCategories: openCategoriesState }, scoresMap, judgingStateMap, scoreSummaryMap);
      } catch (error) {
        showToast(error.message, 'error');
        releaseTabletsButton.disabled = false;
        releaseTabletsButton.textContent = 'Libérer les tablettes';
      }
    });
  }

  if (!competitors.length) {
    progressValue.textContent = '0 / 0';
    progressCurrent.textContent = '';
    progressBar.style.width = '0%';
    accordionRoot.innerHTML = '<p class="empty-state conductor-empty-state">Aucun passage enregistré pour la compétition active.</p>';
    return;
  }

  const progress = buildConductorProgress(activeCompetition.id, competitors);
  progressValue.textContent = `${progress.completedCount} / ${progress.total}`;
  progressBar.style.width = `${progress.progressPercent}%`;

  if (progress.current) {
    const athleteLabel = formatCompetitorAthleteLabel(progress.current);
    progressCurrent.textContent = `Passage en cours: ${progress.current.runningOrder} · ${athleteLabel}`
      + (progress.excludedCount > 0 ? ` · ${progress.excludedCount} désisté(s)/forfait(s) exclus` : '');
  } else {
    progressCurrent.textContent = progress.excludedCount > 0
      ? `${progress.excludedCount} désisté(s)/forfait(s) exclus`
      : '';
  }

  const categoryGroups = groupCompetitorsByCategory(competitors);

  accordionRoot.innerHTML = `
    <div class="conductor-accordion">
      ${categoryGroups.map((group) => {
        const competitorsToJudge = group.items.filter((competitor) => {
          const status = getCompetitorStatusMeta(competitor.status);
          return status.modifier === 'registered';
        });
        const selectedManualCompetitorIdsInCategory = group.items
          .filter((competitor) => competitor.status === 'registered' && getConductorDispatchMode(competitor.id) === 'manual')
          .map((competitor) => competitor.id)
          .filter((competitorId) => isConductorManualBatchSelected(competitorId));
        const selectedManualCountInCategory = selectedManualCompetitorIdsInCategory.length;

        const allJudgedInCategory = competitorsToJudge.length > 0 && competitorsToJudge.every((competitor) => {
          const judgedState = judgingStateMap.get(competitor.id)?.stateKey ?? 'to-judge';
          return judgedState === 'judged';
        });

        return `
        <details class="conductor-category-item${allJudgedInCategory ? ' is-judged' : ''}" ${openCategories.has(group.category) ? 'open' : ''}>
          <summary>
            <span class="conductor-category-heading">
              <span class="conductor-category-label">${escapeHtml(group.category)}</span>
              <span class="conductor-category-count">${group.items.length} passage${group.items.length > 1 ? 's' : ''}</span>
              ${allJudgedInCategory ? `<button type="button" class="conductor-category-results-badge" data-conductor-action="view-category-results" data-category="${escapeHtml(group.category)}">Voir le classement</button>` : ''}
              ${selectedManualCountInCategory > 0 ? `<button type="button" class="conductor-action-button conductor-category-batch-button" data-conductor-action="batch-open-category" data-competitor-ids="${escapeHtml(selectedManualCompetitorIdsInCategory.join(','))}">Saisie lot</button>` : ''}
            </span>
          </summary>
          <div class="conductor-passages-list">
            ${group.items.map((competitor) => {
              const status = getCompetitorStatusMeta(competitor.status);
              const mode = getConductorDispatchMode(competitor.id);
              const presenterActiveCompetitorId = String(conductorState.presenterActivePassageId ?? '').trim();
              const isPresenterActive = presenterActiveCompetitorId === String(competitor.id ?? '').trim();
              const isValidated = mode === 'tablet'
                ? isPresenterActive
                : isConductorPassageValidated(activeCompetition.id, competitor.id);
              const canValidate = status.modifier === 'registered';
              const canSend = status.modifier === 'registered';
              const competitorScoreCount = scoresMap.get(String(competitor.id)) ?? 0;
              const judgingStateBase = judgingStateMap.get(competitor.id) ?? { stateKey: 'to-judge', label: 'À juger' };
              const judgingState = (
                judgingStateBase.stateKey === 'to-judge'
                && isValidated
                && status.modifier === 'registered'
              )
                ? { stateKey: 'in-progress', label: 'En cours' }
                : judgingStateBase;
              const judgeCount = activeCompetition.judgeCount ?? 0;
              const isFullyScored = judgeCount > 0 && competitorScoreCount >= judgeCount;
              const forfeitLabel = competitor.status === 'forfeit' ? 'Réactiver' : 'Forfait';
              const disqualificationLabel = competitor.status === 'disqualified' ? 'Réactiver' : 'Disqualifier';
              const residentBadge = competitor.isResident ? '<span class="conductor-resident-badge" title="Résident" aria-label="Résident">R</span>' : '';
              return `
                <div class="conductor-passage-item is-${status.modifier} judging-${judgingState.stateKey}">
                  <div class="conductor-passage-main">
                    <label class="conductor-batch-selector" title="Ajouter ce passage à la saisie manuelle en lot">
                      <input type="checkbox" data-conductor-batch-select data-competitor-id="${competitor.id}" ${canSend && mode === 'manual' ? '' : 'disabled'} ${isConductorManualBatchSelected(competitor.id) ? 'checked' : ''}>
                    </label>
                    <span class="conductor-passage-order">${escapeHtml(String(competitor.runningOrder || '-'))}</span>
                    <span class="conductor-passage-name">${residentBadge}${escapeHtml(formatCompetitorAthleteLabel(competitor))}</span>
                    <span class="conductor-passage-status is-${status.modifier}">${escapeHtml(status.label)}</span>
                    <span class="conductor-judging-status is-${judgingState.stateKey}">${escapeHtml(judgingState.label)}</span>
                  </div>
                  <div class="conductor-passage-actions">
                    ${canSend ? `
                      <label class="conductor-mode-switch" for="conductor-mode-${competitor.id}">
                        <span class="conductor-mode-side${mode === 'manual' ? ' is-active' : ''}">Manuel</span>
                        <input id="conductor-mode-${competitor.id}" type="checkbox" data-conductor-mode-switch data-competitor-id="${competitor.id}" ${mode === 'tablet' ? 'checked' : ''}>
                        <span class="conductor-mode-slider"></span>
                        <span class="conductor-mode-side${mode === 'tablet' ? ' is-active' : ''}">Tablettes</span>
                      </label>
                      <button type="button" class="ghost-button conductor-action-button${isValidated ? ' is-selected' : ''}" data-conductor-action="validate" data-competitor-id="${competitor.id}" ${canValidate ? '' : 'disabled'}>Envoyer</button>
                    ` : '<span class="conductor-action-disabled-note">Mode d\'envoi indisponible</span>'}
                    <button type="button" class="ghost-button conductor-action-button conductor-status-action${competitor.status === 'forfeit' ? ' is-selected' : ''}" data-conductor-action="status" data-conductor-status="forfeit" data-competitor-id="${competitor.id}">${forfeitLabel}</button>
                    <button type="button" class="ghost-button conductor-action-button conductor-status-action${competitor.status === 'disqualified' ? ' is-selected' : ''}" data-conductor-action="status" data-conductor-status="disqualified" data-competitor-id="${competitor.id}">${disqualificationLabel}</button>
                    ${isFullyScored ? `<button type="button" class="ghost-button conductor-action-button conductor-scores-button" data-conductor-action="view-scores" data-competitor-id="${competitor.id}">Voir les notes</button>` : ''}
                  </div>
                  ${isFullyScored ? `
                    <div class="conductor-scores-details" data-conductor-scores="${competitor.id}" hidden>
                      ${buildConductorScoreDetailsHtml(judgingStateBase, scoreSummaryMap.get(String(competitor.id)) ?? null)}
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </details>
      `;
      }).join('')}
    </div>
  `;

  accordionRoot.querySelectorAll('[data-conductor-mode-switch]').forEach((input) => {
    input.addEventListener('change', () => {
      const openCategoriesState = getOpenConductorCategories();
      const competitorId = input.dataset.competitorId;
      setConductorDispatchMode(competitorId, input.checked ? 'tablet' : 'manual');
      if (input.checked) {
        setConductorManualBatchSelected(competitorId, false);
      }
      renderConductorSection(activeCompetition, competitors, { openCategories: openCategoriesState }, scoresMap, judgingStateMap, scoreSummaryMap);
    });
  });

  accordionRoot.querySelectorAll('[data-conductor-batch-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const openCategoriesState = getOpenConductorCategories();
      const competitorId = input.dataset.competitorId;
      setConductorManualBatchSelected(competitorId, input.checked);
      renderConductorSection(activeCompetition, competitors, { openCategories: openCategoriesState }, scoresMap, judgingStateMap, scoreSummaryMap);
    });
  });

  accordionRoot.querySelectorAll('[data-conductor-action="batch-open-category"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const selectedCompetitorIds = String(button.dataset.competitorIds ?? '')
        .split(',')
        .map((competitorId) => competitorId.trim())
        .filter(Boolean);

      if (!selectedCompetitorIds.length) {
        showToast('Sélectionnez au moins un passage en mode manuel dans cette catégorie.', 'error');
        return;
      }

      const popup = openManualScoringBatchWindow({
        competitionId: activeCompetition.id,
        competitorIds: selectedCompetitorIds
      });

      if (!popup) {
        showToast('Le navigateur a bloque l\'ouverture de la fenetre de saisie lot.', 'error');
        return;
      }

      showToast('Fenetre de saisie manuelle lot ouverte.', 'success');
    });
  });

  accordionRoot.querySelectorAll('[data-conductor-action="view-scores"]').forEach((button) => {
    button.addEventListener('click', () => {
      const competitorId = button.dataset.competitorId;
      if (!competitorId) {
        return;
      }

      const detailsContainer = accordionRoot.querySelector(`[data-conductor-scores="${competitorId}"]`);

      if (!detailsContainer) {
        return;
      }

      const shouldShow = detailsContainer.hidden;
      detailsContainer.hidden = !shouldShow;
      button.classList.toggle('is-selected', shouldShow);
    });
  });

  accordionRoot.querySelectorAll('[data-conductor-action="view-category-results"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const category = button.dataset.category;
      const popup = openCategoryResultsWindow({
        competitionId: activeCompetition.id,
        category
      });

      if (!popup) {
        showToast('Le navigateur a bloque l\'ouverture de la fenetre de classement.', 'error');
      }
    });
  });

  accordionRoot.querySelectorAll('[data-conductor-action="validate"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const openCategoriesState = getOpenConductorCategories();
      const competitorId = button.dataset.competitorId;
      const targetCompetitor = competitors.find((competitor) => competitor.id === competitorId);

      if (!targetCompetitor || targetCompetitor.status !== 'registered') {
        showToast('Le mode de jugement ne peut être validé que pour un compétiteur engagé.', 'error');
        return;
      }

      const dispatchMode = getConductorDispatchMode(competitorId);
      let recapPopup = null;

      try {
        if (dispatchMode === 'tablet') {
          const presenterState = await request('/api/presenter/state');
          const activePresenterCompetitorId = String(presenterState?.activePassage?.id ?? '').trim();

          if (activePresenterCompetitorId && activePresenterCompetitorId !== competitorId) {
            const activeJudgingState = judgingStateMap.get(activePresenterCompetitorId) ?? { stateKey: 'to-judge' };

            if (activeJudgingState.stateKey !== 'judged') {
              throw new Error('Un autre passage tablette est encore en cours. Terminez-le avant un nouvel envoi.');
            }
          }

          recapPopup = openTabletRecapWindow({
            competitionId: activeCompetition.id,
            competitor: targetCompetitor
          });

          if (!recapPopup) {
            throw new Error('Le navigateur a bloque l\'ouverture de la fenetre recapitulative');
          }

          await request('/api/presenter/active', {
            method: 'POST',
            body: JSON.stringify({
              competitionId: activeCompetition.id,
              competitorId
            })
          });

          conductorState.activeRecapPopup = recapPopup;
          conductorState.presenterActivePassageId = competitorId;
        } else {
          const popup = openManualScoringWindow({
            competitionId: activeCompetition.id,
            competitorId
          });

          if (!popup) {
            throw new Error('Le navigateur a bloque l\'ouverture de la fenetre de saisie manuelle');
          }
        }

        setConductorPassageValidated(activeCompetition.id, competitorId, true);
        renderConductorSection(activeCompetition, competitors, { openCategories: openCategoriesState }, scoresMap, judgingStateMap, scoreSummaryMap);
        if (dispatchMode === 'tablet') {
          showToast('Passage envoye aux tablettes.', 'success');
        }
      } catch (error) {
        if (recapPopup && !recapPopup.closed) {
          recapPopup.close();
        }
        showToast(error.message, 'error');
      }
    });
  });

  accordionRoot.querySelectorAll('[data-conductor-action="status"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const openCategoriesState = getOpenConductorCategories();
      const competitorId = button.dataset.competitorId;
      const targetStatus = button.dataset.conductorStatus;
      const targetCompetitor = competitors.find((competitor) => competitor.id === competitorId);

      if (!targetCompetitor) {
        return;
      }

      const nextStatus = targetCompetitor.status === targetStatus ? 'registered' : targetStatus;

      try {
        await request(`/api/competitors/${competitorId}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: nextStatus })
        });

        if (nextStatus !== 'registered') {
          setConductorPassageValidated(activeCompetition.id, competitorId, false);
        }

        await refreshConductorSection(activeCompetition, { openCategories: openCategoriesState });

        try {
          await renderCompetitorManagementSection();
        } catch {
          // No-op: la vue compétiteurs peut ne pas être initialisée dans ce contexte.
        }

        const feedbackLabel = nextStatus === 'registered'
          ? 'Compétiteur réactivé.'
          : nextStatus === 'forfeit'
            ? 'Compétiteur passé en forfait.'
            : 'Compétiteur disqualifié.';
        showToast(feedbackLabel, 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
}

function renderConductorJudgePresence(activeCompetition, judges = []) {
  const summaryRoot = document.querySelector('#conductor-judge-presence-summary');
  const listRoot = document.querySelector('#conductor-judge-presence-list');
  const shadowToggle = document.querySelector('#conductor-include-shadow-tablets');

  if (!summaryRoot || !listRoot || !(shadowToggle instanceof HTMLInputElement)) {
    return;
  }

  if (!activeCompetition?.id) {
    shadowToggle.checked = false;
    shadowToggle.disabled = true;
    summaryRoot.textContent = '--';
    listRoot.innerHTML = '<p class="dashboard-status-empty">Activez une compétition pour suivre la connexion des tablettes.</p>';
    return;
  }

  shadowToggle.disabled = false;
  shadowToggle.checked = conductorIncludeShadowTabletJudges;

  const tabletJudges = conductorIncludeShadowTabletJudges
    ? judges
    : judges.filter((judge) => !judge?.isTrainee);
  const orderedTabletJudges = [...tabletJudges].sort((left, right) => {
    const leftSlot = Number(left?.slotIndex ?? Number.POSITIVE_INFINITY);
    const rightSlot = Number(right?.slotIndex ?? Number.POSITIVE_INFINITY);

    if (Number.isFinite(leftSlot) && Number.isFinite(rightSlot) && leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }

    return String(left?.name ?? '').localeCompare(String(right?.name ?? ''), 'fr');
  });

  const total = orderedTabletJudges.length;
  const connectedCount = orderedTabletJudges.filter((judge) => judge?.isConnected).length;
  summaryRoot.textContent = `${connectedCount}/${total}`;

  if (!total) {
    listRoot.innerHTML = '<p class="dashboard-status-empty">Aucun juge officiel affecté à cette compétition.</p>';
    return;
  }

  listRoot.innerHTML = orderedTabletJudges.map((judge) => {
    const isConnected = Boolean(judge?.isConnected);
    const judgeName = String(judge?.name ?? '').trim() || String(judge?.login ?? '').trim() || 'Juge sans nom';
    const sectorLabel = judge?.isTrainee
      ? 'Shadow'
      : formatConductorJudgeRoleLabel(String(judge?.judgeRole ?? '').trim());

    return `
      <article class="conductor-judge-presence-pill ${isConnected ? 'is-connected' : 'is-disconnected'}">
        <div>
          <strong>${escapeHtml(judgeName)}</strong>
          <p>${escapeHtml(sectorLabel)}</p>
        </div>
      </article>
    `;
  }).join('');
}

function buildConductorJudgePresenceFallback(assignments = []) {
  const mappedAssignments = Array.isArray(assignments)
    ? assignments
      .filter((assignment) => String(assignment?.judgeId ?? '').trim())
      .map((assignment) => {
        const judgeId = String(assignment?.judgeId ?? '').trim();
        const judgeName = String(assignment?.judgeName ?? '').trim();
        const judgeFirstName = String(assignment?.judgeFirstName ?? '').trim();
        const judgeLastName = String(assignment?.judgeLastName ?? '').trim();
        const judgeLogin = String(assignment?.judgeLogin ?? '').trim();
        const fullName = [judgeFirstName, judgeLastName].filter(Boolean).join(' ').trim();

        return {
          id: judgeId,
          slotIndex: Number(assignment?.slotIndex ?? Number.POSITIVE_INFINITY),
          name: judgeName || fullName || judgeLogin,
          firstName: judgeFirstName,
          lastName: judgeLastName,
          login: judgeLogin,
          judgeRole: String(assignment?.judgeRole ?? '').trim(),
          isTrainee: Boolean(assignment?.isTrainee),
          lastSeenAt: null,
          isConnected: false
        };
      })
    : [];

  if (!mappedAssignments.length) {
    return [];
  }

  const byJudgeId = new Map();

  mappedAssignments.forEach((judge) => {
    if (!byJudgeId.has(judge.id)) {
      byJudgeId.set(judge.id, judge);
    }
  });

  return [...byJudgeId.values()];
}

function ensureConductorJudgePresencePolling() {
  if (conductorPresenceRefreshTimer) {
    return;
  }

  conductorPresenceRefreshTimer = window.setInterval(async () => {
    if (document.visibilityState === 'hidden' || activeSection !== 'conductor') {
      return;
    }

    const competitionId = String(conductorState.activeCompetitionId ?? '').trim();

    if (!competitionId) {
      return;
    }

    try {
      const payload = await request(`/api/competitions/${competitionId}/judge-presence`);
      const competition = payload?.competition ?? null;
      const judges = Array.isArray(payload?.judges) ? payload.judges : [];
      renderConductorJudgePresence(competition, judges);
    } catch {
    }
  }, CONDUCTOR_PRESENCE_REFRESH_MS);
}

// Dans l'application desktop (pywebview), les fenetres ouvertes via l'API
// open_window() n'ont pas de window.opener : les messages postMessage
// (tablet-recap-closed/finalized, manual-scoring-saved/closed...) ne
// parviennent donc jamais au tableau de bord. On compense par un sondage
// leger, actif uniquement dans ce contexte (cf. README, "Phase 6bis") — le
// comportement navigateur/Node (postMessage instantane) reste inchange.
function ensureConductorTabletSyncPolling() {
  if (conductorTabletSyncTimer || !isPywebviewHost()) {
    return;
  }

  conductorTabletSyncTimer = window.setInterval(async () => {
    if (document.visibilityState === 'hidden' || activeSection !== 'conductor') {
      return;
    }

    const competitionId = String(conductorState.activeCompetitionId ?? '').trim();

    if (!competitionId) {
      return;
    }

    const activeCompetition = competitionsState.find((competition) => competition.id === competitionId) ?? null;

    if (!activeCompetition) {
      return;
    }

    try {
      const openCategoriesState = getOpenConductorCategories();
      await refreshConductorSection(activeCompetition, { openCategories: openCategoriesState });
    } catch {
    }
  }, CONDUCTOR_TABLET_SYNC_REFRESH_MS);
}

// Vue conducteur: regroupement par categorie, controle d'envoi et saisie manuelle.

async function refreshConductorSection(activeCompetition, options = {}) {

  if (!activeCompetition?.id) {
    conductorIncludeShadowTabletJudges = false;
    renderConductorJudgePresence(null, []);
    renderConductorSection(null, [], options);
    return;
  }

  try {
    const [competitors, resultsData, judgeAssignments, scoringProfile, judgePresenceResult, presenterState] = await Promise.all([
      request(`/api/competitions/${activeCompetition.id}/competitors`),
      request(`/api/competitions/${activeCompetition.id}/results`).catch(() => ({ results: [], scores: [] })),
      request(`/api/competitions/${activeCompetition.id}/judge-assignments`).catch(() => []),
      request(`/api/competitions/${activeCompetition.id}/scoring-profile`).catch(() => ({ profile: {} })),
      request(`/api/competitions/${activeCompetition.id}/judge-presence`)
        .then((payload) => ({ ok: true, payload }))
        .catch(() => ({ ok: false, payload: null })),
      request('/api/presenter/state').catch(() => null)
    ]);
    const scoresMap = new Map((resultsData.results ?? []).map((r) => [String(r.id), r.scoreCount ?? 0]));
    const scoreSummaryMap = new Map((resultsData.results ?? []).map((result) => {
      const fallback = computeConductorSummaryFallback(result.id, resultsData.scores ?? [], judgeAssignments ?? []);

      const artisticScore = Number.isFinite(Number(result?.artisticScore))
        ? result.artisticScore
        : fallback.artisticScore;
      const technicalScore = Number.isFinite(Number(result?.technicalScore))
        ? result.technicalScore
        : fallback.technicalScore;
      const penaltyTotal = Number.isFinite(Number(result?.penaltyTotal))
        ? result.penaltyTotal
        : fallback.penaltyTotal;
      const finalScore = Number.isFinite(Number(result?.finalScore))
        ? result.finalScore
        : fallback.finalScore;

      return [
        String(result.id),
        {
          artisticScore,
          technicalScore,
          penaltyTotal,
          finalScore
        }
      ];
    }));
    const judgingStateMap = buildConductorJudgingStateMap({
      competitors,
      scores: resultsData.scores ?? [],
      judgeAssignments,
      scoringProfile
    });
    const presenterActiveCompetitorId = String(presenterState?.activePassage?.id ?? '').trim();
    const presenterCompetitionId = String(presenterState?.activeCompetition?.id ?? '').trim();

    reconcileConductorTabletValidatedState(
      activeCompetition.id,
      presenterCompetitionId === String(activeCompetition.id) ? presenterActiveCompetitorId : ''
    );

    const fallbackJudges = buildConductorJudgePresenceFallback(judgeAssignments);
    const apiPresenceCompetition = judgePresenceResult?.payload?.competition ?? activeCompetition;
    const apiPresenceJudges = Array.isArray(judgePresenceResult?.payload?.judges)
      ? judgePresenceResult.payload.judges
      : [];
    const apiIncludeShadowTabletJudges = judgePresenceResult?.ok && typeof judgePresenceResult?.payload?.includeShadowTabletJudges === 'boolean'
      ? judgePresenceResult.payload.includeShadowTabletJudges
      : false;
    conductorIncludeShadowTabletJudges = apiIncludeShadowTabletJudges;
    const presenceJudges = judgePresenceResult?.ok
      ? (apiPresenceJudges.length > 0 || fallbackJudges.length === 0 ? apiPresenceJudges : fallbackJudges)
      : fallbackJudges;

    renderConductorJudgePresence(apiPresenceCompetition, presenceJudges);
    renderConductorSection(activeCompetition, competitors, options, scoresMap, judgingStateMap, scoreSummaryMap);
  } catch (error) {
    const summaryRoot = document.querySelector('#conductor-active-summary');
    const progressValue = document.querySelector('#conductor-progress-value');
    const progressCurrent = document.querySelector('#conductor-progress-current');
    const progressBar = document.querySelector('#conductor-progress-bar');
    const accordionRoot = document.querySelector('#conductor-category-accordion');

    if (summaryRoot) {
      summaryRoot.innerHTML = `
        <strong>${escapeHtml(activeCompetition.name || 'Compétition active')}</strong>
        <p>Impossible de charger les passages.</p>
      `;
    }

    if (accordionRoot) {
      accordionRoot.innerHTML = `<p class="empty-state conductor-empty-state">${escapeHtml(error.message || 'Erreur de chargement')}</p>`;
    }

    if (progressValue) {
      progressValue.textContent = '0 / 0';
    }

    if (progressCurrent) {
      progressCurrent.textContent = '';
    }

    if (progressBar) {
      progressBar.style.width = '0%';
    }

    conductorIncludeShadowTabletJudges = false;
    renderConductorJudgePresence(activeCompetition, []);
  }
}

async function renderCompetitorManagementSection() {
  const select = document.querySelector('#competitor-management-select');
  const eligibleCompetitions = competitionsState.filter((competition) => competition.status === 'draft' || competition.status === 'active');
  const selectedCompetitionId = setCompetitionSelectOptions(
    select,
    eligibleCompetitions,
    'Sélectionnez une compétition brouillon ou active',
    competitorManagementState.competitionId
  );

  competitorManagementState.competitionId = selectedCompetitionId;
  const selectedCompetition = eligibleCompetitions.find((competition) => competition.id === selectedCompetitionId) ?? null;
  const competitors = selectedCompetition
    ? await request(`/api/competitions/${selectedCompetition.id}/competitors`)
    : [];

  competitorManagementState.competitors = competitors;
  renderCompetitorManagementSummary(selectedCompetition, competitors);
  renderCompetitorManagementImportPanel(selectedCompetition, competitors);
  renderCompetitorsTable(selectedCompetition, competitors);
}

async function importCompetitorsForSelectedCompetition() {
  if (!competitorManagementState.competitionId) {
    throw new Error('Sélectionnez d\'abord une compétition');
  }

  const selectedCompetition = competitionsState.find((competition) => competition.id === competitorManagementState.competitionId);

  if (!selectedCompetition || selectedCompetition.status !== 'draft') {
    throw new Error('L\'import n\'est autorisé que pour une compétition en brouillon');
  }

  const importState = competitorManagementState.importState;

  if (!importState.rows.length) {
    throw new Error('Chargez d\'abord un classeur Excel');
  }

  const shouldReplaceExisting = competitorManagementState.competitors.length > 0;
  const knownCompetitors = new Set();
  const rowsToImport = [];
  let skippedCount = importState.stats.skippedCount;

  if (shouldReplaceExisting) {
    const confirmed = await showConfirmDialog({
      title: 'Remplacer la liste des compétiteurs ? ',
      message: 'La liste actuelle sera supprimée puis recréée à partir du fichier Excel chargé. Cette action est réservée aux compétitions en brouillon.',
      confirmLabel: 'Oui, remplacer',
      cancelLabel: 'Annuler'
    });

    if (!confirmed) {
      return;
    }
  }

  for (const row of importState.rows) {
    const identity = buildImportedCompetitorIdentity(row.stageName, row.runningOrder);

    if (knownCompetitors.has(identity)) {
      skippedCount += 1;
      continue;
    }

    knownCompetitors.add(identity);
    rowsToImport.push({
      stageName: row.stageName,
      firstName: row.firstName,
      lastName: row.lastName,
      members: row.members,
      category: row.category,
      isResident: row.isResident,
      runningOrder: row.runningOrder
    });
  }

  if (rowsToImport.length === 0) {
    throw new Error('Aucune ligne exploitable à importer');
  }

  if (shouldReplaceExisting) {
    await request(`/api/competitions/${competitorManagementState.competitionId}/competitors`, {
      method: 'DELETE'
    });
  }

  for (const competitor of rowsToImport) {
    await request(`/api/competitions/${competitorManagementState.competitionId}/competitors`, {
      method: 'POST',
      body: JSON.stringify(competitor)
    });
  }

  clearCompetitorManagementImport();
  await refresh();
  showToast(
    skippedCount > 0
      ? `${shouldReplaceExisting ? 'Liste remplacée' : 'Liste chargée'} (${rowsToImport.length} compétiteur(s) importé(s), ${skippedCount} ignoré(s)).`
      : `${shouldReplaceExisting ? 'Liste remplacée' : 'Liste chargée'} (${rowsToImport.length} compétiteur(s) importé(s)).`,
    'success'
  );
}

function renderSettingsActionBar() {
  const actionBar = document.querySelector('#settings-action-bar');
  const logoutButton = document.querySelector('#settings-action-logout');
  const archivePanel = document.querySelector('#settings-archive-panel');

  if (!actionBar) {
    return;
  }

  const allowedActions = canCurrentUserManageAccess()
    ? new Set(['criteria', 'access', 'archive'])
    : canCurrentUserEditCriteria()
      ? new Set(['criteria'])
      : new Set();

  actionBar.querySelectorAll('[data-settings-action]').forEach((button) => {
    const action = button.dataset.settingsAction;
    const isAllowed = allowedActions.has(action);
    button.hidden = !isAllowed;
    const isActive = isAllowed && action === scoringSettingsState.panel;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  if (logoutButton) {
    logoutButton.hidden = !canCurrentUserAccessSettings();
  }

  if (archivePanel) {
    const canManageArchive = canCurrentUserManageArchive();
    if (!canManageArchive && scoringSettingsState.panel === 'archive') {
      scoringSettingsState.panel = 'criteria';
    }

    if (canManageArchive && scoringSettingsState.panel === 'archive') {
      refreshArchiveCatalog({ silent: true }).catch(() => {
      });
    }
  }
}

function getArchiveResultNode() {
  return document.querySelector('#settings-archive-result') ?? document.querySelector('#sync-result');
}

function setArchiveRestoreButtonsState() {
  const select = document.querySelector('#archive-restore-select');
  const downloadButton = document.querySelector('#archive-restore-download');
  const restoreButton = document.querySelector('#archive-restore-db');
  const hasSelection = Boolean(select?.value);
  const isAllowed = canCurrentUserManageArchive();

  if (downloadButton) {
    downloadButton.disabled = !isAllowed || !hasSelection;
  }

  if (restoreButton) {
    restoreButton.disabled = !isAllowed || !hasSelection;
  }
}

function formatArchiveOptionLabel(archive) {
  const updatedAt = new Date(archive.updatedAt);

  if (Number.isNaN(updatedAt.getTime())) {
    return archive.fileName;
  }

  const datePart = updatedAt.toLocaleDateString('fr-FR');
  const timePart = updatedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${archive.fileName} (${datePart} ${timePart})`;
}

async function refreshArchiveCatalog({ silent = false } = {}) {
  const select = document.querySelector('#archive-restore-select');
  const refreshButton = document.querySelector('#archive-restore-refresh');

  if (!select) {
    return;
  }

  if (!canCurrentUserManageArchive()) {
    select.innerHTML = '<option value="">Réservé à l\'admin</option>';
    select.value = '';
    setArchiveRestoreButtonsState();
    return;
  }

  const previousValue = select.value;

  if (refreshButton) {
    refreshButton.disabled = true;
  }

  try {
    const archives = await request('/api/db/archives');
    const archiveList = Array.isArray(archives) ? archives : [];

    if (archiveList.length === 0) {
      select.innerHTML = '<option value="">Aucune archive disponible</option>';
      select.value = '';
      setArchiveRestoreButtonsState();

      if (!silent) {
        showToast('Aucune archive disponible.', 'info');
      }

      return;
    }

    select.innerHTML = '<option value="">Choisir une archive...</option>'
      + archiveList
        .map((archive) => `<option value="${escapeHtml(archive.fileName)}">${escapeHtml(formatArchiveOptionLabel(archive))}</option>`)
        .join('');

    if (previousValue && archiveList.some((archive) => archive.fileName === previousValue)) {
      select.value = previousValue;
    } else {
      select.value = archiveList[0].fileName;
    }

    setArchiveRestoreButtonsState();

    if (!silent) {
      showToast('Liste des archives mise à jour.', 'success');
    }
  } catch (error) {
    setArchiveRestoreButtonsState();

    if (!silent) {
      showToast(error.message, 'error');
      const result = getArchiveResultNode();

      if (result) {
        result.textContent = error.message;
      }
    }
  } finally {
    if (refreshButton) {
      refreshButton.disabled = false;
    }
  }
}

async function performSettingsLogout() {
  await logoutAccessSession();
  resetAccessAccountForm();
  await refresh();
  setActiveSection('dashboard');
  showToast('Déconnexion effectuée.', 'success');
}

function resetAccessAccountForm() {
  accessState.editAccountId = '';
  accessState.accessFormMode = 'create';
  document.querySelector('#settings-access-account-id').value = '';
  document.querySelector('#settings-access-first-name').value = '';
  document.querySelector('#settings-access-last-name').value = '';
  document.querySelector('#settings-access-login').value = '';
  document.querySelector('#settings-access-password').value = '';
  document.querySelector('#settings-access-role').value = 'scrutateur';
  document.querySelector('#settings-access-active').value = 'true';
  document.querySelector('#settings-access-save').textContent = 'Créer le compte';
  renderAccessRecoveryOutput('');
}

function fillAccessAccountForm(account) {
  accessState.editAccountId = account?.id ?? '';
  accessState.accessFormMode = account?.id ? 'edit' : 'create';
  document.querySelector('#settings-access-account-id').value = account?.id ?? '';
  document.querySelector('#settings-access-first-name').value = account?.firstName ?? '';
  document.querySelector('#settings-access-last-name').value = account?.lastName ?? '';
  document.querySelector('#settings-access-login').value = account?.login ?? '';
  document.querySelector('#settings-access-password').value = '';
  document.querySelector('#settings-access-role').value = account?.role ?? 'scrutateur';
  document.querySelector('#settings-access-active').value = account?.isActive === false ? 'false' : 'true';
  document.querySelector('#settings-access-save').textContent = account?.id ? 'Enregistrer les modifications' : 'Créer le compte';
}

function formatRecoveryCodeStatusLabel(status) {
  switch (String(status ?? '').trim()) {
    case 'active':
      return 'Actif';
    case 'used':
      return 'Utilisé';
    case 'revoked':
      return 'Révoqué';
    default:
      return 'Inconnu';
  }
}

function renderAccessRecoveryOutput(htmlContent = '') {
  const root = document.querySelector('#settings-access-recovery-output');

  if (!root) {
    return;
  }

  root.innerHTML = htmlContent;
}

function getRecoveryCodeDisplayValue(row) {
  const fullCode = String(row?.code ?? '').trim();

  if (fullCode) {
    return fullCode;
  }

  const hintCode = String(row?.codeHint ?? '').trim();
  return hintCode || 'Code indisponible';
}

async function toggleAccessRecoveryCodesList(accountId) {
  const normalizedAccountId = String(accountId ?? '').trim();

  if (!normalizedAccountId) {
    return;
  }

  if (accessState.expandedRecoveryAccountId === normalizedAccountId) {
    accessState.expandedRecoveryAccountId = '';
    accessState.recoveryCodesLoadingAccountId = '';
    renderAccessSettingsPanel();
    return;
  }

  accessState.expandedRecoveryAccountId = normalizedAccountId;
  accessState.recoveryCodesLoadingAccountId = normalizedAccountId;
  renderAccessSettingsPanel();

  try {
    const codes = await request(`/api/access/accounts/${normalizedAccountId}/recovery-codes`);
    accessState.recoveryCodesByAccount[normalizedAccountId] = Array.isArray(codes) ? codes : [];
  } catch (error) {
    accessState.recoveryCodesByAccount[normalizedAccountId] = [];
    showToast(error.message, 'error');
  } finally {
    if (accessState.recoveryCodesLoadingAccountId === normalizedAccountId) {
      accessState.recoveryCodesLoadingAccountId = '';
    }

    renderAccessSettingsPanel();
  }
}

function renderScoringCriteriaTable() {
  const root = document.querySelector('#settings-criteria-table');

  if (!root) {
    return;
  }

  const rows = (Array.isArray(scoringSettingsState.criteria) ? scoringSettingsState.criteria : [])
    .filter((criterion) => criterion.gridKey === scoringSettingsState.selectedGridKey);

  root.innerHTML = rows.length === 0
    ? '<p class="empty-state">Aucun critère pour cette grille.</p>'
    : `
      <div class="settings-criteria-table-grid" role="table" aria-label="Catalogue des critères">
        <div class="settings-criteria-row settings-criteria-head" role="row">
          <span role="columnheader">Ordre</span>
          <span role="columnheader">Critère</span>
          <span role="columnheader">Clé technique</span>
          <span role="columnheader">Version</span>
          <span role="columnheader">Actions</span>
        </div>
        ${rows.map((criterion) => `
          <div class="settings-criteria-row" role="row">
            <span role="cell"><span class="criterion-order-pill">${escapeHtml(String(criterion.sortOrder))}</span></span>
            <span role="cell">${escapeHtml(criterion.label)}</span>
            <span role="cell"><code class="criterion-key-chip">${escapeHtml(criterion.criterionKey)}</code></span>
            <span role="cell"><span class="criterion-version-pill">v${escapeHtml(String(criterion.versionNumber))}</span></span>
            <span role="cell">
              <button type="button" class="ghost-button settings-inline-action" data-settings-edit-criterion="${criterion.id}">Modifier</button>
            </span>
          </div>
        `).join('')}
      </div>
    `;
}

function renderScoringCriteriaPanel() {
  const gridSelect = document.querySelector('#settings-criteria-grid');

  if (!gridSelect) {
    return;
  }

  const grids = Array.isArray(scoringSettingsState.grids) ? scoringSettingsState.grids : [];

  if (grids.length === 0) {
    gridSelect.innerHTML = '<option value="">Aucune grille disponible</option>';
    renderScoringCriteriaTable();
    return;
  }

  if (!grids.some((grid) => grid.gridKey === scoringSettingsState.selectedGridKey)) {
    scoringSettingsState.selectedGridKey = grids[0].gridKey;
  }

  gridSelect.innerHTML = grids.map((grid) => `
    <option value="${grid.gridKey}">${escapeHtml(grid.label)}</option>
  `).join('');
  gridSelect.value = scoringSettingsState.selectedGridKey;
  renderScoringCriteriaTable();
}

function renderAccessSettingsPanel() {
  const root = document.querySelector('#settings-access-panel');
  const editTableRoot = document.querySelector('#settings-access-table');
  const codesTableRoot = document.querySelector('#settings-access-codes-table');
  const createShell = document.querySelector('#settings-access-create-shell');
  const editShell = document.querySelector('#settings-access-edit-shell');
  const codesShell = document.querySelector('#settings-access-codes-shell');
  const actionBar = document.querySelector('#settings-access-action-bar');

  if (!root || !editTableRoot || !codesTableRoot || !createShell || !editShell || !codesShell || !actionBar) {
    return;
  }

  if (!canCurrentUserManageAccess()) {
    root.hidden = true;
    return;
  }

  root.hidden = scoringSettingsState.panel !== 'access';

  const allowedActions = new Set(['create', 'edit', 'codes']);
  const selectedAction = allowedActions.has(accessState.settingsAction) ? accessState.settingsAction : 'create';
  accessState.settingsAction = selectedAction;
  createShell.hidden = selectedAction !== 'create';
  editShell.hidden = selectedAction !== 'edit';
  codesShell.hidden = selectedAction !== 'codes';

  actionBar.querySelectorAll('[data-access-panel-action]').forEach((button) => {
    const action = button.dataset.accessPanelAction;
    const isActive = action === selectedAction;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  const accounts = Array.isArray(accessState.accounts) ? accessState.accounts : [];

  const renderAccountsTable = (mode) => {
    if (accounts.length === 0) {
      return '<p class="empty-state">Aucun compte enregistré.</p>';
    }

    const tableRowsHtml = accounts.map((account) => {
      if (mode === 'edit') {
        return `
          <div class="settings-access-row" role="row">
            <span role="cell">${escapeHtml(`${account.firstName} ${account.lastName}`.trim())}</span>
            <span role="cell"><code class="criterion-key-chip">${escapeHtml(account.login)}</code></span>
            <span role="cell"><span class="criterion-version-pill">${escapeHtml(getAccessRoleLabel(account.role))}</span></span>
            <span role="cell"><span class="criterion-order-pill">${account.isActive ? 'Oui' : 'Non'}</span></span>
            <span role="cell"><span class="criterion-order-pill">${account.mustChangePassword ? 'Oui' : 'Non'}</span></span>
            <span role="cell">
              <button type="button" class="ghost-button settings-inline-action" data-access-edit-account="${account.id}">Modifier</button>
              <button type="button" class="ghost-button settings-inline-action" data-access-delete-account="${account.id}">Supprimer</button>
            </span>
          </div>
        `;
      }

      const isExpanded = accessState.expandedRecoveryAccountId === account.id;
      const isLoading = accessState.recoveryCodesLoadingAccountId === account.id;
      const cachedRows = Array.isArray(accessState.recoveryCodesByAccount[account.id])
        ? accessState.recoveryCodesByAccount[account.id]
        : null;

      const detailsHtml = isExpanded
        ? `
          <div class="settings-access-row settings-access-row--details" role="row">
            <span role="cell" class="settings-access-row-details-cell">
              ${isLoading
                ? '<p class="settings-access-recovery-list-empty">Chargement des 4 derniers codes...</p>'
                : (cachedRows && cachedRows.length > 0
                    ? `
                      <div class="settings-access-recovery-list" role="list" aria-label="4 derniers codes de récupération">
                        ${cachedRows.map((row) => `
                          <div class="settings-access-recovery-list-item" role="listitem">
                            <code>${escapeHtml(getRecoveryCodeDisplayValue(row))}</code>
                            <span>${escapeHtml(formatRecoveryCodeStatusLabel(row.status))}</span>
                            <span>${escapeHtml(formatDateTime(row.createdAt))}</span>
                          </div>
                        `).join('')}
                      </div>
                    `
                    : '<p class="settings-access-recovery-list-empty">Aucun code de récupération récent.</p>')}
            </span>
          </div>
        `
        : '';

      return `
        <div class="settings-access-row" role="row">
          <span role="cell">${escapeHtml(`${account.firstName} ${account.lastName}`.trim())}</span>
          <span role="cell"><code class="criterion-key-chip">${escapeHtml(account.login)}</code></span>
          <span role="cell"><span class="criterion-version-pill">${escapeHtml(getAccessRoleLabel(account.role))}</span></span>
          <span role="cell"><span class="criterion-order-pill">${account.isActive ? 'Oui' : 'Non'}</span></span>
          <span role="cell"><span class="criterion-order-pill">${account.mustChangePassword ? 'Oui' : 'Non'}</span></span>
          <span role="cell">
            <button type="button" class="ghost-button settings-inline-action settings-inline-action--compact" data-access-generate-recovery="${account.id}">Génération</button>
            <button type="button" class="ghost-button settings-inline-action settings-inline-action--compact ${isExpanded ? 'is-active' : ''}" data-access-list-recovery="${account.id}">${isExpanded ? 'Masquer' : 'Statuts'}</button>
            <button type="button" class="ghost-button settings-inline-action settings-inline-action--compact" data-access-revoke-recovery="${account.id}">Révocation</button>
          </span>
        </div>
        ${detailsHtml}
      `;
    }).join('');

    return `
      <div class="settings-access-table-grid" role="table" aria-label="Comptes d'accès">
        <div class="settings-access-row settings-access-head" role="row">
          <span role="columnheader">Nom</span>
          <span role="columnheader">Login</span>
          <span role="columnheader">Rôle</span>
          <span role="columnheader">Actif</span>
          <span role="columnheader">Mdp à changer</span>
          <span role="columnheader">Actions</span>
        </div>
        ${tableRowsHtml}
      </div>
    `;
  };

  editTableRoot.innerHTML = renderAccountsTable('edit');
  codesTableRoot.innerHTML = renderAccountsTable('codes');
}

function renderScoringSettings() {
  const home = document.querySelector('#settings-home');
  const criteriaPanel = document.querySelector('#settings-criteria-panel');
  const accessPanel = document.querySelector('#settings-access-panel');
  const archivePanel = document.querySelector('#settings-archive-panel');

  if (!home || !criteriaPanel || !accessPanel || !archivePanel) {
    return;
  }

  renderSettingsActionBar();
  const showCriteria = scoringSettingsState.panel === 'criteria';
  const showAccess = scoringSettingsState.panel === 'access';
  const showArchive = scoringSettingsState.panel === 'archive';
  home.hidden = showCriteria || showAccess || showArchive;
  criteriaPanel.hidden = !showCriteria;

  if (showCriteria) {
    renderScoringCriteriaPanel();
  }

  accessPanel.hidden = !showAccess;

  if (showAccess) {
    renderAccessSettingsPanel();
  }

  archivePanel.hidden = !showArchive;
}

function renderStoragePathInfo() {
  const node = document.querySelector('#settings-db-path');

  if (!node) {
    return;
  }

  node.textContent = storageState.dbFile || 'Chemin indisponible';
}

function openScoringSettingsPanel(panel) {
  scoringSettingsState.panel = panel;

  if (panel === 'access' && !['create', 'edit', 'codes'].includes(accessState.settingsAction)) {
    accessState.settingsAction = 'create';
  }

  renderScoringSettings();
}

async function refreshScoringSettings() {
  if (!canCurrentUserEditCriteria()) {
    scoringSettingsState.grids = [];
    scoringSettingsState.criteria = [];
    accessState.accounts = [];
    renderScoringSettings();
    return;
  }

  const [grids, criteria] = await Promise.all([
    request('/api/scoring/grids'),
    request('/api/scoring/criteria')
  ]);

  scoringSettingsState.grids = grids;
  scoringSettingsState.criteria = criteria;

  if (canCurrentUserManageAccess()) {
    try {
      accessState.accounts = await request('/api/access/accounts');
      accessState.recoveryCodesByAccount = {};
      accessState.expandedRecoveryAccountId = '';
      accessState.recoveryCodesLoadingAccountId = '';
    } catch {
      accessState.accounts = [];
      accessState.recoveryCodesByAccount = {};
      accessState.expandedRecoveryAccountId = '';
      accessState.recoveryCodesLoadingAccountId = '';
    }
  }

  renderScoringSettings();
}

async function refreshAccessState() {
  try {
    const status = await request('/api/access/status');
    accessState.hasAccounts = Boolean(status.hasAccounts);
    accessState.currentAccount = status.currentAccount ?? null;
    syncAccessDrivenNavigation();

    if (!status.currentAccount) {
      clearAccessSession();
    }
  } catch {
    accessState.hasAccounts = false;
    clearAccessSession();
  }
}

async function refresh() {
  const bootstrap = await request('/api/bootstrap');
  judgesState = bootstrap.judges;
  storageState.dbFile = String(bootstrap?.storage?.dbFile ?? '').trim();

  try {
    const presenterState = await request('/api/presenter/state');
    presenterResultsPublished = Boolean(presenterState?.resultsEnabled);
  } catch {
    presenterResultsPublished = false;
  }

  syncPresenterResultsServerControlButton();
  await refreshAccessState();
  await refreshConductorSection(bootstrap.dashboard?.activeCompetition ?? null);
  renderActiveCompetitionInfo(bootstrap);
  renderCompetitions(bootstrap.competitions);
  renderStatisticsSection();
  renderJudges(bootstrap.judges);
  try {
    await refreshScoringSettings();
  } catch {
    scoringSettingsState.grids = [];
    renderScoringSettings();
  }
  renderStoragePathInfo();
  await hydrateCompetitionWizardData();
  await renderCompetitorManagementSection();
}

// Bootstrap UI: tous les listeners DOM sont centralises ici.

document.querySelectorAll('.nav-item[data-section]').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveSection(button.dataset.section);
  });
});

document.querySelectorAll('[data-nav-action="logout"]').forEach((button) => {
  button.addEventListener('click', async () => {
    await performSettingsLogout();
  });
});

document.querySelector('#competitor-management-select').addEventListener('change', async (event) => {
  competitorManagementState.competitionId = event.currentTarget.value;
  clearCompetitorManagementImport();

  try {
    await renderCompetitorManagementSection();
  } catch (error) {
    document.querySelector('#competitors-table').textContent = error.message;
  }
});

document.querySelector('#competition-season-filter').addEventListener('change', (event) => {
  activeCompetitionSeasonFilter = event.currentTarget.value;
  renderCompetitions(competitionsState);
});

document.querySelectorAll('[data-create-step-target]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!button.disabled) {
      setCompetitionWizardStep(button.dataset.createStepTarget);
    }
  });
});

document.querySelectorAll('[data-create-nav="next"]').forEach((button) => {
  button.addEventListener('click', () => {
    setCompetitionWizardStep(getNextCompetitionWizardStep(competitionWizardState.step));
  });
});

document.querySelectorAll('[data-create-nav="prev"]').forEach((button) => {
  button.addEventListener('click', () => {
    setCompetitionWizardStep(getPreviousCompetitionWizardStep(competitionWizardState.step));
  });
});

document.querySelectorAll('[data-competition-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    setCompetitionMode(button.dataset.competitionMode);
  });
});

document.querySelector('#competition-edit-select').addEventListener('change', (event) => {
  fillCompetitionEditForm(event.currentTarget.value);
});

document.querySelector('#competition-form [name="eventDate"]').addEventListener('change', (event) => {
  setSeasonSelectOptions(document.querySelector('#competition-season'), getSeasonValueFromEventDate(event.currentTarget.value));
});

document.querySelector('#competition-level').addEventListener('change', () => {
  updateCompetitionRegionalFields('create');
});

document.querySelector('#competition-region').addEventListener('change', (event) => {
  updateCompetitionRegionalFields('create', event.currentTarget.value);
});

document.querySelector('#competition-presenter-enabled').addEventListener('change', (event) => {
  competitionWizardState.presenterEnabled = event.currentTarget.checked;
  renderCompetitionWizard();
});

document.querySelector('#competition-edit-date').addEventListener('change', (event) => {
  setSeasonSelectOptions(document.querySelector('#competition-edit-season'), getSeasonValueFromEventDate(event.currentTarget.value));
});

document.querySelector('#competition-edit-level').addEventListener('change', () => {
  updateCompetitionRegionalFields('edit');
});

document.querySelector('#competition-edit-region').addEventListener('change', (event) => {
  updateCompetitionRegionalFields('edit', event.currentTarget.value);
});

document.querySelector('#competition-delete-select').addEventListener('change', (event) => {
  renderCompetitionDeleteSummary(event.currentTarget.value);
});

document.querySelectorAll('[data-section-target]').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveSection(button.dataset.sectionTarget);
  });
});

document.querySelectorAll('[data-server-control]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.serverControl === 'shutdown') {
      handleServerShutdown();
      return;
    }

    if (button.dataset.serverControl === 'restart') {
      handleServerRestart();
      return;
    }

    if (button.dataset.serverControl === 'presenter-results') {
      handlePresenterResultsToggle();
      return;
    }
  });
});

document.querySelector('[data-competition-directory-toggle]').addEventListener('click', () => {
  setCompetitionDirectoryVisibility(!isCompetitionDirectoryVisible);
});

document.querySelector('#conductor-include-shadow-tablets')?.addEventListener('change', async (event) => {
  const target = event.currentTarget;

  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const competitionId = String(conductorState.activeCompetitionId ?? '').trim();

  if (!competitionId) {
    target.checked = false;
    target.disabled = true;
    showToast('Activez une compétition pour modifier cette option.', 'error');
    return;
  }

  const nextValue = target.checked;
  target.disabled = true;

  try {
    const payload = await request(`/api/competitions/${competitionId}/shadow-tablets`, {
      method: 'POST',
      body: JSON.stringify({ includeShadowTabletJudges: nextValue })
    });

    conductorIncludeShadowTabletJudges = Boolean(payload?.includeShadowTabletJudges);
    const activeCompetition = competitionsState.find((competition) => competition.id === competitionId) ?? null;
    await refreshConductorSection(activeCompetition);
    showToast(conductorIncludeShadowTabletJudges
      ? 'Les juges shadow sont inclus sur les tablettes.'
      : 'Les juges shadow sont masqués sur les tablettes.', 'success');
  } catch (error) {
    target.checked = conductorIncludeShadowTabletJudges;
    showToast(error.message, 'error');
  } finally {
    target.disabled = false;
  }
});

// Info-bulle du menu reduit : positionnee en JS (position: fixed) plutot
// qu'en CSS pur, pour echapper a overflow-x: hidden sur .sidebar (necessaire
// a son ascenseur vertical) qui coupait sinon l'ancienne info-bulle ::after.
function hideSidebarTooltip() {
  const tooltip = document.querySelector('#sidebar-floating-tooltip');

  if (!tooltip) {
    return;
  }

  tooltip.classList.remove('is-visible');
  tooltip.setAttribute('aria-hidden', 'true');
}

function showSidebarTooltip(navItem) {
  const shell = document.querySelector('.app-shell');
  const tooltip = document.querySelector('#sidebar-floating-tooltip');

  if (!shell || !tooltip || shell.dataset.sidebarState !== 'collapsed') {
    return;
  }

  const tooltipText = String(navItem.dataset.tooltip ?? '').trim();

  if (!tooltipText) {
    return;
  }

  const rect = navItem.getBoundingClientRect();
  tooltip.textContent = tooltipText;
  tooltip.style.top = `${rect.top + (rect.height / 2)}px`;
  tooltip.style.left = `${rect.right + 12}px`;
  tooltip.classList.add('is-visible');
  tooltip.removeAttribute('aria-hidden');
}

document.querySelectorAll('#sidebar .nav-item').forEach((navItem) => {
  navItem.addEventListener('mouseenter', () => showSidebarTooltip(navItem));
  navItem.addEventListener('mouseleave', hideSidebarTooltip);
  navItem.addEventListener('focus', () => showSidebarTooltip(navItem));
  navItem.addEventListener('blur', hideSidebarTooltip);
  navItem.addEventListener('click', hideSidebarTooltip);
});

document.querySelector('#sidebar')?.addEventListener('scroll', hideSidebarTooltip);
window.addEventListener('resize', hideSidebarTooltip);

document.querySelector('#sidebar-toggle').addEventListener('click', () => {
  const shell = document.querySelector('.app-shell');
  const isExpanded = shell.dataset.sidebarState !== 'collapsed';
  shell.dataset.sidebarState = isExpanded ? 'collapsed' : 'expanded';
  hideSidebarTooltip();
});

document.querySelector('#competition-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());
  const deletePassword = String(payload.deletePassword ?? '').trim();
  const deletePasswordConfirm = String(payload.deletePasswordConfirm ?? '').trim();
  payload.presenterEnabled = document.querySelector('#competition-presenter-enabled').checked;

  if (deletePassword !== deletePasswordConfirm) {
    showToast('La confirmation du mot de passe de suppression ne correspond pas.', 'error');
    return;
  }

  delete payload.deletePasswordConfirm;

  try {
    const competition = await request(competitionWizardState.competitionId
      ? `/api/competitions/${competitionWizardState.competitionId}`
      : '/api/competitions', {
      method: competitionWizardState.competitionId ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });

    competitionWizardState.competitionId = competition.id;
    competitionWizardState.presenterEnabled = Boolean(payload.presenterEnabled);
    await refresh();
    setCompetitionMode('create');
    setCompetitionWizardStep('judges');
    showToast(competitionWizardState.competitionId ? 'Informations générales enregistrées.' : 'Compétition créée.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#competition-wizard-judges').addEventListener('change', async (event) => {
  const target = event.target;

  const isSelect = target instanceof HTMLSelectElement;
  const isCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox';

  if (!(isSelect || isCheckbox) || !target.matches('[data-assignment-slot][data-assignment-field]')) {
    return;
  }

  const competition = getCompetitionWizardCompetition();

  if (!competition) {
    showToast('Compétition introuvable.', 'error');
    return;
  }

  const slotIndex = Number.parseInt(target.dataset.assignmentSlot ?? '', 10);
  const assignment = competitionWizardState.assignments.find((item) => item.slotIndex === slotIndex);

  if (!assignment) {
    showToast('Ligne d\'affectation introuvable.', 'error');
    return;
  }

  const nextAssignment = {
    slotIndex,
    judgeRole: target.dataset.assignmentField === 'judgeRole' && isSelect ? target.value : assignment.judgeRole,
    judgeId: target.dataset.assignmentField === 'judgeId' && isSelect ? target.value : assignment.judgeId,
    isTrainee: target.dataset.assignmentField === 'isTrainee' && isCheckbox ? target.checked : assignment.isTrainee
  };

  try {
    const assignments = await request(`/api/competitions/${competitionWizardState.competitionId}/judge-assignments`, {
      method: 'POST',
      body: JSON.stringify(nextAssignment)
    });
    competitionWizardState.assignments = assignments;
    renderCompetitionWizard();
  } catch (error) {
    showToast(error.message, 'error');
    renderCompetitionWizard();
  }
});

document.querySelector('#competition-wizard-judges').addEventListener('submit', async (event) => {
  const formElement = event.target;

  if (!(formElement instanceof HTMLFormElement)) {
    return;
  }
});

document.querySelector('#competition-edit-judges').addEventListener('change', async (event) => {
  const target = event.target;

  const isSelect = target instanceof HTMLSelectElement;
  const isCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox';

  if (!(isSelect || isCheckbox) || !target.matches('[data-edit-assignment-slot][data-edit-assignment-field]')) {
    return;
  }

  if (!competitionEditState.competitionId) {
    showToast('Sélectionnez d\'abord une compétition.', 'error');
    return;
  }

  const slotIndex = Number.parseInt(target.dataset.editAssignmentSlot ?? '', 10);
  const assignment = competitionEditState.assignments.find((item) => item.slotIndex === slotIndex);

  if (!assignment) {
    showToast('Ligne d\'affectation introuvable.', 'error');
    return;
  }

  const nextAssignment = {
    slotIndex,
    judgeRole: target.dataset.editAssignmentField === 'judgeRole' && isSelect ? target.value : assignment.judgeRole,
    judgeId: target.dataset.editAssignmentField === 'judgeId' && isSelect ? target.value : assignment.judgeId,
    isTrainee: target.dataset.editAssignmentField === 'isTrainee' && isCheckbox ? target.checked : assignment.isTrainee
  };

  try {
    const assignments = await request(`/api/competitions/${competitionEditState.competitionId}/judge-assignments`, {
      method: 'POST',
      body: JSON.stringify(nextAssignment)
    });
    competitionEditState.assignments = assignments;
    renderCompetitionEditJudges();
    showToast('Affectation juge mise à jour.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
    renderCompetitionEditJudges();
  }
});

document.querySelector('#competition-edit-judges').addEventListener('click', async (event) => {
  if (!event.target.closest('#competition-edit-add-judge-slot')) {
    return;
  }

  await addCompetitionEditJudgeSlot();
});

document.querySelector('#competition-competitor-import-file').addEventListener('change', async (event) => {
  const [file] = event.currentTarget.files ?? [];

  if (!file) {
    clearCompetitionCompetitorImport();
    return;
  }

  try {
    competitionWizardState.competitorImport = await parseCompetitionCompetitorWorkbook(file);
    renderCompetitionCompetitorImportPanel();
    showToast('Classeur Excel chargé.', 'success');
  } catch (error) {
    clearCompetitionCompetitorImport();
    showToast(error.message, 'error');
  }
});

document.querySelector('#competition-competitor-import-reset').addEventListener('click', () => {
  clearCompetitionCompetitorImport();
});

document.querySelector('#competition-competitor-import-submit').addEventListener('click', async () => {
  try {
    await importCompetitionCompetitorsFromWorkbook();
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#competition-wizard-finish').addEventListener('click', async () => {
  if (!competitionWizardState.competitionId) {
    showToast('Commencez par enregistrer les informations générales.', 'error');
    return;
  }

  await refresh();
  resetCompetitionWizard();
  setCompetitionMode('create');
  showToast('Tunnel de création terminé.', 'success');
});

document.querySelector('#competition-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());

  if (!payload.competitionId) {
    showToast('Sélectionnez une compétition à modifier.', 'error');
    return;
  }

  try {
    await request(`/api/competitions/${payload.competitionId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    resetCompetitionEditState({ focusEditSelect: true });
    await refresh();
    setCompetitionMode('edit');
    showToast('Compétition mise à jour.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#competition-delete-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const competitionId = document.querySelector('#competition-delete-select').value;
  const competition = competitionsState.find((item) => item.id === competitionId);
  const passwordInput = document.querySelector('#competition-delete-password');
  const password = String(passwordInput?.value ?? '');

  if (!competitionId) {
    showToast('Sélectionnez une compétition à supprimer.', 'error');
    return;
  }

  if (!competition) {
    showToast('Compétition introuvable.', 'error');
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'Supprimer cette compétition ?',
    message: `La compétition "${competition.name}" sera supprimée définitivement. Cette action est irréversible.`,
    confirmLabel: 'Oui, supprimer',
    cancelLabel: 'Annuler'
  });

  if (!confirmed) {
    return;
  }

  try {
    await request(`/api/competitions/${competitionId}`, {
      method: 'DELETE',
      body: JSON.stringify({ password })
    });
    if (passwordInput) {
      passwordInput.value = '';
    }
    await refresh();
    setCompetitionMode('delete');
    showToast('Compétition supprimée.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#judge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);

  try {
    await request('/api/judges', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    formElement.reset();
    await refresh();
    showToast('Juge enregistré.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#judge-delete-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const judgeId = document.querySelector('#judge-delete-select').value;

  if (!judgeId) {
    showToast('Sélectionnez un juge à supprimer.', 'error');
    return;
  }

  try {
    await request(`/api/judges/${judgeId}`, {
      method: 'DELETE'
    });
    await refresh();
    showToast('Juge supprimé.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#judges')?.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const editJudgeId = target.dataset.judgeEdit;

  if (editJudgeId) {
    const judge = judgesState.find((item) => item.id === editJudgeId);

    if (!judge) {
      showToast('Juge introuvable.', 'error');
      return;
    }

    openJudgeEditDialog(judge);
    return;
  }

  const judgeId = target.dataset.judgeToggle;

  if (!judgeId) {
    return;
  }

  const nextIsActive = target.dataset.judgeNextActive === '1';

  try {
    target.disabled = true;
    await request(`/api/judges/${judgeId}/activity`, {
      method: 'POST',
      body: JSON.stringify({ isActive: nextIsActive })
    });
    await refresh();
    showToast(nextIsActive ? 'Juge réactivé.' : 'Juge désactivé.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    target.disabled = false;
  }
});

document.querySelector('#competitor-import-file').addEventListener('change', async (event) => {
  const [file] = event.currentTarget.files ?? [];

  if (!file) {
    clearCompetitorManagementImport();
    await renderCompetitorManagementSection();
    return;
  }

  try {
    competitorManagementState.importState = await parseCompetitionCompetitorWorkbook(file);
    renderCompetitorManagementImportPanel(
      competitionsState.find((competition) => competition.id === competitorManagementState.competitionId) ?? null,
      competitorManagementState.competitors
    );
    showToast('Classeur Excel chargé.', 'success');
  } catch (error) {
    clearCompetitorManagementImport();
    await renderCompetitorManagementSection();
    showToast(error.message, 'error');
  }
});

document.querySelector('#competitor-import-reset').addEventListener('click', async () => {
  clearCompetitorManagementImport();
  await renderCompetitorManagementSection();
});

document.querySelector('#competitor-import-submit').addEventListener('click', async () => {
  try {
    await importCompetitorsForSelectedCompetition();
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#statistics-open-ranking')?.addEventListener('click', () => {
  const activeCompetition = competitionsState.find((competition) => competition.status === 'active') ?? null;

  if (!activeCompetition) {
    showToast('Aucune compétition active.', 'error');
    return;
  }

  const popup = openCompetitionResultsWindow({
    competitionId: activeCompetition.id,
    view: 'ranking'
  });

  if (!popup) {
    showToast('Le navigateur a bloque l\'ouverture de la fenetre de resultats.', 'error');
    return;
  }

  showToast('Fenetre classement ouverte.', 'success');
});

document.querySelector('#statistics-open-podium')?.addEventListener('click', () => {
  const activeCompetition = competitionsState.find((competition) => competition.status === 'active') ?? null;

  if (!activeCompetition) {
    showToast('Aucune compétition active.', 'error');
    return;
  }

  const popup = openCompetitionResultsWindow({
    competitionId: activeCompetition.id,
    view: 'podium'
  });

  if (!popup) {
    showToast('Le navigateur a bloque l\'ouverture de la fenetre de resultats.', 'error');
    return;
  }

  showToast('Fenetre podium ouverte.', 'success');
});

document.querySelector('#statistics-open-individual')?.addEventListener('click', () => {
  const activeCompetition = competitionsState.find((competition) => competition.status === 'active') ?? null;

  if (!activeCompetition) {
    showToast('Aucune compétition active.', 'error');
    return;
  }

  const popup = openIndividualStatisticsWindow({
    competitionId: activeCompetition.id
  });

  if (!popup) {
    showToast('Le navigateur a bloque l\'ouverture de la fenetre de statistiques.', 'error');
    return;
  }

  showToast('Fenetre statistiques individuelles ouverte.', 'success');
});

document.querySelector('#statistics-other-competition-select')?.addEventListener('change', (event) => {
  const target = event.currentTarget;

  if (!(target instanceof HTMLSelectElement)) {
    return;
  }

  statisticsOtherCompetitionId = String(target.value ?? '').trim();
  renderStatisticsSection();
});

document.querySelector('#statistics-other-open-ranking')?.addEventListener('click', () => {
  const competitionId = String(statisticsOtherCompetitionId ?? '').trim();
  const selectedCompetition = competitionsState.find((competition) => competition.id === competitionId) ?? null;

  if (!selectedCompetition) {
    showToast('Sélectionnez une compétition.', 'error');
    return;
  }

  const popup = openCompetitionResultsWindow({
    competitionId: selectedCompetition.id,
    view: 'ranking'
  });

  if (!popup) {
    showToast('Le navigateur a bloque l\'ouverture de la fenetre de resultats.', 'error');
    return;
  }

  showToast('Fenetre classement ouverte.', 'success');
});

document.querySelector('#statistics-other-open-podium')?.addEventListener('click', () => {
  const competitionId = String(statisticsOtherCompetitionId ?? '').trim();
  const selectedCompetition = competitionsState.find((competition) => competition.id === competitionId) ?? null;

  if (!selectedCompetition) {
    showToast('Sélectionnez une compétition.', 'error');
    return;
  }

  const popup = openCompetitionResultsWindow({
    competitionId: selectedCompetition.id,
    view: 'podium'
  });

  if (!popup) {
    showToast('Le navigateur a bloque l\'ouverture de la fenetre de resultats.', 'error');
    return;
  }

  showToast('Fenetre podium ouverte.', 'success');
});

document.querySelector('#settings-action-bar')?.addEventListener('click', (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const action = target.dataset.settingsAction;

  if (!action) {
    return;
  }

  if (action === 'access' && !canCurrentUserManageAccess()) {
    showToast('Accès réservé à l\'admin.', 'error');
    return;
  }

  if (action === 'archive' && !canCurrentUserManageArchive()) {
    showToast('Archivage réservé à l\'admin.', 'error');
    return;
  }

  if (action === 'criteria') {
    openScoringSettingsPanel('criteria');
    return;
  }

  if (action === 'access') {
    openScoringSettingsPanel('access');
    return;
  }

  if (action === 'archive') {
    openScoringSettingsPanel('archive');
    return;
  }

  showToast('Ce sous-écran sera disponible prochainement.', 'success');
});

document.querySelector('#settings-criteria-grid')?.addEventListener('change', (event) => {
  scoringSettingsState.selectedGridKey = event.currentTarget.value;
  renderScoringCriteriaTable();
});

document.querySelector('#settings-criteria-create')?.addEventListener('click', async () => {
  const gridKey = document.querySelector('#settings-criteria-grid')?.value ?? '';
  const label = document.querySelector('#settings-criteria-new-label')?.value ?? '';
  const sortOrder = document.querySelector('#settings-criteria-new-order')?.value ?? '';

  if (!gridKey) {
    showToast('Sélectionnez une grille.', 'error');
    return;
  }

  if (!String(label).trim()) {
    showToast('Le libellé du critère est obligatoire.', 'error');
    return;
  }

  try {
    await request('/api/scoring/criteria', {
      method: 'POST',
      body: JSON.stringify({
        gridKey,
        label,
        sortOrder: sortOrder ? Number(sortOrder) : null
      })
    });
    document.querySelector('#settings-criteria-new-label').value = '';
    document.querySelector('#settings-criteria-new-order').value = '';
    await refreshScoringSettings();
    openScoringSettingsPanel('criteria');
    showToast('Critère créé avec révision de grille.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#settings-criteria-table')?.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const criterionId = target.dataset.settingsEditCriterion;

  if (!criterionId) {
    return;
  }

  const criterion = scoringSettingsState.criteria.find((item) => item.id === criterionId);

  if (!criterion) {
    showToast('Critère introuvable.', 'error');
    return;
  }

  const nextLabel = await showInputDialog({
    title: 'Modifier un critère',
    message: 'Mettez à jour le libellé du critère. Cette action crée une nouvelle révision de grille.',
    fieldLabel: 'Libellé du critère',
    initialValue: criterion.label,
    confirmLabel: 'Créer la révision',
    cancelLabel: 'Annuler'
  });

  if (nextLabel === null) {
    return;
  }

  if (!nextLabel.trim()) {
    showToast('Le libellé du critère est obligatoire.', 'error');
    return;
  }

  try {
    await request(`/api/scoring/criteria/${criterionId}`, {
      method: 'PUT',
      body: JSON.stringify({ label: nextLabel.trim() })
    });
    await refreshScoringSettings();
    openScoringSettingsPanel('criteria');
    showToast('Critère révisé avec nouvelle version de grille.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#settings-access-refresh')?.addEventListener('click', async () => {
  try {
    await refreshScoringSettings();
    openScoringSettingsPanel('access');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#settings-access-action-bar')?.addEventListener('click', (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const action = target.dataset.accessPanelAction;

  if (!action) {
    return;
  }

  accessState.settingsAction = action;

  if (action === 'create') {
    resetAccessAccountForm();
  }

  renderAccessSettingsPanel();
});

document.querySelector('#settings-access-logout')?.addEventListener('click', async () => {
  await performSettingsLogout();
});

document.querySelector('#settings-action-logout')?.addEventListener('click', async () => {
  await performSettingsLogout();
});

document.querySelector('#settings-access-reset')?.addEventListener('click', () => {
  resetAccessAccountForm();
  accessState.settingsAction = 'create';
  renderAccessSettingsPanel();
});

document.querySelector('#settings-access-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const accountId = document.querySelector('#settings-access-account-id')?.value ?? '';
  const firstName = document.querySelector('#settings-access-first-name')?.value ?? '';
  const lastName = document.querySelector('#settings-access-last-name')?.value ?? '';
  const login = document.querySelector('#settings-access-login')?.value ?? '';
  const password = document.querySelector('#settings-access-password')?.value ?? '';
  const role = document.querySelector('#settings-access-role')?.value ?? 'scrutateur';
  const isActive = document.querySelector('#settings-access-active')?.value === 'true';

  if (!firstName.trim() || !lastName.trim() || !login.trim()) {
    showToast('Nom, prénom et login sont obligatoires.', 'error');
    return;
  }

  if (!accountId && !password.trim()) {
    showToast('Le compte doit avoir un mot de passe.', 'error');
    return;
  }

  try {
    await request(accountId ? `/api/access/accounts/${accountId}` : '/api/access/accounts', {
      method: accountId ? 'PUT' : 'POST',
      body: JSON.stringify({
        firstName,
        lastName,
        login,
        password,
        role,
        isActive
      })
    });

    resetAccessAccountForm();
    await refreshScoringSettings();
    openScoringSettingsPanel('access');
    showToast(accountId ? 'Compte mis à jour.' : 'Compte créé.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

document.querySelector('#settings-access-table')?.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const editId = target.dataset.accessEditAccount;
  const deleteId = target.dataset.accessDeleteAccount;
  const generateRecoveryId = target.dataset.accessGenerateRecovery;
  const listRecoveryId = target.dataset.accessListRecovery;
  const revokeRecoveryId = target.dataset.accessRevokeRecovery;

  if (editId) {
    const account = accessState.accounts.find((item) => item.id === editId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    fillAccessAccountForm(account);
    accessState.settingsAction = 'create';
    renderAccessSettingsPanel();
    showToast('Compte chargé dans Création.', 'info');
    return;
  }

  if (generateRecoveryId) {
    const account = accessState.accounts.find((item) => item.id === generateRecoveryId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Générer de nouveaux codes ?',
      message: `Les anciens codes actifs de ${account.firstName} ${account.lastName} seront révoqués. Continuer ?`,
      confirmLabel: 'Générer',
      cancelLabel: 'Annuler'
    });

    if (!confirmed) {
      return;
    }

    try {
      const payload = await request(`/api/access/accounts/${generateRecoveryId}/recovery-codes/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ count: 4 })
      });

      renderAccessRecoveryOutput('');
      await refreshScoringSettings();
      openScoringSettingsPanel('access');
      showToast('Codes de récupération générés.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }

    return;
  }

  if (listRecoveryId) {
    const account = accessState.accounts.find((item) => item.id === listRecoveryId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    await toggleAccessRecoveryCodesList(listRecoveryId);

    return;
  }

  if (revokeRecoveryId) {
    const account = accessState.accounts.find((item) => item.id === revokeRecoveryId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    try {
      const payload = await request(`/api/access/accounts/${revokeRecoveryId}/recovery-codes/revoke`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      renderAccessRecoveryOutput(`<p>${escapeHtml(String(payload.revokedCount ?? 0))} code(s) actif(s) révoqué(s) pour ${escapeHtml(account.login)}.</p>`);
      showToast('Codes actifs révoqués.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }

    return;
  }

  if (deleteId) {
    const account = accessState.accounts.find((item) => item.id === deleteId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Supprimer ce compte ?',
      message: `Le compte ${account.firstName} ${account.lastName} (${account.login}) sera supprimé définitivement.`,
      confirmLabel: 'Oui, supprimer',
      cancelLabel: 'Annuler'
    });

    if (!confirmed) {
      return;
    }

    try {
      await request(`/api/access/accounts/${deleteId}`, { method: 'DELETE' });
      await refreshScoringSettings();
      openScoringSettingsPanel('access');
      resetAccessAccountForm();
      showToast('Compte supprimé.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
});

document.querySelector('#settings-access-codes-table')?.addEventListener('click', async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const generateRecoveryId = target.dataset.accessGenerateRecovery;
  const listRecoveryId = target.dataset.accessListRecovery;
  const revokeRecoveryId = target.dataset.accessRevokeRecovery;

  if (!generateRecoveryId && !listRecoveryId && !revokeRecoveryId) {
    return;
  }

  if (generateRecoveryId) {
    const account = accessState.accounts.find((item) => item.id === generateRecoveryId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Générer de nouveaux codes ?',
      message: `Les anciens codes actifs de ${account.firstName} ${account.lastName} seront révoqués. Continuer ?`,
      confirmLabel: 'Générer',
      cancelLabel: 'Annuler'
    });

    if (!confirmed) {
      return;
    }

    try {
      const payload = await request(`/api/access/accounts/${generateRecoveryId}/recovery-codes/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ count: 4 })
      });

      renderAccessRecoveryOutput('');
      await refreshScoringSettings();
      openScoringSettingsPanel('access');
      accessState.settingsAction = 'codes';
      renderAccessSettingsPanel();
      showToast('Codes de récupération générés.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }

    return;
  }

  if (listRecoveryId) {
    const account = accessState.accounts.find((item) => item.id === listRecoveryId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    await toggleAccessRecoveryCodesList(listRecoveryId);

    return;
  }

  if (revokeRecoveryId) {
    const account = accessState.accounts.find((item) => item.id === revokeRecoveryId);

    if (!account) {
      showToast('Compte introuvable.', 'error');
      return;
    }

    try {
      const payload = await request(`/api/access/accounts/${revokeRecoveryId}/recovery-codes/revoke`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      renderAccessRecoveryOutput(`<p>${escapeHtml(String(payload.revokedCount ?? 0))} code(s) actif(s) révoqué(s) pour ${escapeHtml(account.login)}.</p>`);
      showToast('Codes actifs révoqués.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
});

function buildSqliteFileNameFallback() {
  const date = new Date();
  const timestamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-') + '_' + [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join('-');

  return `pole-scoring-${timestamp}.sqlite`;
}

function parseContentDispositionFileName(value) {
  const source = String(value ?? '');
  const utf8Match = source.match(/filename\*=UTF-8''([^;]+)/i);

  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/\"/g, ''));
    } catch {
    }
  }

  const simpleMatch = source.match(/filename="?([^";]+)"?/i);
  return simpleMatch?.[1] ? simpleMatch[1] : '';
}

function createDialogAbortError() {
  const error = new Error('Opération annulée');
  error.name = 'AbortError';
  return error;
}

async function pickSqliteFileWithFallback() {
  if (typeof window.showOpenFilePicker === 'function') {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [
        {
          description: 'Base SQLite Pole Scoring',
          accept: {
            'application/vnd.sqlite3': ['.sqlite', '.db']
          }
        }
      ]
    });

    const file = await handle.getFile();
    return {
      fileName: file.name,
      file
    };
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sqlite,.db,application/vnd.sqlite3';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      try {
        const file = input.files?.[0];

        if (!file) {
          reject(createDialogAbortError());
          return;
        }

        resolve({
          fileName: file.name,
          file
        });
      } catch (error) {
        reject(error);
      } finally {
        input.remove();
      }
    }, { once: true });

    input.click();
  });
}

const exportButton = document.querySelector('#export-db');

if (exportButton) {
  exportButton.addEventListener('click', async () => {
    const result = document.querySelector('#sync-result');
    const accessToken = getAccessSessionToken();

    try {
      const response = await fetch('/api/db/export', {
        headers: accessToken ? { 'X-Access-Token': accessToken } : undefined
      });

      const contentType = String(response.headers.get('content-type') ?? '');

      if (!response.ok) {
        const rawBody = await response.text();
        let message = rawBody;

        if (contentType.includes('application/json')) {
          try {
            const payload = JSON.parse(rawBody);
            message = payload?.error ?? rawBody;
          } catch {
          }
        }

        throw new Error(message || 'Export SQLite impossible');
      }

      const blob = await response.blob();
      const fileName = parseContentDispositionFileName(response.headers.get('content-disposition'))
        || buildSqliteFileNameFallback();

      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: 'Base SQLite Pole Scoring',
              accept: {
                'application/vnd.sqlite3': ['.sqlite']
              }
            }
          ]
        });

        const writable = await handle.createWritable();
        await writable.write(await blob.arrayBuffer());
        await writable.close();
        const savedFileName = typeof handle.name === 'string' && handle.name
          ? handle.name
          : fileName;
        result.textContent = `Export SQLite réussi: ${savedFileName}.`;
        showToast(`Base exportée: ${savedFileName}`, 'success');
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      result.textContent = `Export SQLite déclenché: ${fileName}.`;
      showToast(`Base exportée: ${fileName}`, 'success');
    } catch (error) {
      if (error?.name === 'AbortError') {
        result.textContent = 'Export annulé.';
        return;
      }

      result.textContent = error.message;
      showToast(error.message, 'error');
    }
  });
}

const importButton = document.querySelector('#import-db');

if (importButton) {
  importButton.addEventListener('click', async () => {
  const result = document.querySelector('#sync-result');
    const accessToken = getAccessSessionToken();

  try {
      const confirmed = await showConfirmDialog({
        title: 'Importer une base SQLite ?',
        message: 'La base locale actuelle sera remplacée par le fichier sélectionné.',
        confirmLabel: 'Importer',
        cancelLabel: 'Annuler'
      });

      if (!confirmed) {
        return;
      }

      const { fileName, file } = await pickSqliteFileWithFallback();

      const response = await fetch('/api/db/import', {
        method: 'POST',
        headers: {
          ...(accessToken ? { 'X-Access-Token': accessToken } : {}),
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? 'Import SQLite impossible');
      }

      result.textContent = `Import SQLite réussi depuis ${fileName}.`;
      showToast(`Base importée: ${fileName}`, 'success');
    await refresh();
  } catch (error) {
    if (error?.name === 'AbortError') {
      result.textContent = 'Import annulé.';
      return;
    }

    result.textContent = error.message;
    showToast(error.message, 'error');
  }
  });
}

const archiveButton = document.querySelector('#archive-db');
const archiveRestoreSelect = document.querySelector('#archive-restore-select');
const archiveRestoreRefreshButton = document.querySelector('#archive-restore-refresh');
const archiveRestoreDownloadButton = document.querySelector('#archive-restore-download');
const archiveRestoreButton = document.querySelector('#archive-restore-db');

if (archiveRestoreSelect) {
  archiveRestoreSelect.addEventListener('change', () => {
    setArchiveRestoreButtonsState();
  });
}

if (archiveRestoreRefreshButton) {
  archiveRestoreRefreshButton.addEventListener('click', async () => {
    await refreshArchiveCatalog();
  });
}

if (archiveRestoreDownloadButton) {
  archiveRestoreDownloadButton.addEventListener('click', async () => {
    const selectedArchive = String(archiveRestoreSelect?.value ?? '').trim();
    const result = getArchiveResultNode();
    const accessToken = getAccessSessionToken();

    if (!selectedArchive) {
      showToast('Sélectionnez une archive.', 'error');
      return;
    }

    try {
      const response = await fetch(`/api/db/archive/download?name=${encodeURIComponent(selectedArchive)}`, {
        headers: accessToken ? { 'X-Access-Token': accessToken } : undefined
      });
      const contentType = String(response.headers.get('content-type') ?? '');

      if (!response.ok) {
        const rawBody = await response.text();
        let message = rawBody;

        if (contentType.includes('application/json')) {
          try {
            const payload = JSON.parse(rawBody);
            message = payload?.error ?? rawBody;
          } catch {
          }
        }

        throw new Error(message || 'Téléchargement impossible');
      }

      const blob = await response.blob();
      const fileName = parseContentDispositionFileName(response.headers.get('content-disposition')) || selectedArchive;

      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: 'Archive SQLite Pole Scoring',
              accept: {
                'application/vnd.sqlite3': ['.sqlite']
              }
            }
          ]
        });

        const writable = await handle.createWritable();
        await writable.write(await blob.arrayBuffer());
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      if (result) {
        result.textContent = `Archive téléchargée: ${fileName}.`;
      }

      showToast(`Archive téléchargée: ${fileName}`, 'success');
    } catch (error) {
      if (result) {
        result.textContent = error.message;
      }

      showToast(error.message, 'error');
    }
  });
}

if (archiveRestoreButton) {
  archiveRestoreButton.addEventListener('click', async () => {
    const selectedArchive = String(archiveRestoreSelect?.value ?? '').trim();
    const result = getArchiveResultNode();
    const accessToken = getAccessSessionToken();

    if (!selectedArchive) {
      showToast('Sélectionnez une archive.', 'error');
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Réintégrer cette archive ?',
      message: `Les données de l'archive ${selectedArchive} seront fusionnées dans la base actuelle.`,
      confirmLabel: 'Réintégrer',
      cancelLabel: 'Annuler'
    });

    if (!confirmed) {
      return;
    }

    try {
      const downloadResponse = await fetch(`/api/db/archive/download?name=${encodeURIComponent(selectedArchive)}`, {
        headers: accessToken ? { 'X-Access-Token': accessToken } : undefined
      });
      const downloadContentType = String(downloadResponse.headers.get('content-type') ?? '');

      if (!downloadResponse.ok) {
        const rawBody = await downloadResponse.text();
        let message = rawBody;

        if (downloadContentType.includes('application/json')) {
          try {
            const payload = JSON.parse(rawBody);
            message = payload?.error ?? rawBody;
          } catch {
          }
        }

        throw new Error(message || 'Lecture d\'archive impossible');
      }

      const archiveBlob = await downloadResponse.blob();
      const restoreResponse = await fetch('/api/db/archive/restore', {
        method: 'POST',
        headers: {
          ...(accessToken ? { 'X-Access-Token': accessToken } : {}),
          'Content-Type': 'application/octet-stream'
        },
        body: archiveBlob
      });

      const payload = await restoreResponse.json();

      if (!restoreResponse.ok) {
        throw new Error(payload.error ?? 'Réintégration impossible');
      }

      if (result) {
        const insertedCompetitions = Number(payload?.insertedRows?.competitions ?? 0);
        result.textContent = `Archive réintégrée: ${selectedArchive}. ${insertedCompetitions} compétition(s) ajoutée(s).`;
      }

      showToast(`Archive réintégrée: ${selectedArchive}`, 'success');
      await refresh();
    } catch (error) {
      if (result) {
        result.textContent = error.message;
      }

      showToast(error.message, 'error');
    }
  });
}

if (archiveButton) {
  archiveButton.addEventListener('click', async () => {
    const keepSelect = document.querySelector('#archive-keep-seasons');
    const result = getArchiveResultNode();
    const keepSeasons = Number.parseInt(String(keepSelect?.value ?? '3'), 10) || 3;

    const confirmed = await showConfirmDialog({
      title: 'Archiver les anciennes saisons ?',
      message: `Seules les ${keepSeasons} dernières saisons seront conservées. Cette action est irréversible.`,
      confirmLabel: 'Archiver',
      cancelLabel: 'Annuler'
    });

    if (!confirmed) {
      return;
    }

    try {
      const response = await request('/api/db/archive', {
        method: 'POST',
        body: JSON.stringify({ keepSeasons })
      });
      const purgedCompetitions = Number(response.purgedCompetitions ?? response.archivedCompetitions ?? 0);

      if (result) {
        result.textContent = `Archivage terminé: ${purgedCompetitions} compétition(s) supprimée(s), ${response.removedOrphanAthletes} athlète(s) orphelin(s) nettoyé(s).`;
      }
      showToast(`Archivage terminé (${purgedCompetitions} compétition(s)).`, 'success');
      await refresh();
    } catch (error) {
      if (result) {
        result.textContent = error.message;
      }

      showToast(error.message, 'error');
    }
  });
}

async function ensureAccessLoginAtStartup() {
  if (accessState.currentAccount) {
    syncAccessDrivenNavigation();
    return true;
  }

  const mode = accessState.hasAccounts ? 'login' : 'bootstrap';
  const session = await openAccessAuthDialog(mode, { mandatory: true });

  if (!session?.account) {
    return false;
  }

  saveAccessSession(session);
  await refreshAccessState();
  await enforcePasswordChangeIfRequired(session);
  return true;
}

ensureConductorJudgePresencePolling();
ensureConductorTabletSyncPolling();

setCompetitionMode('create');

(async () => {
  try {
    await refresh();
    await ensureAccessLoginAtStartup();
    await refresh();
    setActiveSection('dashboard');
  } catch (error) {
    showToast(error.message, 'error');
  }
})();