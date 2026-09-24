async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error ?? 'Erreur API');
  }

  return payload;
}

// window.close() ne fait rien sur une fenetre desktop creee via
// webview.create_window() (elle n'a pas ete ouverte par un window.open() de
// script, seul cas que WebView2 honore) : sans ce relai vers l'API Python
// exposee en js_api, la fenetre resterait ouverte indefiniment apres une
// action qui a pourtant reussi cote serveur. Comportement navigateur/Node
// inchange (fallback sur window.close()).
function closeThisWindow() {
  if (window.pywebview?.api?.close_self) {
    window.pywebview.api.close_self().catch(() => {});
    return;
  }

  window.close();
}

const MANUAL_BATCH_DRAFT_STORAGE_PREFIX = 'manual-scoring-batch-draft:v1';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseScoreValue(value) {
  if (typeof value === 'number') {
    return value;
  }

  const normalized = String(value ?? '').trim().replace(/,/g, '.');
  return normalized ? Number(normalized) : Number.NaN;
}

function formatScoreForDisplay(value) {
  const parsed = parseScoreValue(value);

  if (!Number.isFinite(parsed)) {
    return String(value ?? '').trim();
  }

  return parsed.toFixed(2).replace('.', ',');
}

function isDuoCompetitor(competitor) {
  if (Array.isArray(competitor?.members)) {
    return competitor.members.length > 1;
  }

  const stageName = String(competitor?.stageName ?? '');
  return stageName.includes('/');
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
  return stageName || 'Candidat inconnu';
}

function normalizeCriteria(criteria) {
  return (criteria ?? [])
    .filter((criterion) => criterion?.isEnabled)
    .slice()
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
}

function getScoringProfileForCompetitor(profile, competitor) {
  const duo = isDuoCompetitor(competitor);
  return {
    artistic: duo ? profile?.artisticDuo ?? null : profile?.artisticSolo ?? null,
    technical: duo ? profile?.technicalDuo ?? null : profile?.technicalSolo ?? null,
    duo
  };
}

function normalizeJudgeRole(role) {
  const value = String(role ?? '').trim().toLowerCase();

  if (value === 'artistique' || value === 'technique' || value === 'head') {
    return value;
  }

  return '';
}

function getJudgeSectorKey(judge) {
  return normalizeJudgeRole(judge?.judgeRole) === 'artistique' ? 'artistic' : 'technical';
}

function isHeadJudge(judge) {
  return normalizeJudgeRole(judge?.judgeRole) === 'head';
}

function buildJudgeTabLabel(judge) {
  const role = normalizeJudgeRole(judge?.judgeRole);
  const roleLabel = role === 'artistique'
    ? 'Artistique'
    : role === 'head'
      ? 'Head'
      : 'Technique';
  const judgeName = String(judge?.judgeName ?? '').trim() || `Juge ${judge?.slotIndex ?? ''}`.trim();
  return `${roleLabel} : ${judgeName}`;
}

function isHalfStepScore(value, options = {}) {
  const parsed = parseScoreValue(value);
  const min = Number.isFinite(options.min) ? options.min : 0;
  const max = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return false;
  }

  return Math.abs((parsed * 2) - Math.round(parsed * 2)) <= 1e-9;
}

function validateScoreInput(input) {
  const rawValue = String(input?.value ?? '').trim();

  if (!rawValue) {
    input?.classList.remove('is-invalid');
    return { isValid: true, reason: '' };
  }

  const isPenaltyInput = input?.dataset?.criterionKey === 'penalty:total';
  const parsedValue = parseScoreValue(rawValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    input?.classList.add('is-invalid');
    return { isValid: false, reason: 'range' };
  }

  if (!isPenaltyInput && parsedValue > 5) {
    input?.classList.add('is-invalid');
    return { isValid: false, reason: 'range' };
  }

  const hasValidStep = isHalfStepScore(rawValue, {
    min: 0,
    max: isPenaltyInput ? Number.POSITIVE_INFINITY : 5
  });

  if (!hasValidStep) {
    input?.classList.add('is-invalid');
    return { isValid: false, reason: 'step' };
  }

  input?.classList.remove('is-invalid');
  return { isValid: true, reason: '' };
}

