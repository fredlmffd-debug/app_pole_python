async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
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

const ROLE_ORDER = ['artistique', 'technique', 'head'];

const state = {
  competitionId: '',
  competitorId: '',
  pollTimer: null,
  finalizeInProgress: false,
  showShadows: false
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeRole(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ROLE_ORDER.includes(normalized) ? normalized : '';
}

function roleLabel(role) {
  if (role === 'artistique') {
    return 'Artistique';
  }

  if (role === 'technique') {
    return 'Technique';
  }

  if (role === 'head') {
    return 'Head';
  }

  return 'Juge';
}

function formatScore(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '—';
  }

  const hasDecimal = Math.abs(parsed - Math.round(parsed)) > 1e-9;
  return (hasDecimal ? parsed.toFixed(1) : parsed.toFixed(0)).replace('.', ',');
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

function buildJudgeName(assignment) {
  const explicit = String(assignment?.judgeName ?? '').trim();

  if (explicit) {
    return explicit;
  }

  const fullName = [
    String(assignment?.judgeFirstName ?? '').trim(),
    String(assignment?.judgeLastName ?? '').trim()
  ].filter(Boolean).join(' ');

  if (fullName) {
    return fullName;
  }

  const slotIndex = Number(assignment?.slotIndex ?? 0);
  return slotIndex > 0 ? `Juge ${slotIndex}` : 'Juge';
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

function buildRoleCriteria(profile, competitor) {
  const duo = isDuoCompetitor(competitor);
  const artisticProfile = duo ? profile?.artisticDuo : profile?.artisticSolo;
  const technicalProfile = duo ? profile?.technicalDuo : profile?.technicalSolo;

  return {
    artistique: normalizeCriteria(artisticProfile?.criteria).map((criterion) => `artistic:${criterion.criterionKey}`),
    technique: normalizeCriteria(technicalProfile?.criteria).map((criterion) => `technical:${criterion.criterionKey}`),
    head: normalizeCriteria(technicalProfile?.criteria).map((criterion) => `technical:${criterion.criterionKey}`)
  };
}

function groupAssignments(assignments = []) {
  const officials = assignments.filter((assignment) => assignment?.judgeId && !assignment?.isTrainee);
  const shadows = assignments.filter((assignment) => assignment?.judgeId && assignment?.isTrainee);

  const sortByRoleThenSlot = (left, right) => {
    const leftRole = normalizeRole(left?.judgeRole);
    const rightRole = normalizeRole(right?.judgeRole);
    const leftRoleIndex = ROLE_ORDER.indexOf(leftRole);
    const rightRoleIndex = ROLE_ORDER.indexOf(rightRole);

    if (leftRoleIndex !== rightRoleIndex) {
      return leftRoleIndex - rightRoleIndex;
    }

    return (left?.slotIndex ?? 0) - (right?.slotIndex ?? 0);
  };

  return {
    officials: officials.sort(sortByRoleThenSlot),
    shadows: shadows.sort(sortByRoleThenSlot)
  };
}

function buildRowsHtml(assignments, roleCriteria, scoreByKey, finalizedJudgeIds) {
  if (!assignments.length) {
    return '<p class="recap-empty">Aucun juge dans cette section.</p>';
  }

  return `
    <div class="recap-grid">
      ${assignments.map((assignment) => {
        const role = normalizeRole(assignment?.judgeRole);
        const criteria = roleCriteria[role] ?? [];
        const judgeId = String(assignment?.judgeId ?? '').trim();
        const notes = criteria.map((criterion) => formatScore(scoreByKey.get(`${judgeId}::${criterion}`)));
        const isFinalized = finalizedJudgeIds.has(judgeId);

        return `
          <article class="recap-row${isFinalized ? ' is-finalized' : ''}">
            <div class="recap-judge-meta">
              <strong>${escapeHtml(buildJudgeName(assignment))}</strong>
              <span>${escapeHtml(roleLabel(role))}</span>
            </div>
            <div class="recap-notes-row">
              ${notes.map((note) => `<span class="recap-note-cell">${escapeHtml(note)}</span>`).join('')}
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderRecap({ competitor, assignments, scoreByKey, finalizedJudgeIds, profile }) {
  const title = document.querySelector('#recap-title');
  const subtitle = document.querySelector('#recap-subtitle');
  const root = document.querySelector('#recap-root');
  const status = document.querySelector('#recap-status');

  const roleCriteria = buildRoleCriteria(profile, competitor);
  const grouped = groupAssignments(assignments);

  const runningOrder = String(competitor?.runningOrder ?? '-').trim();
  const competitorName = formatCompetitorLabel(competitor);
  const categoryLabel = String(competitor?.category ?? '').trim();

  title.textContent = `N° ${runningOrder} · ${competitorName}`;
  subtitle.textContent = categoryLabel ? `Catégorie · ${categoryLabel}` : 'Catégorie non renseignée';
  status.textContent = 'Mise à jour automatique toutes les 2 secondes.';

  root.innerHTML = `
    <section class="recap-block">
      <h2>Juges officiels</h2>
      ${buildRowsHtml(grouped.officials, roleCriteria, scoreByKey, finalizedJudgeIds)}
    </section>
    <section class="recap-block is-shadow" ${state.showShadows ? '' : 'hidden'}>
      <h2>Juges shadows</h2>
      ${buildRowsHtml(grouped.shadows, roleCriteria, scoreByKey, finalizedJudgeIds)}
    </section>
  `;
}

function syncShadowToggleUi() {
  const toggle = document.querySelector('#recap-shadow-toggle-input');

  if (toggle) {
    toggle.checked = state.showShadows;
  }
}

async function refresh() {
  const { competitionId, competitorId } = state;

  if (!competitionId || !competitorId) {
    throw new Error('Paramètres manquants');
  }

  const cacheBust = `t=${Date.now()}`;
  const [assignments, scoreEntries, scoringProfile, competitors] = await Promise.all([
    request(`/api/competitions/${encodeURIComponent(competitionId)}/judge-assignments?${cacheBust}`),
    request(`/api/competitions/${encodeURIComponent(competitionId)}/competitors/${encodeURIComponent(competitorId)}/scores?${cacheBust}`),
    request(`/api/competitions/${encodeURIComponent(competitionId)}/scoring-profile?${cacheBust}`),
    request(`/api/competitions/${encodeURIComponent(competitionId)}/competitors?${cacheBust}`)
  ]);

  const competitor = (Array.isArray(competitors) ? competitors : []).find((entry) => String(entry?.id ?? '').trim() === competitorId) ?? null;

  if (!competitor) {
    throw new Error('Compétiteur introuvable');
  }

  const scoreByKey = new Map();
  const finalizedJudgeIds = new Set();
  (Array.isArray(scoreEntries) ? scoreEntries : []).forEach((entry) => {
    const judgeId = String(entry?.judgeId ?? '').trim();
    const criterion = String(entry?.criterion ?? '').trim();

    if (!judgeId || !criterion) {
      return;
    }

    if (criterion === 'judge:finalized') {
      const finalizedValue = Number(entry?.score);

      if (Number.isFinite(finalizedValue) && finalizedValue >= 1) {
        finalizedJudgeIds.add(judgeId);
      }

      return;
    }

    scoreByKey.set(`${judgeId}::${criterion}`, Number(entry?.score));
  });

  renderRecap({
    competitor,
    assignments: Array.isArray(assignments) ? assignments : [],
    scoreByKey,
    finalizedJudgeIds,
    profile: scoringProfile?.profile ?? null
  });
}

function setError(message) {
  const status = document.querySelector('#recap-status');
  status.textContent = message;
}

function setSyncedStatus() {
  const status = document.querySelector('#recap-status');
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  status.textContent = `Synchronisé à ${hh}:${mm}:${ss}`;
}

function notifyConductor(type) {
  if (!window.opener || window.opener.closed) {
    return;
  }

  window.opener.postMessage({
    type,
    competitionId: state.competitionId,
    competitorId: state.competitorId
  }, window.location.origin);
}

async function finalizeRecap() {
  if (state.finalizeInProgress) {
    return;
  }

  state.finalizeInProgress = true;
  const button = document.querySelector('#recap-finalize');

  if (button) {
    button.disabled = true;
    button.textContent = 'Validation...';
  }

  try {
    await request('/api/presenter/finalize', {
      method: 'POST',
      body: JSON.stringify({
        competitionId: state.competitionId,
        competitorId: state.competitorId
      })
    });

    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    notifyConductor('tablet-recap-finalized');

    window.close();
  } catch (error) {
    state.finalizeInProgress = false;

    if (button) {
      button.disabled = false;
      button.textContent = 'Valider';
    }

    setError(error.message);
  }
}

function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  state.competitionId = String(params.get('competitionId') ?? '').trim();
  state.competitorId = String(params.get('competitorId') ?? '').trim();

  if (!state.competitionId || !state.competitorId) {
    setError('Compétition ou passage non défini.');
    return;
  }

  const finalizeButton = document.querySelector('#recap-finalize');
  const shadowToggle = document.querySelector('#recap-shadow-toggle-input');

  if (finalizeButton) {
    finalizeButton.addEventListener('click', () => {
      finalizeRecap().catch((error) => {
        setError(error.message);
      });
    });
  }

  if (shadowToggle) {
    shadowToggle.addEventListener('change', () => {
      state.showShadows = Boolean(shadowToggle.checked);
      refresh().then(() => {
        syncShadowToggleUi();
        setSyncedStatus();
      }).catch((error) => {
        setError(error.message);
      });
    });
  }

  syncShadowToggleUi();

  refresh().then(() => {
    syncShadowToggleUi();
    setSyncedStatus();
  }).catch((error) => {
    setError(error.message);
  });

  state.pollTimer = window.setInterval(() => {
    refresh().then(() => {
      syncShadowToggleUi();
      setSyncedStatus();
    }).catch((error) => {
      setError(error.message);
    });
  }, 2000);
}

window.addEventListener('beforeunload', () => {
  notifyConductor('tablet-recap-closed');

  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }
});

bootstrap();
