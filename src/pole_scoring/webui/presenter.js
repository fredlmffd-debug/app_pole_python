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

const presenterSearchParams = new URLSearchParams(window.location.search);
const PRESENTER_PREVIEW_RESULTS_WAITING = presenterSearchParams.get('preview') === 'results-waiting';

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

function formatPresenterDateLabel(value) {
  const raw = String(value ?? '').trim();

  if (!raw) {
    return '';
  }

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return raw;
  }

  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

function normalizeJudgeAssignments(assignments, { includeShadowTabletJudges = false } = {}) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter((assignment) => {
      const judgeId = String(assignment?.judgeId ?? '').trim();

      if (!judgeId) {
        return false;
      }

      return includeShadowTabletJudges || !Boolean(assignment?.isTrainee);
    })
    .slice()
    .sort((left, right) => {
      const leftSlot = Number(left?.slotIndex ?? Number.POSITIVE_INFINITY);
      const rightSlot = Number(right?.slotIndex ?? Number.POSITIVE_INFINITY);

      if (leftSlot !== rightSlot) {
        return leftSlot - rightSlot;
      }

      return String(left?.judgeName ?? '').localeCompare(String(right?.judgeName ?? ''), 'fr');
    });
}

function getJudgeBadgeLetter(assignment, index) {
  const slotIndex = Number(assignment?.slotIndex ?? Number.NaN);

  if (Number.isFinite(slotIndex) && slotIndex > 0) {
    const zeroBased = slotIndex - 1;

    if (zeroBased >= 0 && zeroBased < 26) {
      return String.fromCharCode(65 + zeroBased);
    }

    return String(slotIndex);
  }

  if (Number.isInteger(index) && index >= 0 && index < 26) {
    return String.fromCharCode(65 + index);
  }

  return '?';
}

function buildJudgeScoreStateMap(scores) {
  const stateByJudgeAndCompetitor = new Map();

  (Array.isArray(scores) ? scores : []).forEach((score) => {
    const competitorId = String(score?.competitorId ?? '').trim();
    const judgeId = String(score?.judgeId ?? '').trim();
    const criterion = String(score?.criterion ?? '').trim();

    if (!competitorId || !judgeId || !criterion) {
      return;
    }

    const key = `${competitorId}::${judgeId}`;
    const previous = stateByJudgeAndCompetitor.get(key) ?? { hasScore: false, finalized: false };

    if (criterion === 'judge:finalized') {
      const finalizedScore = Number(score?.score);
      previous.finalized = previous.finalized || (Number.isFinite(finalizedScore) && finalizedScore >= 1);
    } else if (
      criterion.startsWith('artistic:')
      || criterion.startsWith('technical:')
      || criterion === 'penalty:total'
      || criterion === 'judge:comment'
    ) {
      previous.hasScore = true;
    }

    stateByJudgeAndCompetitor.set(key, previous);
  });

  return stateByJudgeAndCompetitor;
}

function renderPresenterHeader(state) {
  const titleNode = document.querySelector('#presenter-competition-title');
  const locationNode = document.querySelector('#presenter-competition-location');

  if (!titleNode || !locationNode) {
    return;
  }

  const activeCompetitionName = String(state?.activeCompetition?.name ?? '').trim();
  const activeCompetitionLocation = String(state?.activeCompetition?.location ?? '').trim();
  const activeCompetitionDate = String(state?.activeCompetition?.eventDate ?? '').trim();
  const activePassageCompetitionName = String(state?.activePassage?.competitionName ?? '').trim();
  const activePassageCompetitionLocation = String(state?.activePassage?.location ?? '').trim();
  const activePassageCompetitionDate = String(state?.activePassage?.eventDate ?? '').trim();

  const competitionName = activePassageCompetitionName || activeCompetitionName || 'Compétition active';
  const competitionDate = formatPresenterDateLabel(activePassageCompetitionDate || activeCompetitionDate);

  titleNode.textContent = competitionDate ? `${competitionDate} - ${competitionName}` : competitionName;
  locationNode.textContent = activePassageCompetitionLocation || activeCompetitionLocation;
}

