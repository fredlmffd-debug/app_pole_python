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
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
    .map((criterion) => String(criterion.label ?? '').trim())
    .filter(Boolean);
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

  if (stageName) {
    return stageName;
  }

  return 'Candidat inconnu';
}

function formatEventDate(value) {
  if (!value) {
    return 'Date non définie';
  }

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function buildCompetitionMetaLabel(competition) {
  const location = String(competition?.location ?? '').trim();
  const date = formatEventDate(competition?.eventDate);

  if (location) {
    return `${location} / ${date}`;
  }

  return date;
}

function getJudgeTheme(judge) {
  const role = normalizeJudgeRole(judge?.judgeRole);
  const isShadow = Boolean(judge?.isTrainee);

  if (isShadow) {
    if (role === 'artistique') {
      return { badgeClass: 'is-shadow', badgeLabel: 'SHADOW ARTISTIQUE', useTechnicalCriteria: false };
    }

    if (role === 'head') {
      return { badgeClass: 'is-shadow', badgeLabel: 'SHADOW HEAD JUDGE', useTechnicalCriteria: true };
    }

    return { badgeClass: 'is-shadow', badgeLabel: 'SHADOW TECHNIQUE', useTechnicalCriteria: true };
  }

  if (role === 'artistique') {
    return { badgeClass: 'is-artistic', badgeLabel: 'ARTISTIQUE', useTechnicalCriteria: false };
  }

  if (role === 'head') {
    return { badgeClass: 'is-head', badgeLabel: 'HEAD JUDGE', useTechnicalCriteria: true };
  }

  return { badgeClass: 'is-technical', badgeLabel: 'TECHNIQUE', useTechnicalCriteria: true };
}

function buildJudgeDisplayName(judge) {
  const preferred = String(judge?.judgeName ?? '').trim();

  if (preferred) {
    return preferred;
  }

  const fallback = [String(judge?.judgeFirstName ?? '').trim(), String(judge?.judgeLastName ?? '').trim()]
    .filter(Boolean)
    .join(' ')
    .trim();

  return fallback || `Juge ${judge?.slotIndex ?? ''}`.trim();
}

function groupCompetitorsByCategory(competitors) {
  const activeCompetitors = (competitors ?? [])
    .filter((competitor) => String(competitor?.status ?? 'registered') === 'registered')
    .slice()
    .sort((left, right) => (Number(left.runningOrder) || 0) - (Number(right.runningOrder) || 0));

  const categoryMap = new Map();

  activeCompetitors.forEach((competitor) => {
    const category = String(competitor?.category ?? '').trim() || 'Sans catégorie';

    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }

    categoryMap.get(category).push(competitor);
  });

  return Array.from(categoryMap.entries()).map(([category, items]) => ({ category, competitors: items }));
}

