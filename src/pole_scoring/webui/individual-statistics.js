function isLoopbackHost(hostname) {
  const value = String(hostname ?? '').trim().toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function buildApiUrl(path, forceLocal = false) {
  if (!forceLocal || isLoopbackHost(window.location.hostname)) {
    return path;
  }

  const port = window.location.port || '4380';
  return `http://127.0.0.1:${port}${path}`;
}

async function request(path, options = {}, { forceLocal = false } = {}) {
  const accessToken = window.sessionStorage.getItem('access-session-token')
    ?? window.localStorage.getItem('access-session-token')
    ?? '';

  const requestUrl = buildApiUrl(path, forceLocal);
  const shouldSendAccessToken = isLoopbackHost(window.location.hostname) || !forceLocal;

  const response = await fetch(requestUrl, {
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken && shouldSendAccessToken ? { 'X-Access-Token': accessToken } : {})
    },
    ...options
  });

  const contentType = response.headers.get('content-type') ?? '';
  let payload = null;
  let textPayload = '';

  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    textPayload = await response.text();
  }

  if (!response.ok) {
    const fallbackMessage = textPayload || `Erreur API (${response.status})`;

    if (response.status === 404) {
      throw new Error('Route API introuvable (404). Redémarre le serveur local puis réessaie.');
    }

    throw new Error(payload?.error ?? fallbackMessage);
  }

  return payload ?? {};
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeJudgeRole(role) {
  const value = String(role ?? '').trim().toLowerCase();

  if (value === 'artistique' || value === 'technique' || value === 'head') {
    return value;
  }

  return '';
}

function isDuoCompetitor(competitor) {
  if (Array.isArray(competitor?.members)) {
    return competitor.members.length > 1;
  }

  return String(competitor?.stageName ?? '').includes('/');
}

function normalizeCriteria(criteria) {
  return (criteria ?? [])
    .filter((criterion) => criterion?.isEnabled)
    .slice()
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
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

function formatPassageCompetitorLabel(competitor) {
  const runningOrder = Number(competitor?.runningOrder);
  const passage = Number.isFinite(runningOrder) && runningOrder > 0
    ? String(runningOrder)
    : '?';

  return `${passage} - ${formatCompetitorLabel(competitor)}`;
}

function formatJudgeDisplayName(assignment) {
  const explicit = String(assignment?.judgeName ?? '').trim();

  if (explicit) {
    return explicit;
  }

  const fullName = [String(assignment?.judgeFirstName ?? '').trim(), String(assignment?.judgeLastName ?? '').trim()]
    .filter(Boolean)
    .join(' ')
    .trim();

  return fullName || `Juge ${assignment?.slotIndex ?? ''}`.trim();
}

function formatScore(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '0';
  }

  return parsed.toFixed(2).replace('.', ',');
}

function formatFrenchDate(value) {
  if (!value) {
    return 'Date non définie';
  }

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
}

function compactCriterionLabel(value) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return '-';
  }

  if (normalized.length <= 14) {
    return normalized;
  }

  const words = normalized.split(' ').filter(Boolean);

  if (words.length >= 2) {
    const twoWords = `${words[0]} ${words[1]}`.trim();

    if (twoWords.length <= 14) {
      return `${twoWords}...`;
    }
  }

  return `${normalized.slice(0, 13)}...`;
}

function scoreMapByJudgeAndCriterion(scores, competitorId) {
  const map = new Map();
  const targetId = String(competitorId ?? '').trim();

  (scores ?? []).forEach((row) => {
    if (String(row?.competitorId ?? '').trim() !== targetId) {
      return;
    }

    const judgeId = String(row?.judgeId ?? '').trim();
    const criterion = String(row?.criterion ?? '').trim();

    if (!judgeId || !criterion) {
      return;
    }

    map.set(`${judgeId}::${criterion}`, row);
  });

  return map;
}