function scoreEntryKey(competitorId, judgeId, criterion) {
  return `${competitorId}::${judgeId}::${criterion}`;
}

function buildBatchDraftStorageKey(competitionId, competitorIds) {
  const sortedCompetitorIds = [...competitorIds].sort();
  return `${MANUAL_BATCH_DRAFT_STORAGE_PREFIX}:${competitionId}:${sortedCompetitorIds.join(',')}`;
}

function collectBatchDraft(form) {
  const scores = Array.from(form.querySelectorAll('.manual-score-input'))
    .map((input) => ({
      competitorId: String(input.dataset.competitorId ?? '').trim(),
      judgeId: String(input.dataset.judgeId ?? '').trim(),
      criterion: String(input.dataset.criterionKey ?? '').trim(),
      value: String(input.value ?? '').trim()
    }))
    .filter((entry) => entry.competitorId && entry.judgeId && entry.criterion && entry.value);

  const penaltyComments = Array.from(form.querySelectorAll('[data-penalty-comment="true"]'))
    .map((textarea) => ({
      competitorId: String(textarea.dataset.competitorId ?? '').trim(),
      judgeId: String(textarea.dataset.judgeId ?? '').trim(),
      value: String(textarea.value ?? '').trim()
    }))
    .filter((entry) => entry.competitorId && entry.judgeId && entry.value);

  const judgeComments = Array.from(form.querySelectorAll('[data-judge-comment-field="true"]'))
    .map((textarea) => ({
      competitorId: String(textarea.dataset.competitorId ?? '').trim(),
      judgeId: String(textarea.dataset.judgeId ?? '').trim(),
      value: String(textarea.value ?? '').trim()
    }))
    .filter((entry) => entry.competitorId && entry.judgeId && entry.value);

  const hasData = scores.length > 0 || penaltyComments.length > 0 || judgeComments.length > 0;

  return hasData
    ? {
      updatedAt: Date.now(),
      scores,
      penaltyComments,
      judgeComments
    }
    : null;
}

function applyBatchDraft(form, draft) {
  if (!draft || typeof draft !== 'object') {
    return false;
  }

  let restored = false;

  (draft.scores ?? []).forEach((entry) => {
    const input = form.querySelector(`.manual-score-input[data-competitor-id="${entry.competitorId}"][data-judge-id="${entry.judgeId}"][data-criterion-key="${entry.criterion}"]`);

    if (input) {
      input.value = String(entry.value ?? '');
      validateScoreInput(input);
      restored = true;
    }
  });

  (draft.penaltyComments ?? []).forEach((entry) => {
    const textarea = form.querySelector(`[data-penalty-comment="true"][data-competitor-id="${entry.competitorId}"][data-judge-id="${entry.judgeId}"]`);

    if (textarea) {
      textarea.value = String(entry.value ?? '');
      restored = true;
    }
  });

  (draft.judgeComments ?? []).forEach((entry) => {
    const textarea = form.querySelector(`[data-judge-comment-field="true"][data-competitor-id="${entry.competitorId}"][data-judge-id="${entry.judgeId}"]`);

    if (textarea) {
      textarea.value = String(entry.value ?? '');
      restored = true;
    }
  });

  return restored;
}

function loadBatchDraft(storageKey) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveBatchDraft(storageKey, form) {
  const draft = collectBatchDraft(form);

  try {
    if (!draft) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    // Ignore les erreurs de quota/localStorage indisponible.
  }
}

function clearBatchDraft(storageKey) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore les erreurs localStorage.
  }
}