function chunkArray(values, chunkSize) {
  const chunks = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function buildCandidateRows(competitors, criteriaCount, isHeadJudge) {
  const footerLabel = isHeadJudge ? 'Pénalités' : 'Commentaires';

  return competitors.map((competitor) => {
    const runningOrder = String(competitor.runningOrder ?? '').trim() || '-';
    const label = formatCompetitorLabel(competitor);

    return `
      <tbody>
        <tr class="scoring-sheet-candidate-row">
          <td class="scoring-sheet-candidate-cell">
            <table class="scoring-sheet-candidate-inner" role="presentation" aria-hidden="true">
              <tr>
                <td class="scoring-sheet-candidate-inner-badge">
                  <span class="scoring-sheet-order-badge">${escapeHtml(runningOrder)}</span>
                </td>
                <td class="scoring-sheet-candidate-inner-name">
                  <strong>${escapeHtml(label)}</strong>
                </td>
              </tr>
            </table>
          </td>
          ${Array.from({ length: criteriaCount }, () => '<td class="scoring-sheet-score-cell"></td>').join('')}
        </tr>
        <tr class="scoring-sheet-notes-row">
          <td class="scoring-sheet-notes-area" colspan="${criteriaCount + 1}">
            <span class="scoring-sheet-notes-watermark">${escapeHtml(footerLabel)}</span>
          </td>
        </tr>
      </tbody>
    `;
  }).join('');
}

function buildSheetPage({ competition, judge, category, competitors, criteria, isLastPage }) {
  const theme = getJudgeTheme(judge);
  const judgeName = buildJudgeDisplayName(judge);
  const isHeadJudge = normalizeJudgeRole(judge?.judgeRole) === 'head';
  const watermark = judge?.isTrainee ? '<span class="scoring-sheet-watermark">SHADOW</span>' : '';

  return `
    <section class="scoring-sheet-page ${isLastPage ? 'is-last' : ''}">
      ${watermark}
      <header class="scoring-sheet-page-head">
        <div class="scoring-sheet-discipline">Pole Dance</div>
        <div class="scoring-sheet-competition">${escapeHtml(buildCompetitionMetaLabel(competition))}</div>
        <div class="scoring-sheet-judge-badge ${theme.badgeClass}">${escapeHtml(`${theme.badgeLabel} : ${judgeName}`)}</div>
        <div class="scoring-sheet-signature">Signature :</div>
      </header>

      <div class="scoring-sheet-category">${escapeHtml(category)}</div>

      <table class="scoring-sheet-table" role="table" aria-label="Scoring sheet ${escapeHtml(judgeName)} ${escapeHtml(category)}">
        <thead>
          <tr>
            <th>Candidat</th>
            ${criteria.map((criterion) => `<th>${escapeHtml(criterion)}</th>`).join('')}
          </tr>
        </thead>
        ${buildCandidateRows(competitors, criteria.length, isHeadJudge)}
      </table>
    </section>
  `;
}

function sortJudges(assignments) {
  const roleRank = { artistique: 1, technique: 2, head: 3 };

  return (assignments ?? [])
    .filter((assignment) => assignment?.judgeId)
    .slice()
    .sort((left, right) => {
      const leftShadow = Boolean(left?.isTrainee);
      const rightShadow = Boolean(right?.isTrainee);

      if (leftShadow !== rightShadow) {
        return leftShadow ? 1 : -1;
      }

      const leftRole = normalizeJudgeRole(left?.judgeRole);
      const rightRole = normalizeJudgeRole(right?.judgeRole);
      const rankDelta = (roleRank[leftRole] ?? 99) - (roleRank[rightRole] ?? 99);

      if (rankDelta !== 0) {
        return rankDelta;
      }

      return (left?.slotIndex ?? 0) - (right?.slotIndex ?? 0);
    });
}

async function bootstrapScoringSheets() {
  const search = new URLSearchParams(window.location.search);
  const competitionId = String(search.get('competitionId') ?? '').trim();
  const onlyShadows = search.get('onlyShadows') === '1';
  const subtitle = document.querySelector('#scoring-sheets-subtitle');
  const toolbar = document.querySelector('#scoring-sheets-toolbar');
  const errorRoot = document.querySelector('#scoring-sheets-error');
  const pagesRoot = document.querySelector('#scoring-sheets-pages');
  const printButton = document.querySelector('#scoring-sheets-print');
  const titleHeading = document.querySelector('#scoring-sheets-toolbar h1');

  if (onlyShadows) {
    document.title = 'Pole Scoring - Scoring-shadows';
    if (titleHeading) {
      titleHeading.textContent = 'Scoring-shadows';
    }
  }

  const setError = (message) => {
    errorRoot.hidden = false;
    errorRoot.textContent = message;
    pagesRoot.hidden = true;
  };

  printButton?.addEventListener('click', async () => {
    if (!competitionId) {
      setError('Compétition manquante pour l\'export PDF.');
      return;
    }

    if (printButton) {
      printButton.disabled = true;
    }

    try {
      const payload = await request('/api/pdf/export', {
        method: 'POST',
        body: JSON.stringify({
          type: 'scoring_sheets',
          competitionId,
          onlyShadows
        })
      }, { forceLocal: true });

      if (subtitle) {
        subtitle.textContent = `PDF généré (${payload?.fileName ?? ''}). Ouverture du dossier des exports...`;
      }

      try {
        await request('/api/pdf/open-folder', {
          method: 'POST',
          body: JSON.stringify({ type: 'scoring_sheets' })
        }, { forceLocal: true });
      } catch {
        // Le PDF a bien été généré ; l'ouverture Explorer reste facultative.
      }
    } catch (error) {
      setError(error.message || 'Impossible de générer le PDF des scoring-sheets.');
    } finally {
      if (printButton) {
        printButton.disabled = false;
      }
    }
  });

  if (!competitionId) {
    setError(onlyShadows
      ? 'Paramètre compétition manquant pour générer les Scoring-shadows.'
      : 'Paramètre compétition manquant pour générer les Scoring-sheets.');
    return;
  }

  try {
    const [competitions, competitors, assignments, scoringProfilePayload] = await Promise.all([
      request('/api/competitions'),
      request(`/api/competitions/${competitionId}/competitors`),
      request(`/api/competitions/${competitionId}/judge-assignments`),
      request(`/api/competitions/${competitionId}/scoring-profile`)
    ]);

    const competition = (competitions ?? []).find((item) => String(item.id ?? '') === competitionId);

    if (!competition) {
      throw new Error('Compétition introuvable.');
    }

    const groupedCategories = groupCompetitorsByCategory(competitors);

    if (!groupedCategories.length) {
      throw new Error('Aucun compétiteur actif à imprimer pour cette compétition.');
    }

    const allJudges = sortJudges(assignments);
    const judges = onlyShadows ? allJudges.filter((judge) => Boolean(judge?.isTrainee)) : allJudges;

    if (!judges.length) {
      throw new Error(onlyShadows
        ? 'Aucun juge shadow affecté à cette compétition.'
        : 'Aucun juge affecté à cette compétition.');
    }

    const profile = scoringProfilePayload?.profile ?? null;
    const pages = [];

    judges.forEach((judge) => {
      const theme = getJudgeTheme(judge);

      groupedCategories.forEach((group) => {
        const firstCompetitor = group.competitors[0] ?? null;
        const scoringProfile = getScoringProfileForCompetitor(profile, firstCompetitor);
        const criteria = normalizeCriteria(theme.useTechnicalCriteria ? scoringProfile.technical?.criteria : scoringProfile.artistic?.criteria);
        const criteriaLabels = criteria.length > 0 ? criteria : ['Critère 1', 'Critère 2', 'Critère 3', 'Critère 4', 'Critère 5', 'Critère 6'];
        const chunks = chunkArray(group.competitors, 3);

        chunks.forEach((competitorsChunk) => {
          pages.push({
            competition,
            judge,
            category: group.category,
            competitors: competitorsChunk,
            criteria: criteriaLabels
          });
        });
      });
    });

    pagesRoot.innerHTML = pages.map((page, index) => {
      return buildSheetPage({
        ...page,
        isLastPage: index === pages.length - 1
      });
    }).join('');

    const judgeCountLabel = onlyShadows ? `${judges.length} juge(s) shadow` : `${judges.length} juge(s)`;
    subtitle.textContent = `${competition.name} · ${judgeCountLabel} · ${pages.length} page(s)`;
    pagesRoot.hidden = false;
    errorRoot.hidden = true;

    toolbar?.classList.add('is-ready');
  } catch (error) {
    setError(error.message || 'Impossible de générer les Scoring-sheets.');
  }
}

bootstrapScoringSheets();