function buildSectorRows({ assignments, criteria, scoreMap, sectorPrefix, includeHeadForTechnical }) {
  const rows = [];
  const filteredAssignments = (assignments ?? []).filter((assignment) => {
    const role = normalizeJudgeRole(assignment?.judgeRole);

    if (sectorPrefix === 'artistic:') {
      return role === 'artistique';
    }

    return role === 'technique' || (includeHeadForTechnical && role === 'head');
  });

  const sortedAssignments = filteredAssignments.slice().sort((left, right) => {
    const leftIsShadow = Boolean(left?.isTrainee);
    const rightIsShadow = Boolean(right?.isTrainee);

    if (leftIsShadow !== rightIsShadow) {
      return leftIsShadow ? 1 : -1;
    }

    if (sectorPrefix === 'technical:' && includeHeadForTechnical) {
      const leftIsHead = normalizeJudgeRole(left?.judgeRole) === 'head';
      const rightIsHead = normalizeJudgeRole(right?.judgeRole) === 'head';

      if (leftIsHead !== rightIsHead) {
        return leftIsHead ? 1 : -1;
      }
    }

    return (Number(left?.slotIndex) || 0) - (Number(right?.slotIndex) || 0);
  });

  sortedAssignments.forEach((assignment) => {
    const judgeId = String(assignment?.judgeId ?? '').trim();

    if (!judgeId) {
      return;
    }

    const values = criteria.map((criterion) => {
      const criterionKey = `${sectorPrefix}${criterion.criterionKey}`;
      const score = scoreMap.get(`${judgeId}::${criterionKey}`)?.score;
      return Number.isFinite(Number(score)) ? Number(score) : 0;
    });

    rows.push({
      judgeLabel: formatJudgeDisplayName(assignment),
      isShadow: Boolean(assignment?.isTrainee),
      values
    });
  });

  return rows;
}

function buildAverageValues(rows, criteriaLength) {
  if (!rows.length || criteriaLength === 0) {
    return Array.from({ length: criteriaLength }, () => 0);
  }

  const sums = Array.from({ length: criteriaLength }, () => 0);

  rows.forEach((row) => {
    row.values.forEach((value, index) => {
      sums[index] += Number(value) || 0;
    });
  });

  return sums.map((value) => value / rows.length);
}