function getPresenterPodiumIcon(rank) {
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

function comparePresenterResults(left, right) {
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

function normalizePresenterText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isPresenterResident(result) {
  const directFlag = result?.isResident ?? result?.resident;

  if (directFlag === true || directFlag === 1 || directFlag === '1' || String(directFlag ?? '').trim().toLowerCase() === 'true') {
    return true;
  }

  return normalizePresenterText(result?.stageName).includes('resident');
}

function buildPresenterFullRankingRows(results) {
  let previousFinalScore = null;
  let previousTechnicalScore = null;
  let displayedRank = 0;

  return [...results]
    .sort(comparePresenterResults)
    .map((result, index) => {
      const finalScore = Number(result?.finalScore);
      const technicalScore = Number(result?.technicalScore);
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
        isResident: isPresenterResident(result),
        result
      };
    });
}

function buildPresenterPodiumRows(fullRows) {
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
      podiumRank: podiumRows.length + 1,
      candidateLabel: row.candidateLabel
    });
  }

  return {
    podiumRows,
    specialPrizeRows
  };
}

function collectPresenterSpecialPrizeRows(results) {
  const rows = [];

  (Array.isArray(results) ? results : []).forEach((result) => {
    const candidateLabel = formatCompetitorLabel(result);
    const labels = [];
    const scalarCandidates = [
      result?.specialPrize,
      result?.specialPrizeLabel,
      result?.specialAward,
      result?.award,
      result?.awardLabel,
      result?.prixSpecial,
      result?.prixSpecialLabel
    ];

    scalarCandidates.forEach((value) => {
      const label = String(value ?? '').trim();

      if (label) {
        labels.push(label);
      }
    });

    const listCandidates = [result?.specialPrizes, result?.specialAwards, result?.awards, result?.prixSpeciaux];
    listCandidates.forEach((value) => {
      if (!Array.isArray(value)) {
        return;
      }

      value.forEach((entry) => {
        const label = String(entry ?? '').trim();

        if (label) {
          labels.push(label);
        }
      });
    });

    labels.forEach((label) => {
      rows.push({
        label,
        candidateLabel
      });
    });
  });

  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.label}::${row.candidateLabel}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function renderPresenterResultsStage(state, root) {
  const results = Array.isArray(state?.results?.results) ? state.results.results : [];

  if (!results.length) {
    root.innerHTML = `
      <div class="presenter-stage-scroll">
        <p class="presenter-empty-state">Résultats indisponibles pour le moment.</p>
      </div>
    `;
    return;
  }

  const categoriesMap = new Map();

  results.forEach((result) => {
    const category = String(result?.category ?? '').trim() || 'Sans catégorie';

    if (!categoriesMap.has(category)) {
      categoriesMap.set(category, []);
    }

    categoriesMap.get(category).push(result);
  });

  const categoryGroups = [...categoriesMap.entries()]
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

  root.innerHTML = `
    <div class="presenter-stage-scroll">
      <div class="presenter-overview-head">
        <p class="eyebrow">Résultats podiums</p>
      </div>
      <div class="presenter-results-board">
        ${categoryGroups.map((group) => {
          const fullRows = buildPresenterFullRankingRows(group.items);
          const { podiumRows, specialPrizeRows: residentSpecialPrizeRows } = buildPresenterPodiumRows(fullRows);
          const declaredSpecialPrizeRows = collectPresenterSpecialPrizeRows(group.items);
          const specialPrizeRows = [...residentSpecialPrizeRows, ...declaredSpecialPrizeRows].filter((row, index, rows) => {
            const key = `${row.label}::${row.candidateLabel}`;
            return rows.findIndex((entry) => `${entry.label}::${entry.candidateLabel}` === key) === index;
          });

          return `
            <article class="presenter-results-category">
              <header class="presenter-results-category-head">
                <h3>${escapeHtml(group.category)}</h3>
              </header>
              <div class="presenter-results-list">
                ${podiumRows.length
                  ? podiumRows.map((row) => {
                    const icon = getPresenterPodiumIcon(row.podiumRank);
                    return `
                      <div class="presenter-results-item is-podium-${row.podiumRank}">
                        <span class="presenter-results-rank">
                          <strong>${row.podiumRank}</strong>
                          ${icon
                            ? `<img class="presenter-results-rank-icon" src="${icon.src}" alt="${escapeHtml(icon.alt)}">`
                            : ''}
                        </span>
                        <span class="presenter-results-name">${escapeHtml(row.candidateLabel)}</span>
                      </div>
                    `;
                  }).join('')
                  : '<p class="presenter-results-empty">Aucun podium disponible.</p>'}
              </div>
              ${specialPrizeRows.length
                ? `
                  <div class="presenter-special-prizes">
                    ${specialPrizeRows.map((row) => `
                      <div class="presenter-special-prize-item">
                        <span class="presenter-special-prize-label"><img class="presenter-special-prize-icon" src="/assets/icons/special-price.svg" alt="Prix spécial">${escapeHtml(row.label)}</span>
                        <span class="presenter-special-prize-name">${escapeHtml(row.candidateLabel)}</span>
                      </div>
                    `).join('')}
                  </div>
                `
                : ''}
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function focusPresenterActiveCategory(root) {
  const activePassageNode = root.querySelector('[data-presenter-active-passage="true"]');

  if (!(activePassageNode instanceof HTMLElement)) {
    return;
  }

  const activeCategory = activePassageNode.closest('details.presenter-category-item');

  if (activeCategory instanceof HTMLDetailsElement) {
    activeCategory.open = true;
  }

  const scroller = root.querySelector('.presenter-stage-scroll');

  if (!(scroller instanceof HTMLElement)) {
    return;
  }

  const target = activeCategory instanceof HTMLElement ? activeCategory : activePassageNode;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const topPadding = 28;
  const bottomPadding = 28;
  const isOutsideViewport = targetRect.top < scrollerRect.top + topPadding
    || targetRect.bottom > scrollerRect.bottom - bottomPadding;

  if (isOutsideViewport) {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

const presenterRuntimeState = {
  frozenResultsMode: false,
  frozenResultsCompetitionId: '',
  showPublishedResults: false,
  lastAutoFocusedPassageId: '',
  lastRenderedStage: '',
  lastPublishedResultsSignature: ''
};

function renderPresenterResultsWaitingState(root, { isPreview = false } = {}) {
  root.innerHTML = `
    <div class="presenter-stage-scroll presenter-stage-scroll--waiting">
      <section class="card form-card presenter-waiting-card judge-waiting-card">
        <h2 class="presenter-waiting-title">Compétition terminée</h2>
        <div class="pl" aria-hidden="true">
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__dot"></div>
          <div class="pl__text">En attente des résultats</div>
        </div>
      </section>
    </div>
  `;
}

function renderPresenterResultsReadyState(root, state) {
  root.innerHTML = `
    <div class="presenter-stage-scroll presenter-stage-scroll--waiting">
      <section class="card form-card presenter-waiting-card presenter-results-ready-card">
        <h2 class="presenter-waiting-title">Résultats disponibles</h2>
        <p class="presenter-empty-state presenter-waiting-subtitle">Le scrutateur a publié les résultats.</p>
        <div class="presenter-results-ready-actions">
          <button type="button" class="inline-link presenter-results-ready-link" data-presenter-action="show-results">Résultats</button>
        </div>
      </section>
    </div>
  `;
}

function renderStage(state) {
  const root = document.querySelector('#presenter-stage');
  if (!root) {
    return;
  }

  if (state?.resultsEnabled) {
    if (state?.showPublishedResults) {
      renderPresenterResultsStage(state, root);
    } else {
      renderPresenterResultsReadyState(root, state);
    }
    return;
  }

  if (PRESENTER_PREVIEW_RESULTS_WAITING && !state?.resultsEnabled) {
    renderPresenterResultsWaitingState(root, { isPreview: true });
    return;
  }

  const competitors = Array.isArray(state?.competitors) ? state.competitors : [];
  const resultRows = Array.isArray(state?.results?.results) ? state.results.results : [];
  const allScores = Array.isArray(state?.results?.scores) ? state.results.scores : [];
  const judgeAssignments = normalizeJudgeAssignments(state?.judgeAssignments, {
    includeShadowTabletJudges: Boolean(state?.includeShadowTabletJudges)
  });
  const activePassageId = String(state?.activePassage?.id ?? '').trim();
  const previouslyOpenCategoryKeys = new Set(
    [...root.querySelectorAll('details.presenter-category-item[open]')]
      .map((node) => String(node?.dataset?.categoryKey ?? '').trim())
      .filter(Boolean)
  );

  if (!state?.activeCompetition?.id) {
    root.innerHTML = `
      <div class="presenter-stage-scroll">
        <p class="presenter-empty-state">Aucune compétition active.</p>
      </div>
    `;
    return;
  }

  if (!competitors.length) {
    root.innerHTML = `
      <div class="presenter-stage-scroll">
        <p class="presenter-empty-state">Aucun passage enregistré pour la compétition active.</p>
      </div>
    `;
    return;
  }

  const resultByCompetitorId = new Map(
    resultRows.map((entry) => [String(entry?.id ?? '').trim(), entry])
  );
  const judgeScoreStateMap = buildJudgeScoreStateMap(allScores);

  const getPassageStatus = (competitorId) => {
    const result = resultByCompetitorId.get(competitorId) ?? null;
    const scoreCount = Number(result?.scoreCount ?? 0);
    const requiredCount = Number(result?.requiredCount ?? 0);
    const isActive = Boolean(activePassageId && competitorId === activePassageId);
    const isJudged = !isActive && requiredCount > 0 && scoreCount >= requiredCount;
    const isInProgress = isActive || (!isJudged && scoreCount > 0);

    return {
      scoreCount,
      requiredCount,
      isActive,
      isJudged,
      isInProgress
    };
  };

  const categoriesMap = new Map();

  competitors.forEach((competitor) => {
    const category = String(competitor?.category ?? '').trim() || 'Sans catégorie';

    if (!categoriesMap.has(category)) {
      categoriesMap.set(category, []);
    }

    categoriesMap.get(category).push(competitor);
  });

  const categoryGroups = [...categoriesMap.entries()]
    .map(([category, items]) => ({
      category,
      items: items.slice().sort((left, right) => (left?.runningOrder ?? 0) - (right?.runningOrder ?? 0))
    }))
    .sort((left, right) => {
      const leftFirstOrder = Number(left.items[0]?.runningOrder ?? Number.POSITIVE_INFINITY);
      const rightFirstOrder = Number(right.items[0]?.runningOrder ?? Number.POSITIVE_INFINITY);

      if (leftFirstOrder !== rightFirstOrder) {
        return leftFirstOrder - rightFirstOrder;
      }

      return left.category.localeCompare(right.category, 'fr');
    });

  const categoryMeta = categoryGroups.map((group) => {
    const hasActiveInGroup = group.items.some((entry) => String(entry?.id ?? '').trim() === activePassageId);
    const competitorsToJudge = group.items.filter((entry) => {
      const status = String(entry?.status ?? 'registered').trim().toLowerCase() || 'registered';
      return status === 'registered';
    });
    const categoryCompleted = competitorsToJudge.length > 0 && competitorsToJudge.every((competitor) => {
      const competitorId = String(competitor?.id ?? '').trim();
      return getPassageStatus(competitorId).isJudged;
    });

    return {
      hasActiveInGroup,
      categoryCompleted
    };
  });

  const allCategoriesCompleted = categoryMeta.length > 0 && categoryMeta.every((entry) => entry.categoryCompleted);

  if (allCategoriesCompleted) {
    renderPresenterResultsWaitingState(root, { isPreview: false });
    return;
  }

  let preOpenNextGroupIndex = -1;
  const activeGroupIndex = categoryMeta.findIndex((group) => group.hasActiveInGroup);

  if (activeGroupIndex >= 0) {
    const activeGroup = categoryGroups[activeGroupIndex];
    const activeItemIndex = activeGroup.items.findIndex((entry) => String(entry?.id ?? '').trim() === activePassageId);

    if (activeItemIndex >= 0) {
      const isLastItemInGroup = activeItemIndex === activeGroup.items.length - 1;
      const activeStatus = getPassageStatus(activePassageId);

      if (isLastItemInGroup && activeStatus.isInProgress) {
        for (let index = activeGroupIndex + 1; index < categoryGroups.length; index += 1) {
          if (!categoryMeta[index]?.categoryCompleted) {
            preOpenNextGroupIndex = index;
            break;
          }
        }
      }
    }
  }

  root.innerHTML = `
    <div class="presenter-stage-scroll">
      <div class="presenter-overview-head">
        <p class="eyebrow">Vue catégories</p>
      </div>
      <div class="presenter-accordion">
        ${categoryGroups.map((group, groupIndex) => {
        const hasActiveInGroup = Boolean(categoryMeta[groupIndex]?.hasActiveInGroup);
        const categoryCompleted = Boolean(categoryMeta[groupIndex]?.categoryCompleted);
        const categoryKey = encodeURIComponent(group.category);
        const shouldOpen = hasActiveInGroup
          || groupIndex === preOpenNextGroupIndex
          || previouslyOpenCategoryKeys.has(categoryKey);

                if (categoryCompleted) {
                  return `
                    <section class="presenter-category-item is-complete">
                      <div class="presenter-category-heading presenter-category-heading-locked">
                        <span class="presenter-category-label">${escapeHtml(group.category)}</span>
                        <span class="presenter-category-meta">
                          <span class="presenter-category-count">${group.items.length} passage${group.items.length > 1 ? 's' : ''}</span>
                          <span class="presenter-category-badge is-complete">Jugement terminé</span>
                        </span>
                      </div>
                    </section>
                  `;
                }

        return `
          <details class="presenter-category-item" data-category-key="${categoryKey}" ${shouldOpen ? 'open' : ''}>
            <summary>
              <span class="presenter-category-heading">
                <span class="presenter-category-label">${escapeHtml(group.category)}</span>
                        <span class="presenter-category-meta">
                          <span class="presenter-category-count">${group.items.length} passage${group.items.length > 1 ? 's' : ''}</span>
                        </span>
              </span>
            </summary>
            <div class="presenter-passages-list">
              ${group.items.map((competitor) => {
                const competitorId = String(competitor?.id ?? '').trim();
                const { isJudged, isInProgress, isActive } = getPassageStatus(competitorId);
                const statusLabel = isJudged
                  ? 'Jugé'
                  : isInProgress
                    ? 'En cours'
                    : 'À juger';
                const statusModifier = isJudged
                  ? 'judged'
                  : isInProgress
                    ? 'in-progress'
                    : 'to-judge';
                const officialJudgeAssignments = judgeAssignments.filter((assignment) => !Boolean(assignment?.isTrainee));
                const shadowJudgeAssignments = judgeAssignments.filter((assignment) => Boolean(assignment?.isTrainee));
                const buildJudgeBadgesHtml = (assignments, startIndex = 0) => assignments.map((assignment, assignmentOffset) => {
                  const judgeId = String(assignment?.judgeId ?? '').trim();
                  const assignmentIndex = startIndex + assignmentOffset;
                  const judgeName = String(assignment?.judgeName ?? '').trim() || `Juge ${assignmentIndex + 1}`;
                  const judgeRole = String(assignment?.judgeRole ?? '').trim();
                  const judgeKey = `${competitorId}::${judgeId}`;
                  const judgeScoreState = judgeScoreStateMap.get(judgeKey) ?? { hasScore: false, finalized: false };
                  const judgeStateModifier = judgeScoreState.finalized
                    ? 'judged'
                    : judgeScoreState.hasScore
                      ? 'in-progress'
                      : 'to-judge';
                  const judgeStateLabel = judgeScoreState.finalized
                    ? 'Jugement finalisé'
                    : judgeScoreState.hasScore
                      ? 'Jugement en cours'
                      : 'À juger';
                  const letter = getJudgeBadgeLetter(assignment, assignmentIndex);
                  const tooltip = `${judgeName}${judgeRole ? ` (${judgeRole})` : ''} · ${judgeStateLabel}`;

                  return `<span class="presenter-judge-dot is-${judgeStateModifier}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">${escapeHtml(letter)}</span>`;
                }).join('');
                const officialJudgeBadgesHtml = buildJudgeBadgesHtml(officialJudgeAssignments, 0);
                const shadowJudgeBadgesHtml = buildJudgeBadgesHtml(shadowJudgeAssignments, officialJudgeAssignments.length);
                const judgeBadgesSeparatorHtml = officialJudgeAssignments.length > 0 && shadowJudgeAssignments.length > 0
                  ? '<span class="presenter-judge-dot-separator" aria-hidden="true"></span>'
                  : '';
                const judgeBadgesHtml = `${officialJudgeBadgesHtml}${judgeBadgesSeparatorHtml}${shadowJudgeBadgesHtml}`;
                const judgeBadgesNode = statusModifier === 'in-progress'
                  ? `<span class="presenter-passage-judges" aria-label="État des juges">${judgeBadgesHtml}</span>`
                  : '';

                return `
                  <div class="presenter-passage-item is-${statusModifier}"${isActive ? ' data-presenter-active-passage="true"' : ''}>
                    <div class="presenter-passage-main">
                      <span class="presenter-passage-order">${escapeHtml(String(competitor?.runningOrder ?? '-'))}</span>
                      <span class="presenter-passage-name">${escapeHtml(formatCompetitorLabel(competitor))}</span>
                      ${judgeBadgesNode}
                    </div>
                    <span class="presenter-passage-status is-${statusModifier}">${escapeHtml(statusLabel)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </details>
        `;
      }).join('')}
      </div>
    </div>
  `;

  if (!activePassageId) {
    presenterRuntimeState.lastAutoFocusedPassageId = '';
    return;
  }

  if (presenterRuntimeState.lastAutoFocusedPassageId !== activePassageId) {
    focusPresenterActiveCategory(root);
    presenterRuntimeState.lastAutoFocusedPassageId = activePassageId;
  }
}

function syncPresenterActions(state) {
  const resultsLink = document.querySelector('#presenter-results-link');

  if (!resultsLink) {
    return;
  }

  const resultsUrl = String(state?.resultsUrl ?? '').trim() || '/competition-results.html';
  resultsLink.href = resultsUrl;
  resultsLink.hidden = true;
}

function renderJudges(state) {
  const root = document.querySelector('#presenter-judges');

  if (!root) {
    return;
  }

  root.innerHTML = state.judges.length === 0
    ? '<p class="empty-state">Aucun juge configuré.</p>'
    : state.judges.map((judge) => `
      <article class="presenter-judge ${judge.status === 'validated' ? 'is-validated' : 'is-pending'}">
        <div>
          <strong>${judge.name}</strong>
          <p>${judge.login || 'Login non défini'}</p>
        </div>
        <span>${judge.status === 'validated' ? 'Validé' : 'En jugement'}</span>
      </article>
    `).join('');
}

function renderProgress(state) {
  const progressNode = document.querySelector('#presenter-progress');
  const progressLabelNode = document.querySelector('#presenter-progress-label');

  if (!progressNode || !progressLabelNode) {
    return;
  }

  progressNode.textContent = `${state.progress.validated} / ${state.progress.total}`;
  progressLabelNode.textContent = state.activePassage
    ? 'Juges ayant validé la note du passage actif.'
    : 'Aucun passage actif.';
}

async function refreshPresenter() {
  const presenterState = await request('/api/presenter/state');
  const competitionId = String(presenterState?.activeCompetition?.id ?? '').trim();
  const resultsEnabled = Boolean(presenterState?.resultsEnabled);

  if (!competitionId) {
    presenterRuntimeState.frozenResultsMode = false;
    presenterRuntimeState.frozenResultsCompetitionId = '';
    presenterRuntimeState.showPublishedResults = false;
    presenterRuntimeState.lastAutoFocusedPassageId = '';
    presenterRuntimeState.lastRenderedStage = 'no-competition';
    presenterRuntimeState.lastPublishedResultsSignature = '';
    renderPresenterHeader(presenterState);
    renderStage({
      ...presenterState,
      competitors: [],
      results: { results: [], scores: [] }
    });
    syncPresenterActions(presenterState);
    return;
  }

  if (resultsEnabled) {
    if (presenterRuntimeState.frozenResultsCompetitionId !== competitionId) {
      presenterRuntimeState.showPublishedResults = false;
    }

    presenterRuntimeState.lastAutoFocusedPassageId = '';

    const shouldShowPublishedResults = presenterRuntimeState.showPublishedResults;
    const results = shouldShowPublishedResults
      ? await request(`/api/competitions/${encodeURIComponent(competitionId)}/results`)
      : { results: [], scores: [] };
    const publishedResultsRows = Array.isArray(results?.results) ? results.results : [];
    const publishedResultsSignature = shouldShowPublishedResults
      ? JSON.stringify(publishedResultsRows)
      : '';
    const canReusePublishedResultsView = shouldShowPublishedResults
      && presenterRuntimeState.lastRenderedStage === 'published-results'
      && presenterRuntimeState.lastPublishedResultsSignature === publishedResultsSignature;
    const viewState = {
      ...presenterState,
      showPublishedResults: shouldShowPublishedResults,
      results: results && typeof results === 'object' ? results : { results: [], scores: [] }
    };

    renderPresenterHeader(presenterState);

    if (!canReusePublishedResultsView) {
      renderStage(viewState);
    }

    presenterRuntimeState.frozenResultsMode = true;
    presenterRuntimeState.frozenResultsCompetitionId = competitionId;
    presenterRuntimeState.lastRenderedStage = shouldShowPublishedResults ? 'published-results' : 'published-ready';
    presenterRuntimeState.lastPublishedResultsSignature = publishedResultsSignature;

    syncPresenterActions(presenterState);
    return;
  }

  presenterRuntimeState.frozenResultsMode = false;
  presenterRuntimeState.frozenResultsCompetitionId = '';
  presenterRuntimeState.showPublishedResults = false;
  presenterRuntimeState.lastRenderedStage = 'live';
  presenterRuntimeState.lastPublishedResultsSignature = '';

  const [competitors, results, judgeAssignments] = await Promise.all([
    request(`/api/competitions/${encodeURIComponent(competitionId)}/competitors`),
    request(`/api/competitions/${encodeURIComponent(competitionId)}/results`),
    request(`/api/competitions/${encodeURIComponent(competitionId)}/judge-assignments`)
  ]);

  const viewState = {
    ...presenterState,
    competitors: Array.isArray(competitors) ? competitors : [],
    results: results && typeof results === 'object' ? results : { results: [], scores: [] },
    judgeAssignments: Array.isArray(judgeAssignments) ? judgeAssignments : []
  };

  renderPresenterHeader(viewState);
  renderStage(viewState);
  syncPresenterActions(viewState);
}

refreshPresenter().catch((error) => {
  document.querySelector('#presenter-stage').textContent = error.message;
});

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element
    ? event.target.closest('[data-presenter-action="show-results"]')
    : null;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  event.preventDefault();
  presenterRuntimeState.showPublishedResults = true;

  refreshPresenter().catch(() => {
  });
});

setInterval(() => {
  refreshPresenter().catch(() => {
  });
}, 2000);