async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
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
    throw new Error(payload?.error ?? 'Erreur API');
  }

  return payload ?? {};
}

const judgeStorage = {
  competitionId: 'pole-scoring.judge.competitionId',
  judgeId: 'pole-scoring.judge.judgeId'
};

let singleActiveCompetitionId = '';

const state = {
  competitionId: '',
  judgeId: '',
  judgeLogin: '',
  judgeName: '',
  judgeRole: '',
  isTrainee: false,
  scoringProfile: null,
  activePassageId: '',
  activeCriteria: [],
  activeCriterionPrefix: '',
  selectedScoresByCriterion: new Map(),
  scorecardLocked: false,
  scoreCommentDraft: '',
  headPenaltyDraft: [{ score: '', comment: '' }],
  scoreHistoryEntries: [],
  finalizedPassageIds: new Set(),
  draftSaveQueue: Promise.resolve(),
  isConnected: false,
  isAuthorized: false,
  activeScoringTab: 'notation',
  scoringTabsBound: false,
  headPenaltyEventsBound: false,
  secondaryTabRenderKey: '',
  alertOpen: false,
  heartbeatTimer: null,
  dispatchTimer: null
};

function isHeadJudge() {
  return String(state.judgeRole ?? '').trim().toLowerCase() === 'head';
}

function clearAuthCredentialInputs() {
  const loginInput = document.querySelector('#judge-login');
  const passwordInput = document.querySelector('#judge-password');

  if (loginInput) {
    loginInput.value = '';
    loginInput.defaultValue = '';
  }

  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.defaultValue = '';
  }
}

function enforceEmptyAuthCredentialsOnOpen() {
  clearAuthCredentialInputs();

  // Some browsers/password managers can refill fields after first paint.
  window.requestAnimationFrame(() => {
    clearAuthCredentialInputs();
  });

  window.setTimeout(() => {
    clearAuthCredentialInputs();
  }, 180);
}

function getSecondaryTabLabel() {
  return isHeadJudge() ? 'Pénalités' : 'Commentaires';
}

function formatCompactScore(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '0';
  }

  const hasDecimal = Math.abs(parsed - Math.round(parsed)) > 1e-9;
  return (hasDecimal ? parsed.toFixed(1) : parsed.toFixed(0)).replace('.', ',');
}

function formatDetailedScore(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '--';
  }

  return parsed.toFixed(2).replace('.', ',');
}

function createEmptyHeadPenaltyItem() {
  return { score: '', comment: '' };
}

function parseFlexibleDecimal(value) {
  const normalizedValue = String(value ?? '').trim().replace(',', '.');

  if (!normalizedValue) {
    return Number.NaN;
  }

  return Number(normalizedValue);
}

function getNormalizedHeadPenaltyItems(items = state.headPenaltyDraft) {
  if (!Array.isArray(items) || items.length === 0) {
    return [createEmptyHeadPenaltyItem()];
  }

  return items.map((item) => ({
    score: String(item?.score ?? '').trim(),
    comment: String(item?.comment ?? '').trim()
  }));
}

function getHeadPenaltyAggregate(items = state.headPenaltyDraft) {
  const normalizedItems = getNormalizedHeadPenaltyItems(items);
  const total = normalizedItems.reduce((sum, item) => {
    const parsed = parseFlexibleDecimal(item.score);
    return Number.isFinite(parsed) && parsed > 0 ? sum + parsed : sum;
  }, 0);
  const comment = normalizedItems
    .filter((item) => item.score || item.comment)
    .map((item) => `${item.score || '0'} | ${item.comment}`.trim())
    .join('\n');

  return {
    items: normalizedItems,
    total,
    comment
  };
}

function deserializeHeadPenaltyDraft({ score = '', comment = '' } = {}) {
  const normalizedComment = String(comment ?? '').trim();
  const rawScore = String(score ?? '').trim();

  if (!normalizedComment) {
    return [{ score: rawScore, comment: '' }];
  }

  const items = normalizedComment
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9]+(?:[.,][0-9]+)?)\s*\|\s*(.*)$/);

      if (!match) {
        return null;
      }

      return {
        score: match[1],
        comment: match[2].trim()
      };
    })
    .filter(Boolean);

  if (items.length > 0) {
    return items;
  }

  return [{ score: rawScore, comment: normalizedComment }];
}

function saveHeadPenaltyDraft() {
  const competitorId = String(document.querySelector('#judge-competitor-id').value ?? '').trim();
  const aggregate = getHeadPenaltyAggregate();

  if (!competitorId || (!aggregate.total && !aggregate.comment)) {
    renderScoreTotal();
    return;
  }

  void queueDraftScoreSave({
    criterion: 'penalty:total',
    competitorId,
    score: aggregate.total,
    comment: aggregate.comment
  }).catch((error) => {
    setScoreResult(`Erreur brouillon pénalité: ${error.message}`);
  });

  renderScoreTotal();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildCriterionLabelMap() {
  const map = new Map();

  state.activeCriteria.forEach((criterion) => {
    const key = String(criterion?.criterionKey ?? '').trim();
    const label = String(criterion?.label ?? '').trim();

    if (!key || !label) {
      return;
    }

    map.set(`${state.activeCriterionPrefix}${key}`, label);
  });

  return map;
}

function getHistoryCriterionLabel(criterion, labelMap) {
  const normalizedCriterion = String(criterion ?? '').trim();

  if (!normalizedCriterion) {
    return 'Critère';
  }

  if (normalizedCriterion === 'penalty:total') {
    return 'Pénalité';
  }

  if (normalizedCriterion === 'judge:comment') {
    return 'Commentaire';
  }

  if (labelMap.has(normalizedCriterion)) {
    return labelMap.get(normalizedCriterion);
  }

  if (normalizedCriterion.startsWith('artistic:') || normalizedCriterion.startsWith('technical:')) {
    const key = normalizedCriterion.split(':').slice(1).join(':');
    return key || normalizedCriterion;
  }

  return normalizedCriterion;
}

function updateScoringTabsUi() {
  const notationButton = document.querySelector('#judge-tab-button-notation');
  const secondaryButton = document.querySelector('#judge-tab-button-secondary');
  const historyButton = document.querySelector('#judge-tab-button-history');
  const notationPanel = document.querySelector('#judge-tab-panel-notation');
  const secondaryPanel = document.querySelector('#judge-tab-panel-secondary');
  const historyPanel = document.querySelector('#judge-tab-panel-history');

  if (!notationButton || !secondaryButton || !historyButton || !notationPanel || !secondaryPanel || !historyPanel) {
    return;
  }

  const allowedTabs = new Set(['notation', 'secondary', 'history']);
  const activeTab = allowedTabs.has(state.activeScoringTab) ? state.activeScoringTab : 'notation';
  state.activeScoringTab = activeTab;

  notationButton.classList.toggle('is-active', activeTab === 'notation');
  secondaryButton.classList.toggle('is-active', activeTab === 'secondary');
  historyButton.classList.toggle('is-active', activeTab === 'history');

  notationButton.setAttribute('aria-selected', activeTab === 'notation' ? 'true' : 'false');
  secondaryButton.setAttribute('aria-selected', activeTab === 'secondary' ? 'true' : 'false');
  historyButton.setAttribute('aria-selected', activeTab === 'history' ? 'true' : 'false');

  notationPanel.hidden = activeTab !== 'notation';
  secondaryPanel.hidden = activeTab !== 'secondary';
  historyPanel.hidden = activeTab !== 'history';
}

function setActiveScoringTab(tab) {
  const rawTab = String(tab ?? '').trim();
  const normalizedTab = rawTab === 'secondary' || rawTab === 'history' ? rawTab : 'notation';
  state.activeScoringTab = normalizedTab;
  updateScoringTabsUi();
}

function ensureScoringTabsBinding() {
  if (state.scoringTabsBound) {
    return;
  }

  document.querySelectorAll('[data-judge-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      setActiveScoringTab(button.dataset.judgeTab);
    });
  });

  state.scoringTabsBound = true;
}

