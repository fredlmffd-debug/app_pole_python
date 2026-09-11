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

function formatScore(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return '—';
  }

  return parsed.toFixed(2).replace('.', ',');
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

function formatCompetitorLabel(result) {
  const firstNames = splitMembers(result?.firstName);
  const lastNames = splitMembers(result?.lastName);
  const memberCount = Math.max(firstNames.length, lastNames.length);

  if (memberCount > 0) {
    const members = Array.from({ length: memberCount }, (_, index) => formatNameFirstLast(firstNames[index], lastNames[index]))
      .filter(Boolean);

    if (members.length > 0) {
      return members.join(' & ');
    }
  }

  const stageName = String(result?.stageName ?? '').trim();

  if (stageName) {
    return stageName;
  }

  return 'Candidat inconnu';
}

function getPodiumIcon(rank) {
  if (rank === 1) {
    return { src: '/assets/icons/or.png', alt: 'Médaille d\'or' };
  }

  if (rank === 2) {
    return { src: '/assets/icons/argent.png', alt: 'Médaille d\'argent' };
  }

  if (rank === 3) {
    return { src: '/assets/icons/bronze.png', alt: 'Médaille de bronze' };
  }

  return null;
}

function buildRankingRows(results) {
  let previousFinalScore = null;
  let previousTechnicalScore = null;
  let displayedRank = 0;

  return results.map((result, index) => {
    const finalScore = Number(result.finalScore);
    const technicalScore = Number(result.technicalScore);
    const hasSameScores = index > 0
      && Number.isFinite(finalScore)
      && Number.isFinite(previousFinalScore)
      && finalScore === previousFinalScore
      && technicalScore === previousTechnicalScore;

    if (!hasSameScores) {
      displayedRank = index + 1;
    }

    previousFinalScore = finalScore;
    previousTechnicalScore = technicalScore;

    return {
      rank: displayedRank,
      candidateLabel: formatCompetitorLabel(result),
      finalScore: formatScore(result.finalScore),
      technicalScore: formatScore(result.technicalScore),
      artisticScore: formatScore(result.artisticScore)
    };
  });
}

async function bootstrapCategoryResults() {
  const search = new URLSearchParams(window.location.search);
  const competitionId = String(search.get('competitionId') ?? '').trim();
  const category = String(search.get('category') ?? '').trim();
  const errorRoot = document.querySelector('#category-results-error');
  const contentRoot = document.querySelector('#category-results-content');
  const competitionName = document.querySelector('#category-results-competition');
  const categoryName = document.querySelector('#category-results-category');
  const rowsRoot = document.querySelector('#category-results-rows');
  const closeButton = document.querySelector('#category-results-close-button');

  const setError = (message) => {
    errorRoot.hidden = false;
    errorRoot.textContent = message;
    contentRoot.hidden = true;
  };

  closeButton?.addEventListener('click', () => {
    window.close();
  });

  if (!competitionId || !category) {
    setError('Parametres manquants pour afficher le classement de la categorie.');
    return;
  }

  try {
    const [competitions, payload] = await Promise.all([
      request('/api/competitions').catch(() => []),
      request(`/api/competitions/${competitionId}/results?category=${encodeURIComponent(category)}`)
    ]);

    const competition = Array.isArray(competitions)
      ? competitions.find((item) => String(item.id) === competitionId)
      : null;

    competitionName.textContent = competition?.name ?? `Compétition ${competitionId}`;
    categoryName.textContent = category;

    const rankedResults = (payload.results ?? [])
      .filter((result) => !result.status || result.status === 'registered')
      .filter((result) => Number.isFinite(Number(result.finalScore)));

    if (!rankedResults.length) {
      rowsRoot.innerHTML = '<p class="empty-state">Aucun classement disponible pour cette categorie.</p>';
      contentRoot.hidden = false;
      return;
    }

    const rows = buildRankingRows(rankedResults);
    rowsRoot.innerHTML = rows.map((row) => `
      <div class="category-results-row${row.rank <= 3 ? ` is-rank-${row.rank}` : ''}" role="row">
        <span role="cell" class="category-results-rank-cell">
          <strong>${row.rank}</strong>
          ${(() => {
            const icon = getPodiumIcon(row.rank);
            return icon
              ? `<img class="category-results-rank-icon" src="${icon.src}" alt="${escapeHtml(icon.alt)}">`
              : '';
          })()}
        </span>
        <span role="cell">${escapeHtml(row.candidateLabel)}</span>
        <span role="cell"><strong>${escapeHtml(row.finalScore)}</strong></span>
        <span role="cell">${escapeHtml(row.technicalScore)}</span>
        <span role="cell">${escapeHtml(row.artisticScore)}</span>
      </div>
    `).join('');

    contentRoot.hidden = false;
  } catch (error) {
    setError(error.message || 'Impossible de charger le classement de la categorie.');
  }
}

bootstrapCategoryResults();