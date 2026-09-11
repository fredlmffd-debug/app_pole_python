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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  if (!competitor) {
    return 'Candidat inconnu';
  }

  const firstNames = splitMembers(competitor.firstName);
  const lastNames = splitMembers(competitor.lastName);
  const memberCount = Math.max(firstNames.length, lastNames.length);

  if (memberCount > 0) {
    const members = Array.from({ length: memberCount }, (_, index) => formatNameFirstLast(firstNames[index], lastNames[index]))
      .filter(Boolean);

    if (members.length > 0) {
      return members.join(' & ');
    }
  }

  const stageName = String(competitor.stageName ?? '').trim();

  if (stageName) {
    return stageName;
  }

  return 'Candidat inconnu';
}

function isDuoCompetitor(competitor) {
  if (Array.isArray(competitor?.members)) {
    return competitor.members.length > 1;
  }

  const stageName = String(competitor?.stageName ?? '');
  return stageName.includes('/');
}

function parseScoreValue(value) {
  if (typeof value === 'number') {
    return value;
  }

  const normalized = String(value ?? '').trim().replace(/,/g, '.');

  if (!normalized) {
    return Number.NaN;
  }

  return Number(normalized);
}

function formatScoreForDisplay(value) {
  const parsed = parseScoreValue(value);

  if (!Number.isFinite(parsed)) {
    return String(value ?? '').trim();
  }

  return parsed.toFixed(2).replace('.', ',');
}

function getScoreEntryKey(judgeId, criterion) {
  return `${String(judgeId ?? '').trim()}::${String(criterion ?? '').trim()}`;
}

function createToastNode() {
  const node = document.createElement('div');
  node.className = 'app-toast';
  node.dataset.state = 'hidden';
  node.dataset.type = 'error';
  document.body.appendChild(node);
  return node;
}

let manualToastTimer = null;
const MANUAL_DRAFT_STORAGE_PREFIX = 'manual-scoring-draft:v1';

function showManualToast(message, type = 'error') {
  const toast = document.querySelector('.app-toast') ?? createToastNode();

  if (manualToastTimer) {
    clearTimeout(manualToastTimer);
    manualToastTimer = null;
  }

  toast.textContent = String(message ?? '');
  toast.dataset.type = type;
  toast.dataset.state = 'visible';

  manualToastTimer = window.setTimeout(() => {
    toast.dataset.state = 'hidden';
  }, 3200);
}

function buildManualDraftStorageKey(competitionId, competitorId) {
  return `${MANUAL_DRAFT_STORAGE_PREFIX}:${competitionId}:${competitorId}`;
}

function collectManualDraft(form) {
  const scores = Array.from(form.querySelectorAll('.manual-score-input'))
    .map((input) => ({
      judgeId: String(input.dataset.judgeId ?? '').trim(),
      criterion: String(input.dataset.criterionKey ?? '').trim(),
      value: String(input.value ?? '').trim()
    }))
    .filter((entry) => entry.judgeId && entry.criterion && entry.value);

  const penaltyComments = Array.from(form.querySelectorAll('[data-penalty-comment-for]'))
    .map((textarea) => ({
      judgeId: String(textarea.dataset.penaltyCommentFor ?? '').trim(),
      value: String(textarea.value ?? '').trim()
    }))
    .filter((entry) => entry.judgeId && entry.value);

  const judgeComments = Array.from(form.querySelectorAll('[data-judge-comment-field]'))
    .map((textarea) => ({
      judgeId: String(textarea.dataset.judgeId ?? '').trim(),
      value: String(textarea.value ?? '').trim()
    }))
    .filter((entry) => entry.judgeId && entry.value);

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

function applyManualDraft(form, draft) {
  if (!draft || typeof draft !== 'object') {
    return false;
  }

  let restored = false;

  (draft.scores ?? []).forEach((entry) => {
    const input = form.querySelector(`.manual-score-input[data-judge-id="${entry.judgeId}"][data-criterion-key="${entry.criterion}"]`);

    if (input) {
      input.value = String(entry.value ?? '');
      validateScoreInput(input);
      restored = true;
    }
  });

  (draft.penaltyComments ?? []).forEach((entry) => {
    const textarea = form.querySelector(`[data-penalty-comment-for="${entry.judgeId}"]`);

    if (textarea) {
      textarea.value = String(entry.value ?? '');
      restored = true;
    }
  });

  (draft.judgeComments ?? []).forEach((entry) => {
    const textarea = form.querySelector(`[data-judge-comment-field="true"][data-judge-id="${entry.judgeId}"]`);

    if (textarea) {
      textarea.value = String(entry.value ?? '');
      restored = true;
    }
  });

  return restored;
}

function loadManualDraft(storageKey) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveManualDraft(storageKey, form) {
  const draft = collectManualDraft(form);

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

function clearManualDraft(storageKey) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore les erreurs localStorage.
  }
}