function renderSecondaryTabContent() {
  const contentRoot = document.querySelector('#judge-secondary-content');
  const secondaryButton = document.querySelector('#judge-tab-button-secondary');

  if (!contentRoot || !secondaryButton) {
    return;
  }

  const role = String(state.judgeRole ?? '').trim().toLowerCase();
  const renderKey = `${role}::${state.isTrainee ? '1' : '0'}`;
  const mustRebuild = state.secondaryTabRenderKey !== renderKey || contentRoot.childElementCount === 0;
  secondaryButton.textContent = getSecondaryTabLabel();

  if (mustRebuild) {
    if (isHeadJudge()) {
      contentRoot.innerHTML = `
        <section class="judge-secondary-card">
          <div id="judge-penalty-list" class="judge-penalty-list"></div>
          <p class="judge-secondary-note">La pénalité est sauvegardée automatiquement dans le brouillon.</p>
        </section>
      `;
      state.headPenaltyEventsBound = false;
    } else {
      contentRoot.innerHTML = `
        <section class="judge-secondary-card">
          
          <label class="judge-secondary-field">
            <span>Commentaire libre</span>
            <textarea id="judge-score-comment" rows="4" placeholder="Commentaire visible au bilan (optionnel)"></textarea>
          </label>
          <p class="judge-secondary-note">Le commentaire est sauvegardé automatiquement dans le brouillon.</p>
        </section>
      `;
    }

    state.secondaryTabRenderKey = renderKey;
  }

  if (isHeadJudge()) {
    syncHeadPenaltyInputsFromState({ bindListeners: mustRebuild });
    return;
  }

  syncJudgeCommentInputFromState({ bindListeners: mustRebuild });
}

function renderJudgeScoreHistory() {
  const listNode = document.querySelector('#judge-history-list');
  const subtitleNode = document.querySelector('#judge-history-subtitle');
  const categoryLabel = String(document.querySelector('#judge-active-category')?.textContent ?? '').trim();

  if (!listNode || !subtitleNode) {
    return;
  }

  subtitleNode.textContent = categoryLabel
    ? `Historique personnel en catégorie ${categoryLabel}`
    : 'Historique personnel de votre secteur';

  if (!Array.isArray(state.scoreHistoryEntries) || state.scoreHistoryEntries.length === 0) {
    listNode.innerHTML = '<p class="judge-history-empty">Aucune note précédente dans cette catégorie.</p>';
    return;
  }

  const criterionLabelMap = buildCriterionLabelMap();
  const headJudge = isHeadJudge();

  listNode.innerHTML = state.scoreHistoryEntries.map((entry) => {
    const competitorLabel = formatCompetitorLabel(entry);
    const runningOrder = String(entry?.runningOrder ?? '').trim() || '-';
    const totalScore = Number(entry?.totalScore);
    const penaltyScore = Number(entry?.penaltyScore);
    const normalizedTotal = Number.isFinite(totalScore) ? totalScore : 0;
    const normalizedPenalty = Number.isFinite(penaltyScore) && penaltyScore > 0 ? penaltyScore : 0;
    const netScore = Math.max(0, normalizedTotal - normalizedPenalty);
    const detailedScores = (Array.isArray(entry?.details) ? entry.details : [])
      .filter((detail) => {
        const criterion = String(detail?.criterion ?? '').trim();
        return criterion.startsWith('artistic:') || criterion.startsWith('technical:');
      });

    const notesRowHtml = detailedScores.length
      ? `<div class="judge-history-notes-row conductor-scores-notes">${detailedScores.map((detail, index) => {
        const label = getHistoryCriterionLabel(detail?.criterion, criterionLabelMap);
        const tooltip = escapeHtml(label);
        const separator = index < detailedScores.length - 1 ? '<span class="conductor-score-separator">|</span>' : '';
        return `<span class="conductor-score-chip" tabindex="0" role="note" data-tooltip="${tooltip}" aria-label="Critère: ${tooltip}">${formatDetailedScore(detail?.score)}</span>${separator}`;
      }).join('')}</div>`
      : '<p class="judge-history-empty">Aucun détail disponible pour ce passage.</p>';

    return `
      <article class="judge-history-item">
        <div class="judge-history-mainline">
          <strong>N° ${runningOrder} · ${competitorLabel}</strong>
          ${notesRowHtml}
        </div>
        <p class="judge-history-summary">${headJudge
          ? `Total brut: ${formatDetailedScore(normalizedTotal)} · Pénalités: -${formatDetailedScore(normalizedPenalty)} · Total net: ${formatDetailedScore(netScore)}`
          : `Total: ${formatDetailedScore(normalizedTotal)}`}</p>
      </article>
    `;
  }).join('');
}

