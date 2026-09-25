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
  const requestUrl = buildApiUrl(path, forceLocal);

  const response = await fetch(requestUrl, {
    headers: {
      'Content-Type': 'application/json'
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

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
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
  return stageName || 'Candidat inconnu';
}

function isResidentAthlete(result) {
  const directFlag = result?.isResident ?? result?.resident;

  if (directFlag === true || directFlag === 1 || directFlag === '1' || String(directFlag ?? '').trim().toLowerCase() === 'true') {
    return true;
  }

  const residentKeys = [
    result?.athleteType,
    result?.residencyStatus,
    result?.residency,
    result?.residentStatus,
    result?.originLabel,
    result?.stageName
  ];

  return residentKeys.some((entry) => normalizeText(entry).includes('resident'));
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

function compareResults(left, right) {
  const leftFinal = Number(left?.finalScore);
  const rightFinal = Number(right?.finalScore);

  if (Number.isFinite(leftFinal) && Number.isFinite(rightFinal) && leftFinal !== rightFinal) {
    return rightFinal - leftFinal;
  }

  const leftTechnical = Number(left?.technicalScore);
  const rightTechnical = Number(right?.technicalScore);

  if (Number.isFinite(leftTechnical) && Number.isFinite(rightTechnical) && leftTechnical !== rightTechnical) {
    return rightTechnical - leftTechnical;
  }

  const leftOrder = Number(left?.runningOrder);
  const rightOrder = Number(right?.runningOrder);

  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return formatCompetitorLabel(left).localeCompare(formatCompetitorLabel(right), 'fr');
}

function buildFullRankingRows(results) {
  let previousFinalScore = null;
  let previousTechnicalScore = null;
  let displayedRank = 0;

  return [...results]
    .sort(compareResults)
    .map((result, index) => {
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
        finalScoreValue: Number.isFinite(finalScore) ? finalScore : null,
        technicalScoreValue: Number.isFinite(technicalScore) ? technicalScore : null,
        finalScore: formatScore(result.finalScore),
        technicalScore: formatScore(result.technicalScore),
        artisticScore: formatScore(result.artisticScore),
        isResident: isResidentAthlete(result)
      };
    });
}

function applySelectiveRanking(fullRows) {
  let selectivePosition = 0;
  let displayedSelectiveRank = 0;
  let previousEligibleRow = null;

  return fullRows.map((row) => {
    if (row.isResident) {
      return {
        ...row,
        selectiveRank: null,
        // Meme regle que le podium (buildPodiumRows) : seul un resident dont
        // le rang brut aurait ete dans le top 3 recoit la mention du prix
        // special, pour rester coherent entre les deux vues.
        selectiveRankLabel: row.rank <= 3 ? 'Prix spécial du jury' : 'Résident'
      };
    }

    selectivePosition += 1;

    const hasSameScores = previousEligibleRow
      && Number.isFinite(row.finalScoreValue)
      && Number.isFinite(previousEligibleRow.finalScoreValue)
      && row.finalScoreValue === previousEligibleRow.finalScoreValue
      && row.technicalScoreValue === previousEligibleRow.technicalScoreValue;

    if (!hasSameScores) {
      displayedSelectiveRank = selectivePosition;
    }

    previousEligibleRow = row;

    return {
      ...row,
      selectiveRank: displayedSelectiveRank,
      selectiveRankLabel: String(displayedSelectiveRank)
    };
  });
}

function buildPodiumRows(fullRows) {
  const podiumRows = [];
  const specialPrizeRows = [];

  for (const row of fullRows) {
    if (podiumRows.length >= 3) {
      break;
    }

    if (row.isResident) {
      if (row.rank <= 3) {
        specialPrizeRows.push({
          label: 'Prix spécial du jury',
          candidateLabel: row.candidateLabel
        });
      }
      continue;
    }

    podiumRows.push({
      ...row,
      podiumRank: podiumRows.length + 1
    });
  }

  return {
    podiumRows,
    specialPrizeRows
  };
}

function groupByCategory(results) {
  const groups = new Map();

  (results ?? []).forEach((result) => {
    const category = String(result?.category ?? '').trim() || 'Sans catégorie';

    if (!groups.has(category)) {
      groups.set(category, []);
    }

    groups.get(category).push(result);
  });

  return Array.from(groups.entries())
    .map(([category, items]) => {
      const minOrder = items.reduce((acc, item) => {
        const runningOrder = Number(item?.runningOrder);
        return Number.isFinite(runningOrder) ? Math.min(acc, runningOrder) : acc;
      }, Number.MAX_SAFE_INTEGER);

      return {
        category,
        minOrder,
        items
      };
    })
    .sort((left, right) => {
      if (left.minOrder !== right.minOrder) {
        return left.minOrder - right.minOrder;
      }

      return left.category.localeCompare(right.category, 'fr');
    });
}

function buildRankingTableRows(rows) {
  return rows.map((row) => `
    <div class="competition-results-row competition-results-row--ranking${(!row.isResident && Number.isFinite(Number(row.selectiveRank)) && Number(row.selectiveRank) <= 3) ? ` is-podium-${Number(row.selectiveRank)}` : ''}" role="row">
      <span role="cell" class="competition-results-rank-cell">
        <strong>${escapeHtml(row.selectiveRankLabel)}</strong>
        ${(() => {
          const selectiveRank = Number(row.selectiveRank);
          const icon = Number.isFinite(selectiveRank) ? getPodiumIcon(selectiveRank) : null;
          return icon
            ? `<img class="competition-results-rank-icon" src="${icon.src}" alt="${escapeHtml(icon.alt)}">`
            : '';
        })()}
      </span>
      <span role="cell" class="competition-results-selective-cell${row.isResident ? ' is-resident' : ''}">
        <strong>${row.rank}</strong>
      </span>
      <span role="cell">${escapeHtml(row.candidateLabel)}</span>
      <span role="cell"><strong>${escapeHtml(row.finalScore)}</strong></span>
      <span role="cell">${escapeHtml(row.technicalScore)}</span>
      <span role="cell">${escapeHtml(row.artisticScore)}</span>
    </div>
  `).join('');
}

function buildPodiumTableRows(rows) {
  return rows.map((row) => `
    <div class="competition-results-row competition-results-row--podium is-podium-${row.podiumRank}" role="row">
      <span role="cell" class="competition-results-rank-cell">
        <strong>${row.podiumRank}</strong>
        ${(() => {
          const icon = getPodiumIcon(row.podiumRank);
          return icon
            ? `<img class="competition-results-rank-icon" src="${icon.src}" alt="${escapeHtml(icon.alt)}">`
            : '';
        })()}
      </span>
      <span role="cell">${escapeHtml(row.candidateLabel)}</span>
      <span role="cell"><strong>${escapeHtml(row.finalScore)}</strong></span>
      <span role="cell">${escapeHtml(row.technicalScore)}</span>
      <span role="cell">${escapeHtml(row.artisticScore)}</span>
    </div>
  `).join('');
}

function buildCategoryBlock({ category, fullRows, podiumRows, specialPrizeRows }, viewMode) {
  const showRanking = viewMode === 'all' || viewMode === 'ranking';
  const showPodium = viewMode === 'all' || viewMode === 'podium';
  const specialPrizeIcon = '/assets/icons/special-price.svg';

  return `
    <article class="competition-results-category">
      <header class="competition-results-category-head">
        <h3>${escapeHtml(category)}</h3>
        <span class="competition-results-category-meta">${fullRows.length} classé${fullRows.length > 1 ? 's' : ''}</span>
      </header>

      ${showRanking ? `
        <div class="competition-results-table" role="table" aria-label="Classement complet ${escapeHtml(category)}">
          <div class="competition-results-row competition-results-row--ranking competition-results-head" role="row">
            <span role="columnheader">Classement sélectif</span>
            <span role="columnheader">Classement épreuve</span>
            <span role="columnheader">Athlète</span>
            <span role="columnheader">Globale</span>
            <span role="columnheader">Technique</span>
            <span role="columnheader">Artistique</span>
          </div>
          ${buildRankingTableRows(fullRows)}
        </div>
      ` : ''}

      ${showPodium ? `
        <div class="competition-results-table" role="table" aria-label="Podium ${escapeHtml(category)}">
          <div class="competition-results-row competition-results-row--podium competition-results-head" role="row">
            <span role="columnheader">Podium</span>
            <span role="columnheader">Athlète</span>
            <span role="columnheader">Globale</span>
            <span role="columnheader">Technique</span>
            <span role="columnheader">Artistique</span>
          </div>
          ${podiumRows.length
            ? buildPodiumTableRows(podiumRows)
            : `<div class="competition-results-row" role="row"><span role="cell">—</span><span role="cell">Aucun podium disponible</span><span role="cell">—</span><span role="cell">—</span><span role="cell">—</span></div>`}
        </div>

        ${specialPrizeRows.length
          ? `<div class="competition-results-special-prizes">${specialPrizeRows.map((row) => `
              <div class="competition-results-special-prize-item">
                <span class="competition-results-special-prize-label">
                  <img class="competition-results-special-prize-icon" src="${specialPrizeIcon}" alt="Prix spécial">
                  ${escapeHtml(row.label)}
                </span>
                <span class="competition-results-special-prize-name">${escapeHtml(row.candidateLabel)}</span>
              </div>
            `).join('')}</div>`
          : ''}
      ` : ''}
    </article>
  `;
}

async function bootstrapCompetitionResults() {
  const search = new URLSearchParams(window.location.search);
  const competitionId = String(search.get('competitionId') ?? '').trim();
  const view = String(search.get('view') ?? 'all').trim().toLowerCase();
  const viewMode = view === 'ranking' || view === 'podium' ? view : 'all';

  const titleNode = document.querySelector('#competition-results-title');
  const subtitleNode = document.querySelector('#competition-results-subtitle');
  const errorRoot = document.querySelector('#competition-results-error');
  const contentRoot = document.querySelector('#competition-results-content');
  const printButton = document.querySelector('#competition-results-print');

  const setError = (message) => {
    if (errorRoot) {
      errorRoot.hidden = false;
      errorRoot.textContent = message;
    }

    if (contentRoot) {
      contentRoot.hidden = true;
    }
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
          type: 'competition_results',
          competitionId,
          view: viewMode
        })
      }, { forceLocal: true });

      if (subtitleNode) {
        subtitleNode.textContent = `PDF généré (${payload?.fileName ?? ''}). Ouverture du dossier des exports...`;
      }

      try {
        await request('/api/pdf/open-folder', {
          method: 'POST',
          body: JSON.stringify({ type: 'competition_results' })
        }, { forceLocal: true });
      } catch {
        // Le PDF a bien été généré ; l'ouverture Explorer reste facultative.
      }
    } catch (error) {
      setError(error.message || 'Impossible de générer le PDF des classements.');
    } finally {
      if (printButton) {
        printButton.disabled = false;
      }
    }
  });

  if (!competitionId) {
    setError('Paramètre compétition manquant.');
    return;
  }

  try {
    const [competitions, payload] = await Promise.all([
      request('/api/competitions').catch(() => []),
      request(`/api/competitions/${competitionId}/results`)
    ]);

    const competition = Array.isArray(competitions)
      ? competitions.find((item) => String(item.id) === competitionId)
      : null;

    const competitionTitle = competition?.name ?? `Compétition ${competitionId}`;
    const subtitlePrefix = viewMode === 'ranking'
      ? 'Classement complet'
      : viewMode === 'podium'
        ? 'Podiums'
        : 'Classement complet + Podiums';

    if (titleNode) {
      titleNode.textContent = `Résultats - ${competitionTitle}`;
    }

    if (subtitleNode) {
      subtitleNode.textContent = subtitlePrefix;
    }

    const rankedResults = (payload.results ?? [])
      .filter((result) => !result.status || result.status === 'registered')
      .filter((result) => Number.isFinite(Number(result.finalScore)));

    const categories = groupByCategory(rankedResults).map((group) => {
      const fullRows = applySelectiveRanking(buildFullRankingRows(group.items));
      const { podiumRows, specialPrizeRows } = buildPodiumRows(fullRows);

      return {
        category: group.category,
        fullRows,
        podiumRows,
        specialPrizeRows
      };
    });

    if (!categories.length) {
      if (contentRoot) {
        contentRoot.innerHTML = '<p class="empty-state">Aucun résultat calculable pour la compétition active.</p>';
        contentRoot.hidden = false;
      }
      return;
    }

    if (contentRoot) {
      contentRoot.innerHTML = categories.map((categoryData) => buildCategoryBlock(categoryData, viewMode)).join('');
      contentRoot.hidden = false;
    }
  } catch (error) {
    setError(error.message || 'Impossible de charger les résultats de la compétition.');
  }
}

bootstrapCompetitionResults();