function isLockedInvalidScoreInput(input) {
  return input instanceof HTMLInputElement
    && input.classList.contains('manual-score-input')
    && input.classList.contains('is-invalid')
    && String(input.value ?? '').trim() !== '';
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

function getScoringProfileForCompetitor(profile, competitor) {
  const duo = isDuoCompetitor(competitor);
  return {
    artistic: duo ? profile?.artisticDuo ?? null : profile?.artisticSolo ?? null,
    technical: duo ? profile?.technicalDuo ?? null : profile?.technicalSolo ?? null
  };
}

function normalizeCriteria(criteria) {
  return (criteria ?? [])
    .filter((criterion) => criterion?.isEnabled)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function buildJudgeLabel(judge) {
  const fullName = String(judge.judgeName ?? '').trim();

  if (fullName) {
    return fullName;
  }

  const fallback = [String(judge.judgeLastName ?? '').trim(), String(judge.judgeFirstName ?? '').trim()].filter(Boolean).join(' ');

  if (fallback) {
    return fallback;
  }

  return `Juge ${judge.slotIndex}`;
}

function normalizeJudgeRole(role) {
  const value = String(role ?? '').trim().toLowerCase();

  if (value === 'artistique' || value === 'technique' || value === 'head') {
    return value;
  }

  return '';
}

function isArtisticJudge(judge) {
  return normalizeJudgeRole(judge?.judgeRole) === 'artistique';
}

function isTechnicalJudge(judge) {
  const role = normalizeJudgeRole(judge?.judgeRole);
  return role === 'technique' || role === 'head';
}

function isHeadJudge(judge) {
  return normalizeJudgeRole(judge?.judgeRole) === 'head';
}

function sortTechnicalJudges(judges) {
  const technicalJudges = [];
  const headJudges = [];

  judges.forEach((judge) => {
    if (isHeadJudge(judge)) {
      headJudges.push(judge);
      return;
    }

    technicalJudges.push(judge);
  });

  return [...technicalJudges, ...headJudges];
}

function insertAtCursor(textarea, symbol) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const inserted = `${needsSpace ? ' ' : ''}${symbol} `;
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

function buildCriteriaTableHtml({
  tableTitle,
  criteria,
  judges,
  sectorKey,
  includePenalty = false,
  requireScores = false,
  existingScores = new Map(),
  existingPenaltyComments = new Map(),
  existingJudgeComments = new Map()
}) {
  if (!criteria.length || !judges.length) {
    return '';
  }

  const bodyRows = [];

  judges.forEach((judge) => {
    const judgeName = buildJudgeLabel(judge);

    bodyRows.push(`
      <tr class="${isHeadJudge(judge) ? 'manual-head-judge-row' : ''}">
        <th scope="row">
          <span>${escapeHtml(judgeName)}</span>
          ${isHeadJudge(judge) ? '<small>Head Judge</small>' : ''}
        </th>
        ${criteria.map((criterion) => `
          ${(() => {
            const scoreKey = getScoreEntryKey(judge.judgeId, `${sectorKey}:${criterion.criterionKey}`);
            const existingScore = existingScores.get(scoreKey);
            const valueAttr = existingScore ? ` value="${escapeHtml(formatScoreForDisplay(existingScore.score))}"` : '';
            return `
          <td>
            <input
              class="manual-score-input"
              type="text"
              inputmode="decimal"
              ${requireScores ? 'required' : ''}
              ${valueAttr}
              data-judge-id="${escapeHtml(judge.judgeId)}"
              data-criterion-key="${escapeHtml(`${sectorKey}:${criterion.criterionKey}`)}"
              aria-label="${escapeHtml(`${judgeName} - ${criterion.label}`)}"
            >
          </td>
            `;
          })()}
        `).join('')}
      </tr>
    `);

    if (includePenalty && isHeadJudge(judge)) {
      bodyRows.push(`
        <tr class="manual-penalty-inline-row">
          <th scope="row">
            <span>Pénalités</span>
          </th>
          <td colspan="${criteria.length}">
            <div class="manual-penalty-inline-field">
              <label>
                <span>Total des pénalités</span>
                <input
                  class="manual-score-input"
                  type="text"
                  inputmode="decimal"
                  ${(() => {
                    const penaltyScore = existingScores.get(getScoreEntryKey(judge.judgeId, 'penalty:total'));
                    return penaltyScore ? `value="${escapeHtml(formatScoreForDisplay(penaltyScore.score))}"` : '';
                  })()}
                  data-judge-id="${escapeHtml(judge.judgeId)}"
                  data-criterion-key="penalty:total"
                  aria-label="Pénalités Head Judge"
                  placeholder="0,0"
                >
              </label>
              <label class="manual-penalty-comment-field">
                <span>Description des pénalités appliquées</span>
                <textarea
                  rows="2"
                  data-penalty-comment-for="${escapeHtml(judge.judgeId)}"
                  placeholder="Ex: sortie de zone, appui extérieur, tenue non conforme..."
                >${escapeHtml(existingPenaltyComments.get(judge.judgeId) ?? '')}</textarea>
              </label>
            </div>
          </td>
        </tr>
      `);
    }

    if (!isHeadJudge(judge)) {
      bodyRows.push(`
        <tr class="manual-batch-comment-row">
          <th scope="row"><span>Commentaire</span></th>
          <td colspan="${criteria.length}" data-comment-toolbar-wrap="true">
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
              data-judge-id="${escapeHtml(judge.judgeId)}"
              placeholder="Commentaire libre..."
              rows="2"
            >${escapeHtml(existingJudgeComments.get(judge.judgeId) ?? '')}</textarea>
          </td>
        </tr>
      `);
    }
  });

  return `
    <section class="manual-criteria-table-card">
      <h4>${escapeHtml(tableTitle)}</h4>
      <div class="manual-criteria-table-scroll">
        <table class="manual-criteria-table">
          <thead>
            <tr>
              <th>Juge</th>
              ${criteria.map((criterion) => `<th>${escapeHtml(criterion.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${bodyRows.join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function buildSectionHtml({ title, subtitle, sectionClass, blocks }) {
  const hasRenderableBlock = blocks.some((block) => block.criteria.length && block.judges.length);

  if (!hasRenderableBlock) {
    return '';
  }

  return `
    <section class="manual-judge-section ${escapeHtml(sectionClass)}">
      <header>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(subtitle)}</p>
      </header>
      ${blocks.map((block) => buildCriteriaTableHtml(block)).join('')}
    </section>
  `;
}

async function bootstrapManualScoring() {
  const search = new URLSearchParams(window.location.search);
  const competitionId = String(search.get('competitionId') ?? '').trim();
  const competitorId = String(search.get('competitorId') ?? '').trim();
  let manualScoringSaved = false;
  let closeNotificationSent = false;
  const errorRoot = document.querySelector('#manual-scoring-error');
  const form = document.querySelector('#manual-scoring-form');
  const candidateName = document.querySelector('#manual-candidate-name');
  const candidateCategory = document.querySelector('#manual-candidate-category');
  const feedback = document.querySelector('#manual-form-feedback');
  const draftStorageKey = buildManualDraftStorageKey(competitionId, competitorId);
  let draftSaveTimer = null;

  const scheduleDraftSave = () => {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
    }

    draftSaveTimer = window.setTimeout(() => {
      saveManualDraft(draftStorageKey, form);
    }, 450);
  };

  const flushDraftSave = () => {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }

    saveManualDraft(draftStorageKey, form);
  };

  const setError = (message) => {
    errorRoot.hidden = false;
    errorRoot.textContent = message;
    form.hidden = true;
  };

  form.setAttribute('novalidate', 'novalidate');

  if (!competitionId || !competitorId) {
    setError('Parametres manquants pour la saisie manuelle.');
    return;
  }

  try {
    const [competitors, assignments, scoringProfile] = await Promise.all([
      request(`/api/competitions/${competitionId}/competitors`),
      request(`/api/competitions/${competitionId}/judge-assignments`),
      request(`/api/competitions/${competitionId}/scoring-profile`)
    ]);

    const existingScoresRows = await request(`/api/competitions/${competitionId}/competitors/${competitorId}/scores`);
    const existingScores = new Map();
    const existingPenaltyComments = new Map();
    const existingJudgeComments = new Map();

    existingScoresRows.forEach((row) => {
      const key = getScoreEntryKey(row.judgeId, row.criterion);

      if (!existingScores.has(key)) {
        existingScores.set(key, row);
      }

      if (row.criterion === 'penalty:total' && row.comment && !existingPenaltyComments.has(row.judgeId)) {
        existingPenaltyComments.set(row.judgeId, row.comment);
      }

      if (row.criterion === 'judge:comment' && row.comment && !existingJudgeComments.has(row.judgeId)) {
        existingJudgeComments.set(row.judgeId, row.comment);
      }
    });

    const competitor = competitors.find((item) => item.id === competitorId) ?? null;

    if (!competitor) {
      throw new Error('Competiteur introuvable pour cette competition');
    }

    const profile = getScoringProfileForCompetitor(scoringProfile.profile, competitor);
    const artisticCriteria = normalizeCriteria(profile.artistic?.criteria);
    const technicalCriteria = normalizeCriteria(profile.technical?.criteria);
    const assignedJudges = (assignments ?? []).filter((assignment) => assignment?.judgeId);
    const mainJudges = assignedJudges.filter((assignment) => !assignment.isTrainee);
    const shadowJudges = assignedJudges.filter((assignment) => assignment.isTrainee);
    const mainArtisticJudges = mainJudges.filter(isArtisticJudge);
    const mainTechnicalJudges = sortTechnicalJudges(mainJudges.filter(isTechnicalJudge));
    const shadowArtisticJudges = shadowJudges.filter(isArtisticJudge);
    const shadowTechnicalJudges = sortTechnicalJudges(shadowJudges.filter(isTechnicalJudge));

    if (!mainJudges.length && !shadowJudges.length) {
      throw new Error('Aucun juge affecte a cette competition');
    }

    candidateName.textContent = formatCompetitorLabel(competitor);
    candidateCategory.textContent = String(competitor.category ?? '').trim();

    const mainRoot = document.querySelector('#manual-main-judges');
    const shadowRoot = document.querySelector('#manual-shadow-judges');

    mainRoot.innerHTML = buildSectionHtml({
      title: 'Juges titulaires',
      subtitle: 'Notes prises en compte pour le classement',
      sectionClass: 'is-main',
      blocks: [
        {
          tableTitle: 'Artistique',
          criteria: artisticCriteria,
          judges: mainArtisticJudges,
          sectorKey: 'artistic',
          requireScores: true,
          existingScores,
          existingPenaltyComments,
          existingJudgeComments
        },
        {
          tableTitle: 'Technique',
          criteria: technicalCriteria,
          judges: mainTechnicalJudges,
          sectorKey: 'technical',
          includePenalty: true,
          requireScores: true,
          existingScores,
          existingPenaltyComments,
          existingJudgeComments
        }
      ]
    });

    shadowRoot.innerHTML = buildSectionHtml({
      title: 'Juges shadow',
      subtitle: 'Section differenciee (hors classement officiel)',
      sectionClass: 'is-shadow',
      blocks: [
        {
          tableTitle: 'Artistique',
          criteria: artisticCriteria,
          judges: shadowArtisticJudges,
          sectorKey: 'artistic',
          existingScores,
          existingPenaltyComments,
          existingJudgeComments
        },
        {
          tableTitle: 'Technique',
          criteria: technicalCriteria,
          judges: shadowTechnicalJudges,
          sectorKey: 'technical',
          includePenalty: true,
          existingScores,
          existingPenaltyComments,
          existingJudgeComments
        }
      ]
    });

    form.hidden = false;
    errorRoot.hidden = true;

    bindCommentToolbars(form);

    const existingDraft = loadManualDraft(draftStorageKey);

    if (applyManualDraft(form, existingDraft)) {
      showManualToast('Brouillon restauré automatiquement.', 'success');
    }

    document.querySelector('#manual-close-button')?.addEventListener('click', () => {
      window.close();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const scoreInputs = Array.from(form.querySelectorAll('.manual-score-input'));
      const requiredInputs = Array.from(form.querySelectorAll('.manual-score-input[required]'));
      const hasAnyScoreValue = scoreInputs.some((input) => String(input.value ?? '').trim() !== '');
      const hasAnyCommentValue = Array.from(form.querySelectorAll('[data-penalty-comment-for], [data-judge-comment-field]'))
        .some((field) => String(field.value ?? '').trim() !== '');
      const isCompletelyEmptySubmission = !hasAnyScoreValue && !hasAnyCommentValue;
      const invalidEntry = scoreInputs
        .map((input) => ({ input, result: validateScoreInput(input) }))
        .find(({ result }) => !result.isValid);
      const missingRequiredInputs = requiredInputs.filter((input) => !String(input.value ?? '').trim());
      const missingRequiredInput = missingRequiredInputs[0] ?? null;

      requiredInputs.forEach((input) => {
        if (String(input.value ?? '').trim()) {
          input.classList.remove('is-invalid');
        }
      });

      if (!isCompletelyEmptySubmission && missingRequiredInput) {
        missingRequiredInputs.forEach((input) => input.classList.add('is-invalid'));
        missingRequiredInput.focus();
        showManualToast('Au moins un des champs de notation n\'a pas été rempli', 'error');
        feedback.textContent = 'Toutes les notes juge/critere sont obligatoires.';
        feedback.className = 'manual-form-feedback is-error';
        return;
      }

      if (invalidEntry) {
        const { input: invalidInput, result } = invalidEntry;
        invalidInput.focus();

        if (invalidInput.dataset.criterionKey !== 'penalty:total' && result.reason === 'range') {
          showManualToast('Notes comprises entre 0 et 5 uniquement !', 'error');
          feedback.textContent = 'Notes comprises entre 0 et 5 uniquement !';
        } else {
          feedback.textContent = invalidInput.dataset.criterionKey === 'penalty:total'
            ? 'Le total des pénalités doit être supérieur ou égal à 0, par pas de 0,5.'
            : 'Chaque note doit être comprise entre 0 et 5, par pas de 0,5.';
        }

        feedback.className = 'manual-form-feedback is-error';
        return;
      }

      const payloads = scoreInputs
        .filter((input) => String(input.value ?? '').trim())
        .map((input) => ({
        competitionId,
        competitorId,
        judgeId: input.dataset.judgeId,
        criterion: input.dataset.criterionKey,
        score: parseScoreValue(input.value),
        comment: input.dataset.criterionKey === 'penalty:total'
          ? String(form.querySelector(`[data-penalty-comment-for="${input.dataset.judgeId}"]`)?.value ?? '').trim()
          : ''
      }));

      form.querySelectorAll('[data-judge-comment-field]').forEach((textarea) => {
        const comment = String(textarea.value ?? '').trim();

        if (!comment) {
          return;
        }

        const judgeId = String(textarea.dataset.judgeId ?? '').trim();

        if (!judgeId) {
          return;
        }

        payloads.push({
          competitionId,
          competitorId,
          judgeId,
          criterion: 'judge:comment',
          score: 0,
          comment
        });
      });

      try {
        await request('/api/manual-scoring/save', {
          method: 'POST',
          body: JSON.stringify({
            competitionId,
            competitorId,
            entries: payloads
          })
        });

        feedback.textContent = isCompletelyEmptySubmission
          ? `Notes effacees pour ${formatCompetitorLabel(competitor)}.`
          : `Notes enregistrees pour ${formatCompetitorLabel(competitor)}.`;
        feedback.className = 'manual-form-feedback is-success';
        manualScoringSaved = true;
        clearManualDraft(draftStorageKey);

        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            type: 'manual-scoring-saved',
            competitionId,
            competitorId,
            cleared: isCompletelyEmptySubmission
          }, window.location.origin);
        }

        window.close();
      } catch (error) {
        feedback.textContent = error.message;
        feedback.className = 'manual-form-feedback is-error';
      }
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
        if (input.dataset.criterionKey !== 'penalty:total' && validation.reason === 'range') {
          showManualToast('Notes comprises entre 0 et 5 uniquement !', 'error');
        }
        input.value = rawValue.replace(/\./g, ',');
        window.setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
        return;
      }

      input.value = formatScoreForDisplay(rawValue);
    });

    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') {
        return;
      }

      const activeInput = document.activeElement;

      if (!isLockedInvalidScoreInput(activeInput)) {
        return;
      }

      event.preventDefault();
      showManualToast('Notes comprises entre 0 et 5 uniquement !', 'error');
      activeInput.focus();
      activeInput.select();
    });

    form.addEventListener('mousedown', (event) => {
      const activeInput = document.activeElement;

      if (!isLockedInvalidScoreInput(activeInput)) {
        return;
      }

      const targetInput = event.target instanceof HTMLInputElement
        ? event.target
        : event.target?.closest?.('input, textarea, button, select');

      if (!targetInput || targetInput === activeInput) {
        return;
      }

      event.preventDefault();
      showManualToast('Notes comprises entre 0 et 5 uniquement !', 'error');
      activeInput.focus();
      activeInput.select();
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

    form.addEventListener('reset', (event) => {
      event.preventDefault();

      const scoreInputs = Array.from(form.querySelectorAll('.manual-score-input'));
      const penaltyComments = Array.from(form.querySelectorAll('[data-penalty-comment-for]'));
      const judgeComments = Array.from(form.querySelectorAll('[data-judge-comment-field]'));

      scoreInputs.forEach((input) => {
        input.value = '';
      });

      penaltyComments.forEach((textarea) => {
        textarea.value = '';
      });

      judgeComments.forEach((textarea) => {
        textarea.value = '';
      });

      feedback.textContent = '';
      feedback.className = 'manual-form-feedback';
      clearManualDraft(draftStorageKey);
    });
  } catch (error) {
    setError(error.message);
  }
  const notifyManualScoringClosed = () => {
    flushDraftSave();

    if (manualScoringSaved || closeNotificationSent || !window.opener || window.opener.closed) {
      return;
    }

    closeNotificationSent = true;

    window.opener.postMessage({
      type: 'manual-scoring-closed',
      competitionId,
      competitorId
    }, window.location.origin);
  };

  window.addEventListener('beforeunload', notifyManualScoringClosed);
  window.addEventListener('pagehide', notifyManualScoringClosed);
}

bootstrapManualScoring();