async function refreshJudgeScoreHistory(activePassage) {
  const category = String(activePassage?.category ?? '').trim();
  const beforeRunningOrder = Number.parseInt(String(activePassage?.runningOrder ?? '').trim(), 10);

  if (!category || !Number.isFinite(beforeRunningOrder) || !state.competitionId || !state.judgeId) {
    state.scoreHistoryEntries = [];
    renderJudgeScoreHistory();
    return;
  }

  const payload = await request(
    `/api/judge-score-history?competitionId=${encodeURIComponent(state.competitionId)}&judgeId=${encodeURIComponent(state.judgeId)}&category=${encodeURIComponent(category)}&beforeRunningOrder=${encodeURIComponent(beforeRunningOrder)}&limit=24`
  );

  state.scoreHistoryEntries = Array.isArray(payload) ? payload : [];
  renderJudgeScoreHistory();
}

function showJudgeAlertModal({ title = 'Information', message = '' } = {}) {
  const root = document.querySelector('#judge-alert-dialog');
  const titleNode = document.querySelector('#judge-alert-title');
  const messageNode = document.querySelector('#judge-alert-message');
  const okButton = document.querySelector('#judge-alert-ok');

  if (!root || !titleNode || !messageNode || !okButton) {
    return Promise.resolve();
  }

  if (state.alertOpen) {
    return Promise.resolve();
  }

  state.alertOpen = true;
  titleNode.textContent = title;
  messageNode.textContent = message;
  root.hidden = false;

  return new Promise((resolve) => {
    const handleClose = () => {
      okButton.removeEventListener('click', handleClose);
      root.hidden = true;
      state.alertOpen = false;
      resolve();
    };

    okButton.addEventListener('click', handleClose, { once: true });
    okButton.focus();
  });
}

function renderOptions(target, items, labelBuilder, placeholder) {
  const options = items.map((item) => `<option value="${item.id}">${labelBuilder(item)}</option>`).join('');
  target.innerHTML = `<option value="" selected>${placeholder}</option>${options}`;
}

function getJudgeAuthMissingFields() {
  const competitionId = document.querySelector('#judge-competition').value.trim();
  const login = document.querySelector('#judge-login').value.trim();
  const password = document.querySelector('#judge-password').value;
  const missingFields = [];

  if (!competitionId) {
    missingFields.push({ label: 'Compétition', selector: '#judge-competition' });
  }

  if (!login) {
    missingFields.push({ label: 'Login', selector: '#judge-login' });
  }

  if (!password) {
    missingFields.push({ label: 'Mot de passe', selector: '#judge-password' });
  }

  return missingFields;
}

async function validateJudgeAuthForm() {
  const missingFields = getJudgeAuthMissingFields();

  if (!missingFields.length) {
    return true;
  }

  const labels = missingFields.map((field) => field.label);
  const fieldList = labels.join(', ');
  const message = labels.length === 1
    ? `Veuillez renseigner le champ suivant : ${fieldList}.`
    : `Veuillez renseigner les champs suivants : ${fieldList}.`;

  await showJudgeAlertModal({
    title: 'Champs manquants',
    message
  });

  const firstMissingField = document.querySelector(missingFields[0].selector);
  firstMissingField?.focus();
  return false;
}

function formatFrenchDate(value) {
  if (!value) {
    return 'Date non définie';
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return String(value);
  }

  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}

function setJudgeHeaderName(value) {
  const node = document.querySelector('#judge-connected-name');
  if (!node) {
    return;
  }
  node.textContent = value || 'Non connecté';
}

function setJudgeCompetitionHeader(competition = null) {
  const titleNode = document.querySelector('#judge-competition-title');
  const locationNode = document.querySelector('#judge-competition-location');

  if (!titleNode || !locationNode) {
    return;
  }

  if (!competition) {
    titleNode.textContent = 'POLE DANCE - JUGEMENT PAR TABLETTE';
    locationNode.textContent = '';
    return;
  }

  titleNode.textContent = String(competition?.name ?? '').trim() || 'Compétition active';
  locationNode.textContent = String(competition?.location ?? '').trim();
}

function formatJudgeRoleLabel(role) {
  if (role === 'artistique') {
    return 'Jugement artistique';
  }

  if (role === 'technique') {
    return 'Jugement technique';
  }

  if (role === 'head') {
    return 'Head Judge';
  }

  return 'Secteur non défini';
}

function setJudgeSectorBadge({ role = '', isTrainee = false } = {}) {
  const badge = document.querySelector('#judge-sector-badge');

  if (!badge) {
    return;
  }

  badge.classList.remove('is-artistic', 'is-technical', 'is-head', 'is-shadow', 'is-neutral');

  const normalizedRole = String(role ?? '').trim().toLowerCase();

  if (isTrainee) {
    badge.classList.add('is-shadow');
    badge.textContent = `Shadow · ${formatJudgeRoleLabel(normalizedRole)}`;
    return;
  }

  if (normalizedRole === 'artistique') {
    badge.classList.add('is-artistic');
  } else if (normalizedRole === 'technique') {
    badge.classList.add('is-technical');
  } else if (normalizedRole === 'head') {
    badge.classList.add('is-head');
  } else {
    badge.classList.add('is-neutral');
  }

  badge.textContent = formatJudgeRoleLabel(normalizedRole);
}

function setScoreResult(message = '') {
  const node = document.querySelector('#score-result');

  if (!node) {
    return;
  }

  node.textContent = message;
}

function renderScoreTotal() {
  const totalNode = document.querySelector('#judge-score-total');

  if (!totalNode) {
    return;
  }

  const rawTotal = [...state.selectedScoresByCriterion.values()].reduce((acc, value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? acc + parsed : acc;
  }, 0);

  if (isHeadJudge()) {
    const aggregate = getHeadPenaltyAggregate();
    const net = Math.max(0, rawTotal - aggregate.total);
    totalNode.textContent = `Total brut: ${formatDetailedScore(rawTotal)} · Pénalité: -${formatDetailedScore(aggregate.total)} · Net: ${formatDetailedScore(net)}`;
    return;
  }

  totalNode.textContent = `Total: ${formatDetailedScore(rawTotal)}`;
}