function buildJudgePanelTable({ judge, competitors, criteria, existingScores, existingPenaltyComments, existingJudgeComments = new Map(), requireScores = false }) {
  const includePenalty = isHeadJudge(judge);
  const colSpan = criteria.length + 1; // +1 pour la colonne "Passage"

  return `
    <section class="manual-criteria-table-card">
      <h4>${escapeHtml(buildJudgeTabLabel(judge))}</h4>
      <div class="manual-criteria-table-scroll">
        <table class="manual-criteria-table manual-batch-table">
          <thead>
            <tr>
              <th>Passage</th>
              ${criteria.map((criterion) => `<th>${escapeHtml(criterion.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${competitors.map((competitor) => {
              const rowLabel = `${competitor.runningOrder ?? '-'} ${formatCompetitorLabel(competitor)}`;
              const existingPenalty = includePenalty
                ? existingScores.get(scoreEntryKey(competitor.id, judge.judgeId, 'penalty:total'))
                : null;
              const penaltyValueAttr = existingPenalty
                ? ` value="${escapeHtml(formatScoreForDisplay(existingPenalty.score))}"`
                : '';

              return `
                <tr class="${includePenalty ? 'manual-head-judge-row' : ''}">
                  <th scope="row">
                    <span>${escapeHtml(rowLabel)}</span>
                  </th>
                  ${criteria.map((criterion) => {
                    const criterionKey = `${getJudgeSectorKey(judge)}:${criterion.criterionKey}`;
                    const existingScore = existingScores.get(scoreEntryKey(competitor.id, judge.judgeId, criterionKey));
                    const valueAttr = existingScore ? ` value="${escapeHtml(formatScoreForDisplay(existingScore.score))}"` : '';
                    return `
                      <td>
                        <input
                          class="manual-score-input"
                          type="text"
                          inputmode="decimal"
                          ${requireScores ? 'required' : ''}
                          ${valueAttr}
                          data-competitor-id="${escapeHtml(competitor.id)}"
                          data-judge-id="${escapeHtml(judge.judgeId)}"
                          data-criterion-key="${escapeHtml(criterionKey)}"
                          aria-label="${escapeHtml(`${rowLabel} - ${criterion.label}`)}"
                        >
                      </td>
                    `;
                  }).join('')}
                </tr>
                ${includePenalty ? `
                <tr class="manual-penalty-inline-row">
                  <th scope="row"><span>Pénalités</span></th>
                  <td colspan="${colSpan - 1}">
                    <div class="manual-penalty-inline-field">
                      <label>
                        <span>Total des pénalités</span>
                        <input
                          class="manual-score-input"
                          type="text"
                          inputmode="decimal"
                          ${penaltyValueAttr}
                          data-competitor-id="${escapeHtml(competitor.id)}"
                          data-judge-id="${escapeHtml(judge.judgeId)}"
                          data-criterion-key="penalty:total"
                          aria-label="${escapeHtml(`${rowLabel} - Pénalités`)}"
                          placeholder="0,0"
                        >
                      </label>
                      <label class="manual-penalty-comment-field">
                        <span>Description des pénalités appliquées</span>
                        <textarea
                          rows="2"
                          data-competitor-id="${escapeHtml(competitor.id)}"
                          data-judge-id="${escapeHtml(judge.judgeId)}"
                          data-penalty-comment="true"
                          placeholder="Ex: sortie de zone, appui extérieur, tenue non conforme..."
                        >${escapeHtml(existingPenaltyComments.get(`${competitor.id}::${judge.judgeId}`) ?? '')}</textarea>
                      </label>
                    </div>
                  </td>
                </tr>
                ` : ''}
                ${!includePenalty ? `
                <tr class="manual-batch-comment-row">
                  <th scope="row"><span>Commentaire</span></th>
                  <td colspan="${colSpan - 1}" data-comment-toolbar-wrap="true">
                    <div class="manual-batch-comment-toolbar">
                      <button type="button" class="manual-batch-comment-btn" data-insert-symbol="😊" title="Positif">😊</button>
                      <button type="button" class="manual-batch-comment-btn" data-insert-symbol="😐" title="Neutre">😐</button>
                      <button type="button" class="manual-batch-comment-btn" data-insert-symbol="😕" title="À améliorer">😕</button>
                      <span class="manual-batch-comment-sep"></span>
                      <button type="button" class="manual-batch-comment-btn manual-batch-comment-btn--warn" data-insert-symbol="⚠️" title="Attention">⚠️</button>
                      <span class="manual-batch-comment-sep"></span>
                      <button type="button" class="manual-batch-comment-btn manual-batch-comment-btn--pos2" data-insert-symbol="++" title="Très bien">++</button>
                      <button type="button" class="manual-batch-comment-btn manual-batch-comment-btn--pos1" data-insert-symbol="+" title="Bien">+</button>
                      <button type="button" class="manual-batch-comment-btn manual-batch-comment-btn--neg1" data-insert-symbol="-" title="Insuffisant">-</button>
                      <button type="button" class="manual-batch-comment-btn manual-batch-comment-btn--neg2" data-insert-symbol="--" title="Très insuffisant">--</button>
                    </div>
                    <textarea
                      class="manual-batch-comment-textarea"
                      data-judge-comment-field="true"
                      data-competitor-id="${escapeHtml(competitor.id)}"
                      data-judge-id="${escapeHtml(judge.judgeId)}"
                      placeholder="Commentaire libre..."
                      rows="2"
                    >${escapeHtml(existingJudgeComments.get(`${competitor.id}::${judge.judgeId}`) ?? '')}</textarea>
                  </td>
                </tr>
                ` : ''}
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function insertAtCursor(textarea, symbol) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const inserted = (needsSpace ? ' ' : '') + symbol + ' ';
  textarea.value = before + inserted + after;
  const newPos = start + inserted.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();
}

function bindCommentToolbars(root) {
  root.querySelectorAll('[data-insert-symbol]').forEach((button) => {
    button.addEventListener('click', () => {
      const symbol = String(button.dataset.insertSymbol ?? '');
      const wrap = button.closest('[data-comment-toolbar-wrap]');
      const textarea = wrap?.querySelector('textarea');

      if (textarea && symbol) {
        insertAtCursor(textarea, symbol);
      }
    });
  });
}

function switchBatchTab(nextTabId) {
  document.querySelectorAll('[data-batch-tab-button]').forEach((button) => {
    const isActive = button.dataset.batchTabButton === nextTabId;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  document.querySelectorAll('[data-batch-tab-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.batchTabPanel !== nextTabId;
  });

  window.requestAnimationFrame(() => {
    const activePanel = document.querySelector(`[data-batch-tab-panel="${CSS.escape(nextTabId)}"]`);
    const firstScoreInput = activePanel?.querySelector('.manual-score-input:not([disabled])');

    if (firstScoreInput instanceof HTMLInputElement) {
      firstScoreInput.focus();
      firstScoreInput.select();
    }
  });
}

async function bootstrapBatchManualScoring() {
  const search = new URLSearchParams(window.location.search);
  const competitionId = String(search.get('competitionId') ?? '').trim();
  const competitorIds = String(search.get('competitorIds') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const errorRoot = document.querySelector('#manual-scoring-error');
  const form = document.querySelector('#manual-scoring-batch-form');
  const feedback = document.querySelector('#manual-form-feedback');
  const title = document.querySelector('#manual-batch-title');
  const draftStorageKey = buildBatchDraftStorageKey(competitionId, competitorIds);
  let draftSaveTimer = null;

  const scheduleDraftSave = () => {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
    }

    draftSaveTimer = window.setTimeout(() => {
      saveBatchDraft(draftStorageKey, form);
    }, 450);
  };

  const flushDraftSave = () => {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }

    saveBatchDraft(draftStorageKey, form);
  };

  const setError = (message) => {
    errorRoot.hidden = false;
    errorRoot.textContent = message;
    form.hidden = true;
  };

  form.setAttribute('novalidate', 'novalidate');

  if (!competitionId || !competitorIds.length) {
    setError('Parametres manquants pour la saisie manuelle en lot.');
    return;
  }

  try {
    const [competitors, assignments, scoringProfile] = await Promise.all([
      request(`/api/competitions/${competitionId}/competitors`),
      request(`/api/competitions/${competitionId}/judge-assignments`),
      request(`/api/competitions/${competitionId}/scoring-profile`)
    ]);

    const selectedCompetitors = competitorIds
      .map((competitorId) => competitors.find((competitor) => competitor.id === competitorId))
      .filter(Boolean)
      .sort((left, right) => (Number(left.runningOrder) || 0) - (Number(right.runningOrder) || 0));

    if (!selectedCompetitors.length) {
      throw new Error('Aucun passage selectionne.');
    }

    const firstProfile = getScoringProfileForCompetitor(scoringProfile.profile, selectedCompetitors[0]);
    const firstCategory = String(selectedCompetitors[0].category ?? '').trim();

    const hasMixedProfile = selectedCompetitors.some((competitor) => {
      const currentProfile = getScoringProfileForCompetitor(scoringProfile.profile, competitor);
      return currentProfile.duo !== firstProfile.duo || String(competitor.category ?? '').trim() !== firstCategory;
    });

    if (hasMixedProfile) {
      throw new Error('Selection non homogene: choisissez des passages de meme categorie et meme format (solo/duo).');
    }

    const artisticCriteria = normalizeCriteria(firstProfile.artistic?.criteria);
    const technicalCriteria = normalizeCriteria(firstProfile.technical?.criteria);
    const sortedMainJudges = (assignments ?? [])
      .filter((assignment) => assignment?.judgeId && !assignment.isTrainee)
      .slice()
      .sort((left, right) => {
        const leftRole = normalizeJudgeRole(left.judgeRole);
        const rightRole = normalizeJudgeRole(right.judgeRole);
        const roleRank = { artistique: 1, technique: 2, head: 3 };
        const rankDelta = (roleRank[leftRole] ?? 99) - (roleRank[rightRole] ?? 99);

        if (rankDelta !== 0) {
          return rankDelta;
        }

        return (left.slotIndex ?? 0) - (right.slotIndex ?? 0);
      });

    if (!sortedMainJudges.length) {
      throw new Error('Aucun juge titulaire affecte a cette competition.');
    }

    const sortedShadowJudges = (assignments ?? [])
      .filter((assignment) => assignment?.judgeId && assignment.isTrainee)
      .slice()
      .sort((left, right) => {
        const leftRole = normalizeJudgeRole(left.judgeRole);
        const rightRole = normalizeJudgeRole(right.judgeRole);
        const roleRank = { artistique: 1, technique: 2, head: 3 };
        const rankDelta = (roleRank[leftRole] ?? 99) - (roleRank[rightRole] ?? 99);

        if (rankDelta !== 0) {
          return rankDelta;
        }

        return (left.slotIndex ?? 0) - (right.slotIndex ?? 0);
      });

    const judgeTabs = [
      ...sortedMainJudges.map((judge) => ({ judge, kind: 'main' })),
      ...sortedShadowJudges.map((judge) => ({ judge, kind: 'shadow' }))
    ];

    const scoresByCompetitor = await Promise.all(
      selectedCompetitors.map((competitor) => request(`/api/competitions/${competitionId}/competitors/${competitor.id}/scores`))
    );

    const existingScores = new Map();
    const existingPenaltyComments = new Map();
    const existingJudgeComments = new Map();

    selectedCompetitors.forEach((competitor, index) => {
      (scoresByCompetitor[index] ?? []).forEach((row) => {
        existingScores.set(scoreEntryKey(competitor.id, row.judgeId, row.criterion), row);

        if (row.criterion === 'penalty:total' && row.comment) {
          existingPenaltyComments.set(`${competitor.id}::${row.judgeId}`, row.comment);
        }

        if (row.criterion === 'judge:comment' && row.comment) {
          existingJudgeComments.set(`${competitor.id}::${row.judgeId}`, row.comment);
        }
      });
    });

    title.textContent = `${selectedCompetitors.length} passage${selectedCompetitors.length > 1 ? 's' : ''} selectionne${selectedCompetitors.length > 1 ? 's' : ''}`;

    const tabsMainRoot = document.querySelector('#manual-batch-tabs-main');
    const tabsShadowRoot = document.querySelector('#manual-batch-tabs-shadow');
    const tabsShadowGroup = document.querySelector('#manual-batch-tabs-shadow-group');
    const panelsRoot = document.querySelector('#manual-batch-panels');

    tabsMainRoot.innerHTML = sortedMainJudges.map((judge, index) => {
      const tabId = `judge-${index + 1}`;
      return `
        <button
          type="button"
          class="manual-batch-judge-tab${index === 0 ? ' is-active' : ''}"
          data-batch-tab-button="${tabId}"
          role="tab"
          aria-selected="${index === 0 ? 'true' : 'false'}"
        >
          ${escapeHtml(buildJudgeTabLabel(judge))}
        </button>
      `;
    }).join('');

    tabsShadowRoot.innerHTML = sortedShadowJudges.map((judge, index) => {
      const tabId = `judge-shadow-${index + 1}`;
      return `
        <button
          type="button"
          class="manual-batch-judge-tab is-shadow"
          data-batch-tab-button="${tabId}"
          role="tab"
          aria-selected="false"
        >
          ${escapeHtml(buildJudgeTabLabel(judge))}
        </button>
      `;
    }).join('');

    if (tabsShadowGroup) {
      tabsShadowGroup.hidden = sortedShadowJudges.length === 0;
    }

    panelsRoot.innerHTML = judgeTabs.map((entry, index) => {
      const tabId = entry.kind === 'shadow'
        ? `judge-shadow-${sortedShadowJudges.indexOf(entry.judge) + 1}`
        : `judge-${sortedMainJudges.indexOf(entry.judge) + 1}`;
      const criteria = getJudgeSectorKey(entry.judge) === 'artistic' ? artisticCriteria : technicalCriteria;
      const isMainJudge = entry.kind === 'main';
      return `
        <section data-batch-tab-panel="${tabId}" ${index === 0 ? '' : 'hidden'}>
          ${buildJudgePanelTable({
            judge: entry.judge,
            competitors: selectedCompetitors,
            criteria,
            existingScores,
            existingPenaltyComments,
            existingJudgeComments,
            requireScores: isMainJudge
          })}
        </section>
      `;
    }).join('');

    document.querySelectorAll('[data-batch-tab-button]').forEach((button) => {
      button.addEventListener('click', () => {
        switchBatchTab(button.dataset.batchTabButton);
      });
    });

    bindCommentToolbars(form);

    const existingDraft = loadBatchDraft(draftStorageKey);

    if (applyBatchDraft(form, existingDraft)) {
      feedback.textContent = 'Brouillon restauré automatiquement.';
      feedback.className = 'manual-form-feedback is-success';
    }

    document.querySelector('#manual-batch-close-button')?.addEventListener('click', () => {
      closeThisWindow();
    });

    form.addEventListener('focusout', (event) => {
      const input = event.target;

      if (!(input instanceof HTMLInputElement) || !input.classList.contains('manual-score-input')) {
        return;
      }

      const rawValue = String(input.value ?? '').trim();

      if (!rawValue) {
        input.classList.remove('is-invalid');
        return;
      }

      const validation = validateScoreInput(input);

      if (!validation.isValid) {
        input.value = rawValue.replace(/\./g, ',');
        window.setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
        return;
      }

      input.value = formatScoreForDisplay(rawValue);
      scheduleDraftSave();
    });

    form.addEventListener('input', (event) => {
      const input = event.target;

      if (!(input instanceof HTMLInputElement) || !input.classList.contains('manual-score-input')) {
        return;
      }

      validateScoreInput(input);
      scheduleDraftSave();
    });

    form.addEventListener('change', () => {
      scheduleDraftSave();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const requiredInputs = Array.from(form.querySelectorAll('.manual-score-input[required]'));
      const scoreInputs = Array.from(form.querySelectorAll('.manual-score-input'));
      const hasAnyScoreValue = scoreInputs.some((input) => String(input.value ?? '').trim() !== '');
      const hasAnyCommentValue = Array.from(form.querySelectorAll('[data-penalty-comment="true"], [data-judge-comment-field]'))
        .some((field) => String(field.value ?? '').trim() !== '');
      const isCompletelyEmptySubmission = !hasAnyScoreValue && !hasAnyCommentValue;

      const missingRequired = requiredInputs.filter((input) => !String(input.value ?? '').trim());

      if (!isCompletelyEmptySubmission && missingRequired.length) {
        missingRequired.forEach((input) => input.classList.add('is-invalid'));
        missingRequired[0].focus();
        feedback.textContent = 'Toutes les notes juge/critere sont obligatoires.';
        feedback.className = 'manual-form-feedback is-error';
        return;
      }

      const invalidInput = scoreInputs
        .map((input) => ({ input, result: validateScoreInput(input) }))
        .find(({ result }) => !result.isValid);

      if (invalidInput) {
        invalidInput.input.focus();
        feedback.textContent = invalidInput.input.dataset.criterionKey === 'penalty:total'
          ? 'Le total des penalites doit etre superieur ou egal a 0, par pas de 0,5.'
          : 'Chaque note doit etre comprise entre 0 et 5, par pas de 0,5.';
        feedback.className = 'manual-form-feedback is-error';
        return;
      }

      const entriesByCompetitor = new Map();

      scoreInputs
        .filter((input) => String(input.value ?? '').trim())
        .forEach((input) => {
          const competitorId = String(input.dataset.competitorId ?? '').trim();
          const judgeId = String(input.dataset.judgeId ?? '').trim();
          const criterion = String(input.dataset.criterionKey ?? '').trim();

          if (!competitorId || !judgeId || !criterion) {
            return;
          }

          if (!entriesByCompetitor.has(competitorId)) {
            entriesByCompetitor.set(competitorId, []);
          }

          let comment = '';

          if (criterion === 'penalty:total') {
            const penaltyCommentNode = form.querySelector(`[data-penalty-comment="true"][data-competitor-id="${competitorId}"][data-judge-id="${judgeId}"]`);
            comment = String(penaltyCommentNode?.value ?? '').trim();
          }

          entriesByCompetitor.get(competitorId).push({
            judgeId,
            criterion,
            score: parseScoreValue(input.value),
            comment
          });
        });

      // Collecte des commentaires libres par juge et par passage
      form.querySelectorAll('[data-judge-comment-field]').forEach((textarea) => {
        const comment = String(textarea.value ?? '').trim();

        if (!comment) {
          return;
        }

        const competitorId = String(textarea.dataset.competitorId ?? '').trim();
        const judgeId = String(textarea.dataset.judgeId ?? '').trim();

        if (!competitorId || !judgeId) {
          return;
        }

        if (!entriesByCompetitor.has(competitorId)) {
          entriesByCompetitor.set(competitorId, []);
        }

        entriesByCompetitor.get(competitorId).push({
          judgeId,
          criterion: 'judge:comment',
          score: 0,
          comment
        });
      });

      try {
        for (const competitor of selectedCompetitors) {
          const entries = entriesByCompetitor.get(competitor.id) ?? [];

          await request('/api/manual-scoring/save', {
            method: 'POST',
            body: JSON.stringify({
              competitionId,
              competitorId: competitor.id,
              entries
            })
          });
        }

        feedback.textContent = isCompletelyEmptySubmission
          ? `Notes effacees pour ${selectedCompetitors.length} passage${selectedCompetitors.length > 1 ? 's' : ''}.`
          : `Notes enregistrees pour ${selectedCompetitors.length} passage${selectedCompetitors.length > 1 ? 's' : ''}.`;
        feedback.className = 'manual-form-feedback is-success';

        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            type: 'manual-scoring-batch-saved',
            competitionId,
            competitorIds: selectedCompetitors.map((competitor) => competitor.id),
            cleared: isCompletelyEmptySubmission
          }, window.location.origin);
        }

        clearBatchDraft(draftStorageKey);

        closeThisWindow();
      } catch (error) {
        feedback.textContent = error.message;
        feedback.className = 'manual-form-feedback is-error';
      }
    });

    form.hidden = false;
    errorRoot.hidden = true;
  } catch (error) {
    setError(error.message);
  }

  window.addEventListener('beforeunload', flushDraftSave);
  window.addEventListener('pagehide', flushDraftSave);
}

bootstrapBatchManualScoring();