function getSeriesColor(index, isShadow) {
  const palette = ['#0ea5e9', '#ef4444', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#d946ef'];
  const base = palette[index % palette.length];
  return isShadow ? `${base}99` : base;
}

function buildLineChartSvg({ title, criteria, rows, codePrefix }) {
  const width = 620;
  const height = 270;
  const padLeft = 44;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 62;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  if (!criteria.length || !rows.length) {
    return `
      <article class="individual-stats-chart-card">
        <h4>${escapeHtml(title)}</h4>
        <p class="individual-stats-empty">Aucune donnée disponible pour ce graphique.</p>
      </article>
    `;
  }

  const xForIndex = (index) => padLeft + ((plotWidth * index) / Math.max(criteria.length - 1, 1));
  const yForValue = (value) => padTop + ((5 - Math.max(0, Math.min(5, value))) / 5) * plotHeight;

  const yTicks = Array.from({ length: 6 }, (_, index) => 5 - index);
  const yGrid = yTicks.map((tick) => {
    const y = yForValue(tick);
    return `
      <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="individual-stats-chart-grid" />
      <text x="${padLeft - 8}" y="${y + 4}" class="individual-stats-chart-axis-label" text-anchor="end">${escapeHtml(String(tick))}</text>
    `;
  }).join('');

  const series = rows.map((row, index) => {
    const points = row.values.map((value, pointIndex) => `${xForIndex(pointIndex)},${yForValue(value)}`).join(' ');
    const color = getSeriesColor(index, row.isShadow);
    const dash = row.isShadow ? '5 4' : '0';

    return `
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.2" stroke-dasharray="${dash}" />
      ${row.values.map((value, pointIndex) => `
        <circle cx="${xForIndex(pointIndex)}" cy="${yForValue(value)}" r="3" fill="${color}" />
      `).join('')}
    `;
  }).join('');

  const xLabels = criteria.map((criterion, index) => {
    const code = `${codePrefix}${index + 1}`;
    return `<text x="${xForIndex(index)}" y="${height - 28}" class="individual-stats-chart-xlabel" text-anchor="middle">${escapeHtml(code)}</text>`;
  }).join('');

  const legend = rows.map((row, index) => {
    const color = getSeriesColor(index, row.isShadow);
    return `
      <span class="individual-stats-legend-item">
        <span class="individual-stats-legend-dot" style="background:${color}"></span>
        ${escapeHtml(row.judgeLabel)}${row.isShadow ? ' (Shadow)' : ''}
      </span>
    `;
  }).join('');

  return `
    <article class="individual-stats-chart-card">
      <h4>${escapeHtml(title)}</h4>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
        ${yGrid}
        ${series}
        ${xLabels}
      </svg>
      <div class="individual-stats-legend">${legend}</div>
    </article>
  `;
}

function buildScoreTableHtml({ title, titleClass, criteria, rows, averageValues, codePrefix }) {
  const header = criteria.map((criterion) => `<th>${escapeHtml(criterion.label || criterion.criterionKey || '-')}</th>`).join('');
  const codeHeader = criteria.map((criterion, index) => `<th>${escapeHtml(`${codePrefix}${index + 1}`)}</th>`).join('');

  const averageCells = averageValues.map((value) => `<td>${escapeHtml(formatScore(value))}</td>`).join('');

  const judgeRows = rows.length
    ? rows.map((row) => `
      <tr${row.isShadow ? ' class="individual-stats-shadow-row"' : ''}>
        <td>${escapeHtml(row.judgeLabel)}</td>
        ${row.values.map((value) => `<td>${escapeHtml(formatScore(value))}</td>`).join('')}
      </tr>
    `).join('')
    : `<tr><td colspan="${criteria.length + 1}">Aucune note disponible.</td></tr>`;

  return `
    <article class="individual-stats-table-card">
      <p class="individual-stats-table-title ${titleClass}">${escapeHtml(title)}</p>
      <table class="individual-stats-grid" role="table">
        <thead>
          <tr>
            <th></th>
            ${header}
          </tr>
          <tr class="individual-stats-code-row">
            <th>Code</th>
            ${codeHeader}
          </tr>
        </thead>
        <tbody>
          <tr class="individual-stats-average-row">
            <td>Moyenne</td>
            ${averageCells}
          </tr>
          ${judgeRows}
        </tbody>
      </table>
    </article>
  `;
}

function buildCommentsTableHtml(title, rows) {
  const body = rows.length
    ? rows.map((row) => `
      <tr class="individual-stats-comment-row" data-is-shadow="${row.isShadow ? 'true' : 'false'}">
        <td>
          ${escapeHtml(row.judgeLabel)}
          ${row.isShadow ? '<span class="individual-stats-comment-shadow">Shadow</span>' : ''}
        </td>
        <td>${escapeHtml(row.comment)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="2">Aucun commentaire.</td></tr>';

  return `
    <article class="individual-stats-comments-card">
      <h4>${escapeHtml(title)}</h4>
      <table class="individual-stats-comments-table" role="table">
        <tbody>
          ${body}
        </tbody>
      </table>
    </article>
  `;
}

function buildCommentRows({ assignments, scoreMap, competitorId, sector }) {
  return (assignments ?? [])
    .map((assignment) => {
      const judgeId = String(assignment?.judgeId ?? '').trim();

      if (!judgeId) {
        return null;
      }

      const role = normalizeJudgeRole(assignment?.judgeRole);
      const isSectorMatch = sector === 'artistic'
        ? role === 'artistique'
        : role === 'technique' || role === 'head';

      if (!isSectorMatch) {
        return null;
      }

      const row = scoreMap.get(`${judgeId}::judge:comment`);
      const penaltyRow = scoreMap.get(`${judgeId}::penalty:total`);
      const baseComment = String(row?.comment || penaltyRow?.comment || '').trim();

      let comment = baseComment;
      const penaltyValue = Number(penaltyRow?.score);
      const shouldPrefixPenalty = sector === 'technical' && role === 'head' && Number.isFinite(penaltyValue);

      if (shouldPrefixPenalty && baseComment) {
        comment = `Penalites: ${formatScore(penaltyValue)} - ${baseComment}`;
      }

      if (!comment) {
        return null;
      }

      return {
        judgeLabel: formatJudgeDisplayName(assignment),
        isShadow: Boolean(assignment?.isTrainee),
        role,
        slotIndex: Number(assignment?.slotIndex) || 0,
        comment
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const getRank = (row) => {
        if (sector === 'technical') {
          if (!row.isShadow && row.role === 'technique') {
            return 0;
          }

          if (!row.isShadow && row.role === 'head') {
            return 1;
          }

          return 2;
        }

        return row.isShadow ? 1 : 0;
      };

      const rankDiff = getRank(left) - getRank(right);

      if (rankDiff !== 0) {
        return rankDiff;
      }

      const slotDiff = (left.slotIndex || 0) - (right.slotIndex || 0);

      if (slotDiff !== 0) {
        return slotDiff;
      }

      return left.judgeLabel.localeCompare(right.judgeLabel, 'fr');
    });
}

function buildCompetitorStatisticsCard({ competitor, competition, assignments, criteriaProfile, scoreRows }) {
  const competitorId = String(competitor?.id ?? '').trim();
  const scoreMap = scoreMapByJudgeAndCriterion(scoreRows, competitorId);
  const isDuo = isDuoCompetitor(competitor);

  const artisticCriteria = normalizeCriteria(isDuo ? criteriaProfile?.artisticDuo?.criteria : criteriaProfile?.artisticSolo?.criteria);
  const technicalCriteria = normalizeCriteria(isDuo ? criteriaProfile?.technicalDuo?.criteria : criteriaProfile?.technicalSolo?.criteria);

  const artisticRows = buildSectorRows({
    assignments,
    criteria: artisticCriteria,
    scoreMap,
    sectorPrefix: 'artistic:',
    includeHeadForTechnical: false
  });

  const technicalRows = buildSectorRows({
    assignments,
    criteria: technicalCriteria,
    scoreMap,
    sectorPrefix: 'technical:',
    includeHeadForTechnical: true
  });

  const artisticAverage = buildAverageValues(artisticRows.filter((row) => !row.isShadow), artisticCriteria.length);
  const technicalAverage = buildAverageValues(technicalRows.filter((row) => !row.isShadow), technicalCriteria.length);

  const artisticComments = buildCommentRows({
    assignments,
    scoreMap,
    competitorId,
    sector: 'artistic'
  });

  const technicalComments = buildCommentRows({
    assignments,
    scoreMap,
    competitorId,
    sector: 'technical'
  });

  const competitionDate = formatFrenchDate(competition?.eventDate);
  const location = String(competition?.location ?? '').trim() || 'Lieu non défini';
  const category = String(competitor?.category ?? '').trim() || 'Sans catégorie';
  const passageCandidateLabel = formatPassageCompetitorLabel(competitor);

  return `
    <article class="individual-stats-card" data-competitor-id="${escapeHtml(competitorId)}">
      <header class="individual-stats-card-head">
        <div>
          <strong>${escapeHtml(passageCandidateLabel)}</strong>
          <span>${escapeHtml(category)}</span>
        </div>
        <span>${escapeHtml(`${competitionDate} • ${location}`)}</span>
      </header>

      <section class="individual-stats-main-grid">
        ${buildScoreTableHtml({
          title: 'Artistique',
          titleClass: 'is-artistic',
          criteria: artisticCriteria,
          rows: artisticRows,
          averageValues: artisticAverage,
          codePrefix: 'A'
        })}

        ${buildScoreTableHtml({
          title: 'Technique',
          titleClass: 'is-technical',
          criteria: technicalCriteria,
          rows: technicalRows,
          averageValues: technicalAverage,
          codePrefix: 'T'
        })}
      </section>

      <section class="individual-stats-comments-grid">
        ${buildCommentsTableHtml('Commentaires Artistique', artisticComments)}
        ${buildCommentsTableHtml('Commentaires Technique', technicalComments)}
      </section>

      <section class="individual-stats-charts-grid">
        ${buildLineChartSvg({
          title: 'Analyse notation - Artistique',
          criteria: artisticCriteria,
          rows: artisticRows,
          codePrefix: 'A'
        })}
        ${buildLineChartSvg({
          title: 'Analyse notation - Technique',
          criteria: technicalCriteria,
          rows: technicalRows,
          codePrefix: 'T'
        })}
      </section>
    </article>
  `;
}

function setVisibleCompetitorCard(competitorId) {
  document.querySelectorAll('.individual-stats-card[data-competitor-id]').forEach((card) => {
    const cardId = String(card.getAttribute('data-competitor-id') ?? '').trim();
    const isVisible = competitorId && cardId === competitorId;
    card.hidden = !isVisible;
    card.setAttribute('data-print-target', isVisible ? 'true' : 'false');
  });
}

function mmToPx(valueMm) {
  return (Number(valueMm) * 96) / 25.4;
}

function getPrintableHeightPx() {
  const pageHeightMm = 210; // A4 landscape
  const marginMm = 6;
  return mmToPx(pageHeightMm - (marginMm * 2)) - 8;
}

function applyPrintZoom(cards) {
  const printableHeightPx = getPrintableHeightPx();
  const isShadowCommentsHidden = document.body.classList.contains('individual-stats-hide-shadow-comments');
  document.body.classList.add('individual-stats-force-print-layout');

  cards.forEach((card) => {
    card.style.setProperty('--print-zoom', '1');
  });

  if (!isShadowCommentsHidden) {
    document.body.classList.remove('individual-stats-force-print-layout');
    return;
  }

  cards.forEach((card) => {
    const naturalHeight = Math.max(card.getBoundingClientRect().height, card.scrollHeight, 1);
    const computedZoom = Math.min(1, printableHeightPx / naturalHeight);
    const safeZoom = Math.max(0.62, computedZoom);
    card.style.setProperty('--print-zoom', String(Number(safeZoom.toFixed(3))));
  });

  document.body.classList.remove('individual-stats-force-print-layout');
}

function clearPrintZoom() {
  document.querySelectorAll('.individual-stats-card[data-competitor-id]').forEach((card) => {
    card.style.removeProperty('--print-zoom');
  });
}

function getCardsForCurrentPrintMode() {
  const isCurrentMode = document.body.dataset.printMode === 'current';

  if (isCurrentMode) {
    return Array.from(document.querySelectorAll('.individual-stats-card[data-competitor-id][data-print-target="true"]'));
  }

  return Array.from(document.querySelectorAll('.individual-stats-card[data-competitor-id]'));
}

function applyShadowCommentVisibility(enabled) {
  document.body.classList.toggle('individual-stats-hide-shadow-comments', Boolean(enabled));
}

function buildCompetitorSelectOptions(competitors, selectedId) {
  return [
    '<option value="">Sélectionnez un candidat</option>',
    ...competitors.map((competitor) => {
      const competitorId = String(competitor?.id ?? '').trim();
      const label = formatPassageCompetitorLabel(competitor);
      const selected = competitorId === selectedId ? ' selected' : '';
      return `<option value="${escapeHtml(competitorId)}"${selected}>${escapeHtml(label)}</option>`;
    })
  ].join('');
}

async function bootstrapIndividualStatistics() {
  const search = new URLSearchParams(window.location.search);
  const competitionId = String(search.get('competitionId') ?? '').trim();
  const requestedPrintMode = String(search.get('printMode') ?? '').trim().toLowerCase() === 'current' ? 'current' : 'all';
  const requestedCompetitorId = String(search.get('competitorId') ?? '').trim();
  const isPdfExportMode = search.get('exportPdf') === '1';
  const forceHideShadowComments = search.get('hideShadowComments');

  const subtitleNode = document.querySelector('#individual-stats-subtitle');
  const selectNode = document.querySelector('#individual-stats-competitor-select');
  const printCurrentButton = document.querySelector('#individual-stats-print-current');
  const printAllButton = document.querySelector('#individual-stats-print-all');
  const hideShadowCommentsNode = document.querySelector('#individual-stats-hide-shadow-comments');
  const errorRoot = document.querySelector('#individual-stats-error');
  const contentRoot = document.querySelector('#individual-stats-content');

  const HIDE_SHADOW_COMMENTS_STORAGE_KEY = 'individual-stats-hide-shadow-comments';

  const setError = (message) => {
    if (errorRoot) {
      errorRoot.hidden = false;
      errorRoot.textContent = message;
    }

    if (contentRoot) {
      contentRoot.hidden = true;
    }
  };

  const initialHideShadowComments = forceHideShadowComments === 'true'
    ? true
    : forceHideShadowComments === 'false'
      ? false
      : window.localStorage.getItem(HIDE_SHADOW_COMMENTS_STORAGE_KEY) === 'true';
  applyShadowCommentVisibility(initialHideShadowComments);

  if (hideShadowCommentsNode) {
    hideShadowCommentsNode.checked = initialHideShadowComments;
    hideShadowCommentsNode.addEventListener('change', () => {
      const enabled = Boolean(hideShadowCommentsNode.checked);
      window.localStorage.setItem(HIDE_SHADOW_COMMENTS_STORAGE_KEY, enabled ? 'true' : 'false');
      applyShadowCommentVisibility(enabled);
    });
  }

  if (!competitionId) {
    setError('Paramètre compétition manquant.');
    return;
  }

  try {
    const [competitions, assignments, scoringProfile, resultsPayload] = await Promise.all([
      request('/api/competitions').catch(() => []),
      request(`/api/competitions/${competitionId}/judge-assignments`).catch(() => []),
      request(`/api/competitions/${competitionId}/scoring-profile`).catch(() => ({ profile: {} })),
      request(`/api/competitions/${competitionId}/results`).catch(() => ({ results: [], scores: [] }))
    ]);

    const activeCompetition = Array.isArray(competitions)
      ? competitions.find((item) => String(item.id) === competitionId)
      : null;

    if (!activeCompetition) {
      throw new Error('Compétition introuvable.');
    }

    const competitors = await request(`/api/competitions/${competitionId}/competitors`);

    const eligibleCompetitors = (competitors ?? [])
      .filter((competitor) => String(competitor?.status ?? 'registered') === 'registered')
      .sort((left, right) => (Number(left?.runningOrder) || 0) - (Number(right?.runningOrder) || 0));

    if (!eligibleCompetitors.length) {
      throw new Error('Aucun candidat disponible pour cette compétition.');
    }

    if (subtitleNode) {
      subtitleNode.textContent = `${activeCompetition.name} • ${formatFrenchDate(activeCompetition.eventDate)} • ${activeCompetition.location || 'Lieu non défini'}`;
    }

    const cardsHtml = eligibleCompetitors.map((competitor) => buildCompetitorStatisticsCard({
      competitor,
      competition: activeCompetition,
      assignments,
      criteriaProfile: scoringProfile?.profile ?? {},
      scoreRows: resultsPayload?.scores ?? []
    })).join('');

    if (contentRoot) {
      contentRoot.innerHTML = cardsHtml;
      contentRoot.hidden = false;
    }

    let selectedCompetitorId = String(eligibleCompetitors[0]?.id ?? '').trim();
    if (requestedCompetitorId && eligibleCompetitors.some((competitor) => String(competitor?.id ?? '').trim() === requestedCompetitorId)) {
      selectedCompetitorId = requestedCompetitorId;
    }

    if (selectNode) {
      selectNode.innerHTML = buildCompetitorSelectOptions(eligibleCompetitors, selectedCompetitorId);
      selectNode.addEventListener('change', () => {
        selectedCompetitorId = String(selectNode.value ?? '').trim();
        setVisibleCompetitorCard(selectedCompetitorId);
      });
    }

    setVisibleCompetitorCard(selectedCompetitorId);

    const configureCardsForPrintMode = (mode) => {
      document.body.dataset.printMode = mode === 'current' ? 'current' : 'all';

      if (mode === 'current') {
        setVisibleCompetitorCard(selectedCompetitorId);
        return;
      }

      const allCards = Array.from(document.querySelectorAll('.individual-stats-card[data-competitor-id]'));
      allCards.forEach((card) => {
        card.hidden = false;
        card.setAttribute('data-print-target', 'false');
      });
    };

    if (!isPdfExportMode) {
      window.addEventListener('beforeprint', () => {
        applyPrintZoom(getCardsForCurrentPrintMode());
      });

      window.addEventListener('afterprint', () => {
        clearPrintZoom();
      });
    }

    printCurrentButton?.addEventListener('click', async () => {
      if (!selectedCompetitorId) {
        return;
      }

      if (printCurrentButton) {
        printCurrentButton.disabled = true;
      }

      try {
        const payload = await request('/api/pdf/export', {
          method: 'POST',
          body: JSON.stringify({
            type: 'individual_statistics',
            competitionId,
            printMode: 'current',
            competitorId: selectedCompetitorId,
            hideShadowComments: Boolean(hideShadowCommentsNode?.checked)
          })
        }, { forceLocal: true });

        if (subtitleNode) {
          subtitleNode.textContent = `PDF généré (${payload?.fileName ?? ''}). Ouverture du dossier des exports...`;
        }

        try {
          await request('/api/pdf/open-folder', {
            method: 'POST',
            body: JSON.stringify({ type: 'individual_statistics' })
          }, { forceLocal: true });
        } catch {
          // Le PDF a bien été généré ; l'ouverture Explorer reste facultative.
        }
      } catch (error) {
        setError(error.message || 'Impossible de générer le PDF individuel.');
      } finally {
        if (printCurrentButton) {
          printCurrentButton.disabled = false;
        }
      }
    });

    printAllButton?.addEventListener('click', async () => {
      if (printAllButton) {
        printAllButton.disabled = true;
      }

      try {
        const payload = await request('/api/pdf/export', {
          method: 'POST',
          body: JSON.stringify({
            type: 'individual_statistics',
            competitionId,
            printMode: 'all',
            hideShadowComments: Boolean(hideShadowCommentsNode?.checked)
          })
        }, { forceLocal: true });

        if (subtitleNode) {
          subtitleNode.textContent = `PDF généré (${payload?.fileName ?? ''}). Ouverture du dossier des exports...`;
        }

        try {
          await request('/api/pdf/open-folder', {
            method: 'POST',
            body: JSON.stringify({ type: 'individual_statistics' })
          }, { forceLocal: true });
        } catch {
          // Le PDF a bien été généré ; l'ouverture Explorer reste facultative.
        }
      } catch (error) {
        setError(error.message || 'Impossible de générer le PDF global.');
      } finally {
        if (printAllButton) {
          printAllButton.disabled = false;
        }
      }
    });

    if (isPdfExportMode) {
      configureCardsForPrintMode(requestedPrintMode);
      applyPrintZoom(getCardsForCurrentPrintMode());
    }
  } catch (error) {
    setError(error.message || 'Impossible de charger les statistiques individuelles.');
  }
}

bootstrapIndividualStatistics();