function syncHeadPenaltyInputsFromState({ bindListeners = false } = {}) {
  const listRoot = document.querySelector('#judge-penalty-list');

  if (!listRoot) {
    return;
  }

  state.headPenaltyDraft = getNormalizedHeadPenaltyItems();

  const activeElement = document.activeElement;
  const activeScoreIndex = activeElement instanceof HTMLElement ? activeElement.getAttribute('data-penalty-score') : null;
  const activeCommentIndex = activeElement instanceof HTMLElement ? activeElement.getAttribute('data-penalty-comment') : null;
  const shouldRebuild = bindListeners || listRoot.childElementCount !== state.headPenaltyDraft.length;

  if (shouldRebuild) {
    listRoot.innerHTML = state.headPenaltyDraft.map((item, index) => `
      <div class="judge-penalty-row" data-penalty-index="${index}">
        <label class="judge-secondary-field judge-secondary-field-compact">
          <span>Pénalité</span>
          <input
            class="judge-penalty-score"
            data-penalty-score="${index}"
            type="text"
            inputmode="decimal"
            placeholder="0"
            value="${escapeHtml(item.score)}"
          >
        </label>
        <label class="judge-secondary-field judge-secondary-field-compact judge-penalty-comment-field">
          <span>Motif</span>
          <input
            class="judge-penalty-comment"
            data-penalty-comment="${index}"
            type="text"
            placeholder="Motif de la pénalité"
            value="${escapeHtml(item.comment)}"
          >
        </label>
        <div class="judge-penalty-actions">
          <button
            class="ghost-button judge-penalty-add"
            data-add-penalty="${index}"
            type="button"
            aria-label="Ajouter une pénalité"
          >+</button>
          <button
            class="ghost-button judge-penalty-remove"
            data-remove-penalty="${index}"
            type="button"
            aria-label="Supprimer cette pénalité"
            ${state.headPenaltyDraft.length <= 1 ? 'hidden' : ''}
          >−</button>
        </div>
      </div>
    `).join('');
  } else {
    state.headPenaltyDraft.forEach((item, index) => {
      const scoreInput = listRoot.querySelector(`[data-penalty-score="${index}"]`);
      const commentInput = listRoot.querySelector(`[data-penalty-comment="${index}"]`);
      const removeButton = listRoot.querySelector(`[data-remove-penalty="${index}"]`);

      if (scoreInput && document.activeElement !== scoreInput) {
        scoreInput.value = item.score;
      }

      if (commentInput && document.activeElement !== commentInput) {
        commentInput.value = item.comment;
      }

      if (removeButton) {
        removeButton.hidden = state.headPenaltyDraft.length <= 1;
      }
    });
  }

  if (!bindListeners) {
    if (activeScoreIndex !== null) {
      listRoot.querySelector(`[data-penalty-score="${activeScoreIndex}"]`)?.focus();
    } else if (activeCommentIndex !== null) {
      listRoot.querySelector(`[data-penalty-comment="${activeCommentIndex}"]`)?.focus();
    }
    renderScoreTotal();
    return;
  }

  if (state.headPenaltyEventsBound) {
    renderScoreTotal();
    return;
  }

  listRoot.addEventListener('input', (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const scoreIndex = target.getAttribute('data-penalty-score');
    const commentIndex = target.getAttribute('data-penalty-comment');
    const nextItems = getNormalizedHeadPenaltyItems();

    if (scoreIndex !== null) {
      const index = Number(scoreIndex);
      if (Number.isInteger(index) && nextItems[index]) {
        nextItems[index].score = target.value;
      }
    }

    if (commentIndex !== null) {
      const index = Number(commentIndex);
      if (Number.isInteger(index) && nextItems[index]) {
        nextItems[index].comment = target.value;
      }
    }

    state.headPenaltyDraft = nextItems;
    saveHeadPenaltyDraft();
  });

  listRoot.addEventListener('click', (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const removeIndex = target.getAttribute('data-remove-penalty');
    const addIndex = target.getAttribute('data-add-penalty');

    if (addIndex !== null) {
      const index = Number(addIndex);
      const nextItems = getNormalizedHeadPenaltyItems();
      nextItems.splice(Number.isInteger(index) ? index + 1 : nextItems.length, 0, createEmptyHeadPenaltyItem());
      state.headPenaltyDraft = nextItems;
      syncHeadPenaltyInputsFromState({ bindListeners: false });
      const newIndex = Number.isInteger(index) ? index + 1 : nextItems.length - 1;
      listRoot.querySelector(`[data-penalty-score="${newIndex}"]`)?.focus();
      renderScoreTotal();
      return;
    }

    if (removeIndex === null) {
      return;
    }

    const index = Number(removeIndex);
    const nextItems = getNormalizedHeadPenaltyItems().filter((_, itemIndex) => itemIndex !== index);
    state.headPenaltyDraft = nextItems.length > 0 ? nextItems : [createEmptyHeadPenaltyItem()];
    syncHeadPenaltyInputsFromState({ bindListeners: false });
    saveHeadPenaltyDraft();
  });

  state.headPenaltyEventsBound = true;

  renderScoreTotal();
}

function syncJudgeCommentInputFromState({ bindListeners = false } = {}) {
  const commentInput = document.querySelector('#judge-score-comment');

  if (!commentInput) {
    return;
  }

  if (document.activeElement !== commentInput) {
    commentInput.value = String(state.scoreCommentDraft ?? '');
  }

  if (!bindListeners) {
    return;
  }

  commentInput.addEventListener('input', () => {
    state.scoreCommentDraft = commentInput.value;
    const comment = String(commentInput.value ?? '').trim();

    if (!comment) {
      return;
    }

    void queueDraftScoreSave({
      criterion: 'judge:comment',
      competitorId: String(document.querySelector('#judge-competitor-id').value ?? '').trim(),
      score: 0,
      comment
    }).catch((error) => {
      setScoreResult(`Erreur brouillon commentaire: ${error.message}`);
    });
  });
}

function showWaitingState() {
  const waitingCard = document.querySelector('#judge-waiting-card');
  const scoreForm = document.querySelector('#score-form');

  if (!waitingCard || !scoreForm) {
    return;
  }

  waitingCard.hidden = false;
  scoreForm.hidden = true;
}

function showScoreForm() {
  const waitingCard = document.querySelector('#judge-waiting-card');
  const scoreForm = document.querySelector('#score-form');

  if (!waitingCard || !scoreForm) {
    return;
  }

  waitingCard.hidden = true;
  scoreForm.hidden = false;
  ensureScoringTabsBinding();
  updateScoringTabsUi();
}

function resetDispatchForm() {
  const activePassageNode = document.querySelector('#judge-active-passage');
  const activeCategoryNode = document.querySelector('#judge-active-category');
  const scoreGridNode = document.querySelector('#judge-score-grid');
  const competitorIdNode = document.querySelector('#judge-competitor-id');

  if (activePassageNode) {
    activePassageNode.textContent = 'Passage en attente';
  }

  if (activeCategoryNode) {
    activeCategoryNode.textContent = '';
  }

  if (scoreGridNode) {
    scoreGridNode.innerHTML = '';
  }

  if (competitorIdNode) {
    competitorIdNode.value = '';
  }

  state.activePassageId = '';
  state.activeCriteria = [];
  state.activeCriterionPrefix = '';
  state.selectedScoresByCriterion = new Map();
  state.scorecardLocked = false;
  state.scoreCommentDraft = '';
  state.headPenaltyDraft = [createEmptyHeadPenaltyItem()];
  state.scoreHistoryEntries = [];
  renderSecondaryTabContent();
  renderJudgeScoreHistory();
  renderScoreTotal();
}

function updateConnectedUi() {
  const authForm = document.querySelector('#judge-auth-form');
  const logoutButton = document.querySelector('#judge-logout');
  const waitingCard = document.querySelector('#judge-waiting-card');
  const scoreForm = document.querySelector('#score-form');

  if (!authForm || !waitingCard || !scoreForm) {
    return;
  }

  authForm.hidden = state.isConnected;

  if (logoutButton) {
    logoutButton.hidden = !state.isConnected;
  }

  if (!state.isConnected || !state.isAuthorized) {
    waitingCard.hidden = true;
    scoreForm.hidden = true;
    return;
  }

  // Do not force waiting state here: refreshJudgeDispatchState controls which
  // view is displayed. Forcing waiting causes visual flicker during polling.
  if (!scoreForm.hidden) {
    updateScoringTabsUi();
    return;
  }

  if (waitingCard.hidden) {
    showWaitingState();
  }
}

function hasJudgeFinalizedCurrentPassage(scoreMap) {
  const finalizedValue = Number(scoreMap.get('judge:finalized'));
  return Number.isFinite(finalizedValue) && finalizedValue >= 1;
}

function splitMembers(value) {
  return String(value ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatNameFirstLast(firstName, lastName) {
  const first = String(firstName ?? '').trim();
  const last = String(lastName ?? '').trim();

  if (first && last) {
    return `${first} ${last.toLocaleUpperCase('fr-FR')}`;
  }

  if (first) {
    return first;
  }

  if (last) {
    return last.toLocaleUpperCase('fr-FR');
  }

  return '';
}

function formatCompetitorLabel(competitor) {
  const firstNames = splitMembers(competitor?.firstName);
  const lastNames = splitMembers(competitor?.lastName);
  const memberCount = Math.max(firstNames.length, lastNames.length);

  if (memberCount > 0) {
    const members = Array.from({ length: memberCount }, (_, index) => formatNameFirstLast(firstNames[index], lastNames[index]))
      .filter(Boolean);

    if (members.length > 0) {
      return members.join(' & ');
    }
  }

  const stageName = String(competitor?.stageName ?? '').trim();
  return stageName || 'Compétiteur';
}

function isDuoCompetitor(competitor) {
  if (Array.isArray(competitor?.members) && competitor.members.length > 1) {
    return true;
  }

  return String(competitor?.stageName ?? '').includes('/');
}

function normalizeCriteria(criteria) {
  return (criteria ?? [])
    .filter((criterion) => criterion?.isEnabled)
    .slice()
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
}

function getJudgeScoringConfig(activePassage) {
  const profile = state.scoringProfile;

  if (!profile) {
    return null;
  }

  const duo = isDuoCompetitor(activePassage);
  const role = String(state.judgeRole ?? '').trim().toLowerCase();
  const scoringVersion = role === 'artistique'
    ? (duo ? profile.artisticDuo : profile.artisticSolo)
    : (duo ? profile.technicalDuo : profile.technicalSolo);

  if (!scoringVersion) {
    return null;
  }

  const criterionPrefix = role === 'artistique' ? 'artistic:' : 'technical:';

  return {
    criterionPrefix,
    criteria: normalizeCriteria(scoringVersion.criteria),
    scoreMin: Number(scoringVersion.scoreMin ?? 0),
    scoreMax: Number(scoringVersion.scoreMax ?? 5),
    scoreStep: Number(scoringVersion.scoreStep ?? 0.5)
  };
}

function buildScoreValues({ scoreMin, scoreMax, scoreStep }) {
  const min = Number.isFinite(scoreMin) ? scoreMin : 0;
  const max = Number.isFinite(scoreMax) ? scoreMax : 5;
  const step = Number.isFinite(scoreStep) && scoreStep > 0 ? scoreStep : 0.5;
  const values = [];

  for (let value = min; value <= max + 1e-9; value += step) {
    values.push(Number(value.toFixed(4)));
  }

  return values;
}

function formatScoreOptionLabel(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '0';
  }

  const hasDecimal = Math.abs(parsed - Math.round(parsed)) > 1e-9;
  return (hasDecimal ? parsed.toFixed(1) : parsed.toFixed(0)).replace('.', ',');
}

function formatPassageHeading(activePassage) {
  const order = String(activePassage?.runningOrder ?? '-').trim();
  return `N° ${order} · ${formatCompetitorLabel(activePassage)}`;
}

function applyScoreSelectionStyles() {
  const gridRoot = document.querySelector('#judge-score-grid');

  if (!gridRoot) {
    return;
  }

  gridRoot.querySelectorAll('[data-score-choice]').forEach((button) => {
    const criterion = String(button.dataset.criterion ?? '').trim();
    const value = Number(button.dataset.value);
    const selected = Number(state.selectedScoresByCriterion.get(criterion));
    const isSelected = Number.isFinite(selected) && Math.abs(selected - value) <= 1e-9;
    button.classList.toggle('is-selected', isSelected);
  });

  renderScoreTotal();
}

function queueDraftScoreSave({ competitorId, criterionKey, criterion, score, comment = '' }) {
  if (!competitorId || !state.competitionId || !state.judgeId) {
    return Promise.resolve();
  }

  const resolvedCriterion = String(criterion ?? `${state.activeCriterionPrefix}${criterionKey}`).trim();

  state.draftSaveQueue = state.draftSaveQueue
    .catch(() => {
      // Preserve the queue chain even after a previous failure.
    })
    .then(async () => {
      await request('/api/judge-score-draft', {
        method: 'POST',
        body: JSON.stringify({
          competitionId: state.competitionId,
          competitorId,
          judgeId: state.judgeId,
          criterion: resolvedCriterion,
          score,
          comment
        })
      });
    });

  return state.draftSaveQueue;
}

function renderScoreGrid({ activePassage, prefilledScores = new Map() }) {
  const scoreGridRoot = document.querySelector('#judge-score-grid');
  const submitButton = document.querySelector('#judge-submit-scorecard');
  const passageNode = document.querySelector('#judge-active-passage');
  const categoryNode = document.querySelector('#judge-active-category');
  const config = getJudgeScoringConfig(activePassage);

  if (!scoreGridRoot || !submitButton || !passageNode || !categoryNode) {
    return;
  }

  if (!config || !config.criteria.length) {
    scoreGridRoot.innerHTML = '<p class="judge-score-empty">Aucune grille active disponible pour votre secteur.</p>';
    submitButton.disabled = true;
    return;
  }

  const scoreValues = buildScoreValues(config);
  state.activeCriteria = config.criteria;
  state.activeCriterionPrefix = config.criterionPrefix;
  state.selectedScoresByCriterion = new Map();
  state.scorecardLocked = false;

  config.criteria.forEach((criterion) => {
    const fullCriterion = `${config.criterionPrefix}${criterion.criterionKey}`;
    const existingValue = Number(prefilledScores.get(fullCriterion));
    const defaultValue = Number.isFinite(existingValue) ? existingValue : 0;
    state.selectedScoresByCriterion.set(criterion.criterionKey, defaultValue);
  });

  passageNode.textContent = formatPassageHeading(activePassage);
  categoryNode.textContent = String(activePassage?.category ?? '').trim();

  scoreGridRoot.innerHTML = `
    <div class="judge-score-table">
      ${config.criteria.map((criterion) => `
        <article class="judge-score-row">
          <p>${criterion.label}</p>
          <div class="judge-score-options" role="radiogroup" aria-label="${criterion.label}">
            ${scoreValues.map((value) => `
              <button
                type="button"
                class="judge-score-choice"
                data-score-choice
                data-criterion="${criterion.criterionKey}"
                data-value="${value}"
              >${formatScoreOptionLabel(value)}</button>
            `).join('')}
          </div>
        </article>
      `).join('')}
    </div>
  `;

  scoreGridRoot.querySelectorAll('[data-score-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.scorecardLocked) {
        return;
      }

      const criterion = String(button.dataset.criterion ?? '').trim();
      const value = Number(button.dataset.value);

      if (!criterion || !Number.isFinite(value)) {
        return;
      }

      state.selectedScoresByCriterion.set(criterion, value);
      applyScoreSelectionStyles();

      const competitorId = String(activePassage?.id ?? '').trim();

      if (!competitorId || !state.competitionId || !state.judgeId) {
        return;
      }

      queueDraftScoreSave({
        competitorId,
        criterionKey: criterion,
        score: value
      }).catch((error) => {
        setScoreResult(`Erreur brouillon: ${error.message}`);
      });
    });
  });

  submitButton.disabled = false;
  submitButton.textContent = 'Valider';
  applyScoreSelectionStyles();
  renderScoreTotal();
}

function renderJudgeStatus(payload) {
  const root = document.querySelector('#judge-identity-status');

  if (!payload) {
    root.className = 'judge-status-card pending';
    root.innerHTML = `
      <strong>Identification requise</strong>
      <p>Saisissez vos identifiants pour vérifier votre habilitation sur la compétition en cours.</p>
    `;
    return;
  }

  const statusClass = payload.isAuthorized ? 'authorized' : 'denied';
  const statusLabel = payload.isAuthorized ? 'Autorisé pour cette compétition' : 'Non autorisé pour cette compétition';
  const statusText = payload.isAuthorized
    ? `${payload.judge.name} peut noter ${payload.competition.name}.`
    : `${payload.judge.name} n'est pas habilité pour ${payload.competition.name}.`;

  root.className = `judge-status-card ${statusClass}`;
  root.innerHTML = `
    <strong>${statusLabel}</strong>
    <p>${statusText}</p>
  `;
}

function stopBackgroundLoops() {
  if (state.heartbeatTimer) {
    window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  if (state.dispatchTimer) {
    window.clearInterval(state.dispatchTimer);
    state.dispatchTimer = null;
  }
}

function startBackgroundLoops() {
  stopBackgroundLoops();

  state.heartbeatTimer = window.setInterval(() => {
    refreshJudgeIdentityStatus().catch((error) => {
      setScoreResult(error.message);
    });
  }, 15000);

  state.dispatchTimer = window.setInterval(() => {
    refreshJudgeDispatchState().catch(() => {
    });
  }, 2000);
}

function clearStoredJudgeSession() {
  localStorage.removeItem(judgeStorage.competitionId);
  localStorage.removeItem(judgeStorage.judgeId);
}

async function sendJudgeLogout({ useKeepalive = false } = {}) {
  if (!state.competitionId || !state.judgeId) {
    return;
  }

  const payload = JSON.stringify({
    competitionId: state.competitionId,
    judgeId: state.judgeId
  });

  if (useKeepalive) {
    try {
      await fetch('/api/judge-logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: payload,
        keepalive: true
      });
    } catch {
    }
    return;
  }

  await request('/api/judge-logout', {
    method: 'POST',
    body: payload
  });
}

function resetJudgeStateUi() {
  state.competitionId = singleActiveCompetitionId;
  state.judgeId = '';
  state.judgeName = '';
  state.judgeRole = '';
  state.isTrainee = false;
  state.scoringProfile = null;
  state.finalizedPassageIds = new Set();
  state.isConnected = false;
  state.isAuthorized = false;

  document.querySelector('#judge-competition').value = singleActiveCompetitionId;
  document.querySelector('#judge-id-hidden').value = '';
  document.querySelector('#competition-id-hidden').value = singleActiveCompetitionId;
  document.querySelector('#judge-login').value = '';
  document.querySelector('#judge-password').value = '';
  resetDispatchForm();
  renderJudgeStatus(null);
  setJudgeCompetitionHeader(null);
  setJudgeSectorBadge({ role: '', isTrainee: false });
  setJudgeHeaderName('Non connecté');
  state.secondaryTabRenderKey = '';
  setActiveScoringTab('notation');
  renderSecondaryTabContent();
  updateConnectedUi();
}

async function performJudgeLogout({ silent = false, bestEffort = false } = {}) {
  stopBackgroundLoops();

  if (bestEffort) {
    await sendJudgeLogout({ useKeepalive: true });
  } else {
    await sendJudgeLogout();
  }

  clearStoredJudgeSession();
  resetJudgeStateUi();

  if (!silent) {
    setScoreResult('Déconnexion effectuée.');
  }
}

function formatPassageLabel(activePassage) {
  const order = String(activePassage?.runningOrder ?? '-').trim();
  const category = String(activePassage?.category ?? '').trim();
  return `${order} · ${formatCompetitorLabel(activePassage)}${category ? ` · ${category}` : ''}`;
}

async function loadExistingScoresByCriterion(competitionId, competitorId, scoreEntries = null) {
  const entries = Array.isArray(scoreEntries)
    ? scoreEntries
    : await request(`/api/competitions/${encodeURIComponent(competitionId)}/competitors/${encodeURIComponent(competitorId)}/scores`);
  const selectedScores = new Map();

  entries.forEach((entry) => {
    if (String(entry?.judgeId ?? '').trim() !== state.judgeId) {
      return;
    }

    const criterion = String(entry?.criterion ?? '').trim();
    const value = Number(entry?.score);

    if (!criterion || !Number.isFinite(value)) {
      return;
    }

    selectedScores.set(criterion, value);
  });

  return selectedScores;
}

async function refreshJudgeDispatchState() {
  if (!state.isConnected || !state.isAuthorized || !state.competitionId) {
    resetDispatchForm();
    return;
  }

  const presenterState = await request('/api/presenter/state');
  const activePassage = presenterState?.activePassage ?? null;

  if (!activePassage || String(activePassage.competitionId ?? '').trim() !== state.competitionId) {
    showWaitingState();
    resetDispatchForm();
    return;
  }

  const competitorId = String(activePassage.id ?? '').trim();

  if (state.finalizedPassageIds.has(competitorId)) {
    showWaitingState();
    return;
  }

  const needsRender = competitorId !== state.activePassageId;

  document.querySelector('#judge-competitor-id').value = competitorId;

  if (needsRender) {
    state.activePassageId = competitorId;
    renderScoreGrid({ activePassage });
    const existingScoreEntries = await request(`/api/competitions/${encodeURIComponent(state.competitionId)}/competitors/${encodeURIComponent(competitorId)}/scores`);
    const prefilledScores = await loadExistingScoresByCriterion(state.competitionId, competitorId, existingScoreEntries);

    if (isHeadJudge()) {
      const penaltyEntry = (Array.isArray(existingScoreEntries) ? existingScoreEntries : []).find((entry) => {
        return String(entry?.judgeId ?? '').trim() === state.judgeId && String(entry?.criterion ?? '').trim() === 'penalty:total';
      });

      state.headPenaltyDraft = deserializeHeadPenaltyDraft({
        score: Number.isFinite(Number(penaltyEntry?.score)) ? String(penaltyEntry.score) : '',
        comment: String(penaltyEntry?.comment ?? '').trim()
      });
      state.scoreCommentDraft = '';
    } else {
      state.headPenaltyDraft = [createEmptyHeadPenaltyItem()];
      const commentEntry = (Array.isArray(existingScoreEntries) ? existingScoreEntries : []).find((entry) => {
        return String(entry?.judgeId ?? '').trim() === state.judgeId && String(entry?.criterion ?? '').trim() === 'judge:comment';
      });
      state.scoreCommentDraft = String(commentEntry?.comment ?? '').trim();
    }

    state.activeScoringTab = 'notation';
    renderSecondaryTabContent();
    await refreshJudgeScoreHistory(activePassage);

    if (hasJudgeFinalizedCurrentPassage(prefilledScores)) {
      state.finalizedPassageIds.add(competitorId);
      showWaitingState();
      return;
    }

    renderScoreGrid({ activePassage, prefilledScores });
  }

  showScoreForm();
}

async function refreshJudgeIdentityStatus() {
  state.competitionId = document.querySelector('#judge-competition').value;
  state.judgeLogin = document.querySelector('#judge-login').value.trim();

  localStorage.setItem(judgeStorage.competitionId, state.competitionId);
  document.querySelector('#competition-id-hidden').value = state.competitionId;

  if (!state.competitionId || !state.judgeId) {
    renderJudgeStatus(null);
    return;
  }

  const payload = await request(`/api/judge-access?competitionId=${encodeURIComponent(state.competitionId)}&judgeId=${encodeURIComponent(state.judgeId)}`);
  renderJudgeStatus(payload);

  state.isAuthorized = Boolean(payload?.isAuthorized);

  if (!state.isAuthorized) {
    stopBackgroundLoops();
    await showJudgeAlertModal({
      title: 'Juge non affecté',
      message: 'Vous n\'êtes pas affecté à cette compétition. Le formulaire va être réinitialisé.'
    });
    await performJudgeLogout({ silent: true });
    return;
  }

  state.judgeName = String(payload?.judge?.name ?? '').trim();
  state.judgeRole = String(payload?.judgeRole ?? '').trim();
  state.isTrainee = Boolean(payload?.isTrainee);
  setJudgeHeaderName(state.judgeName ? `${payload.judge.firstName || ''} ${String(payload.judge.lastName ?? '').toUpperCase()}`.trim() : 'Connecté');
  setJudgeCompetitionHeader(payload?.competition ?? null);
  setJudgeSectorBadge({ role: state.judgeRole, isTrainee: state.isTrainee });
  renderSecondaryTabContent();

  updateConnectedUi();
  await refreshJudgeDispatchState();
}

async function bootstrap() {
  const data = await request('/api/bootstrap');
  const competitionSelect = document.querySelector('#judge-competition');
  const noActiveCompetitionNotice = document.querySelector('#judge-no-active-competition');
  const availableCompetitions = (Array.isArray(data.competitions) ? data.competitions : [])
    .filter((competition) => competition?.status === 'active');
  const storedJudgeId = localStorage.getItem(judgeStorage.judgeId);

  renderOptions(
    competitionSelect,
    availableCompetitions,
    (item) => `${formatFrenchDate(item.eventDate)} - ${item.name}`,
    'Choisir la compétition'
  );

  singleActiveCompetitionId = availableCompetitions.length === 1 ? availableCompetitions[0].id : '';
  competitionSelect.value = singleActiveCompetitionId;
  competitionSelect.disabled = availableCompetitions.length === 0;
  noActiveCompetitionNotice.hidden = availableCompetitions.length > 0;

  state.competitionId = singleActiveCompetitionId;
  document.querySelector('#competition-id-hidden').value = state.competitionId;

  enforceEmptyAuthCredentialsOnOpen();

  if (storedJudgeId && state.competitionId) {
    state.judgeId = storedJudgeId;
    state.isConnected = true;
    document.querySelector('#judge-id-hidden').value = storedJudgeId;

    try {
      await refreshJudgeIdentityStatus();
      startBackgroundLoops();
      return;
    } catch {
      clearStoredJudgeSession();
    }
  }

  resetJudgeStateUi();
}

async function authenticateJudge() {
  const competitionId = document.querySelector('#judge-competition').value;
  const login = document.querySelector('#judge-login').value.trim();
  const password = document.querySelector('#judge-password').value;

  const payload = await request('/api/judge-login', {
    method: 'POST',
    body: JSON.stringify({ competitionId, login, password })
  });

  if (!payload.isAuthorized) {
    await showJudgeAlertModal({
      title: 'Juge non affecté',
      message: 'Vous n\'êtes pas affecté à cette compétition. '
    });
    resetJudgeStateUi();
    return;
  }

  state.competitionId = competitionId;
  state.judgeId = payload.judge.id;
  state.judgeLogin = payload.judge.login;
  state.judgeName = String(payload.judge.name ?? '').trim();
  state.judgeRole = String(payload.judgeRole ?? '').trim();
  state.isTrainee = Boolean(payload.isTrainee);
  state.isConnected = true;
  state.isAuthorized = Boolean(payload.isAuthorized);

  const scoringProfilePayload = await request(`/api/competitions/${encodeURIComponent(competitionId)}/scoring-profile`);
  state.scoringProfile = scoringProfilePayload?.profile ?? null;

  localStorage.setItem(judgeStorage.competitionId, competitionId);
  localStorage.setItem(judgeStorage.judgeId, payload.judge.id);

  document.querySelector('#competition-id-hidden').value = competitionId;
  document.querySelector('#judge-id-hidden').value = payload.judge.id;
  document.querySelector('#judge-password').value = '';

  renderJudgeStatus(payload);
  setJudgeCompetitionHeader(payload?.competition ?? null);
  setJudgeSectorBadge({ role: state.judgeRole, isTrainee: state.isTrainee });
  renderSecondaryTabContent();
  setJudgeHeaderName(`${payload.judge.firstName || ''} ${String(payload.judge.lastName ?? '').toUpperCase()}`.trim());
  updateConnectedUi();
  try {
    await refreshJudgeDispatchState();
  } catch (error) {
    setScoreResult(error?.message ?? 'Erreur de synchronisation des passages.');
  }
  startBackgroundLoops();
}

document.querySelector('#judge-competition').addEventListener('change', async () => {
  if (state.isConnected) {
    try {
      await performJudgeLogout({ silent: true });
    } catch {
    }
  }

  state.competitionId = document.querySelector('#judge-competition').value;
  localStorage.setItem(judgeStorage.competitionId, state.competitionId);
  setScoreResult('');
});

document.querySelector('#judge-auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  validateJudgeAuthForm().then((isValid) => {
    if (!isValid) {
      return;
    }

    return authenticateJudge();
  }).catch(async (error) => {
    const message = String(error?.message ?? '').trim();

    if (message === 'Mot de passe incorrect') {
      await showJudgeAlertModal({
        title: 'Mot de passe incorrect',
        message: 'Le mot de passe saisi est incorrect. Merci de réessayer.'
      });
      document.querySelector('#judge-password').value = '';
      document.querySelector('#judge-password').focus();
      return;
    }

    if (message === 'Utilisateur inconnu') {
      await showJudgeAlertModal({
        title: 'Utilisateur inconnu',
        message: 'Cet utilisateur est inconnu. '
      });
      resetJudgeStateUi();
      return;
    }

    await showJudgeAlertModal({
      title: 'Erreur de connexion',
      message: message || 'Une erreur est survenue lors de la connexion.'
    });
  });
});

document.querySelector('#judge-logout').addEventListener('click', () => {
  performJudgeLogout().catch((error) => {
    setScoreResult(error.message);
  });
});

document.querySelector('#score-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const competitorId = document.querySelector('#judge-competitor-id').value;

  if (!competitorId) {
    setScoreResult('Aucun passage actif envoyé par le conducteur.');
    showWaitingState();
    return;
  }

  if (!state.activeCriteria.length) {
    setScoreResult('Aucune grille active disponible pour la notation.');
    return;
  }

  if (state.scorecardLocked) {
    setScoreResult('Cette notation est deja validee pour ce passage.');
    return;
  }

  const entries = state.activeCriteria.map((criterion) => ({
    criterion: `${state.activeCriterionPrefix}${criterion.criterionKey}`,
    score: Number(state.selectedScoresByCriterion.get(criterion.criterionKey) ?? 0),
    comment: ''
  }));

  const headPenaltyAggregate = getHeadPenaltyAggregate();
  const judgeComment = String(document.querySelector('#judge-score-comment')?.value ?? state.scoreCommentDraft ?? '').trim();

  if (isHeadJudge() && (headPenaltyAggregate.total > 0 || headPenaltyAggregate.comment)) {
    entries.push({
      criterion: 'penalty:total',
      score: headPenaltyAggregate.total,
      comment: headPenaltyAggregate.comment
    });
  }

  if (!isHeadJudge() && judgeComment) {
    entries.push({
      criterion: 'judge:comment',
      score: 0,
      comment: judgeComment
    });
  }

  try {
    await state.draftSaveQueue.catch(() => {
    });

    await request('/api/judge-scorecard', {
      method: 'POST',
      body: JSON.stringify({
        competitionId: state.competitionId,
        competitorId,
        judgeId: state.judgeId,
        entries
      })
    });
    state.scorecardLocked = true;
    state.finalizedPassageIds.add(competitorId);
    document.querySelector('#judge-submit-scorecard').disabled = true;
    document.querySelector('#judge-submit-scorecard').textContent = 'Notation envoyée';
    setScoreResult('Notation validée et envoyée.');
    resetDispatchForm();
    showWaitingState();
    await refreshJudgeDispatchState();
    await refreshJudgeIdentityStatus();
  } catch (error) {
    setScoreResult(error.message);
  }
});

window.addEventListener('pagehide', () => {
  if (state.isConnected) {
    performJudgeLogout({ silent: true, bestEffort: true }).catch(() => {
    });
  }
});

window.addEventListener('beforeunload', () => {
  if (state.isConnected) {
    performJudgeLogout({ silent: true, bestEffort: true }).catch(() => {
    });
  }
});

window.addEventListener('pageshow', () => {
  enforceEmptyAuthCredentialsOnOpen();
});

bootstrap().catch((error) => {
  setScoreResult(error.message);
});