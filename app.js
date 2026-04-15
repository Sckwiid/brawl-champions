const statusEl = document.querySelector('#status');
const searchInputEl = document.querySelector('#playerTagSearch');
const clearSearchBtnEl = document.querySelector('#clearSearchBtn');
const searchMetaEl = document.querySelector('#searchMeta');
const playersGridEl = document.querySelector('#playersGrid');
const lastUpdateEl = document.querySelector('#lastUpdate');
const cardTemplate = document.querySelector('#playerCardTemplate');
let renderedPlayers = [];
let searchEventsBound = false;
let totalPlayersInDatabase = 0;

const currencyFormatter = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function normalizeTag(tag) {
  if (!tag || typeof tag !== 'string') {
    return null;
  }
  return `#${tag.trim().toUpperCase().replace(/^#/, '')}`;
}

function formatDate(value) {
  if (!value) {
    return 'inconnue';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'inconnue';
  }

  return date.toLocaleString('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function buildLiquipediaArticleUrl(pageName) {
  if (!pageName || typeof pageName !== 'string') {
    return 'https://liquipedia.net/brawlstars/Main_Page';
  }

  const page = pageName.trim().replace(/\s+/g, '_');
  if (!page) {
    return 'https://liquipedia.net/brawlstars/Main_Page';
  }

  return `https://liquipedia.net/brawlstars/${page}`;
}

function computeTopBrawlers(matches) {
  const byBrawler = new Map();

  for (const match of matches) {
    const name = match?.brawler?.name;
    if (!name) {
      continue;
    }

    const entry = byBrawler.get(name) ?? { name, games: 0, wins: 0 };
    entry.games += 1;
    if (match.result === 'victory') {
      entry.wins += 1;
    }
    byBrawler.set(name, entry);
  }

  return [...byBrawler.values()]
    .map((entry) => ({
      ...entry,
      winrate: entry.games > 0 ? (entry.wins / entry.games) * 100 : 0,
    }))
    .sort((a, b) => b.games - a.games || b.winrate - a.winrate)
    .slice(0, 5);
}

function computeTopAllies(matches) {
  const byAlly = new Map();

  for (const match of matches) {
    const allies = Array.isArray(match?.allies) ? match.allies : [];

    for (const ally of allies) {
      const tag = normalizeTag(ally?.tag);
      if (!tag) {
        continue;
      }

      const entry = byAlly.get(tag) ?? {
        tag,
        name: ally?.name ?? tag,
        games: 0,
        wins: 0,
      };

      entry.games += 1;
      if (match.result === 'victory') {
        entry.wins += 1;
      }
      if (ally?.name) {
        entry.name = ally.name;
      }

      byAlly.set(tag, entry);
    }
  }

  return [...byAlly.values()]
    .map((entry) => ({
      ...entry,
      winrate: entry.games > 0 ? (entry.wins / entry.games) * 100 : 0,
    }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins)
    .slice(0, 5);
}

function createEmptyItem(text) {
  const li = document.createElement('li');
  li.textContent = text;
  return li;
}

function parseSearchTags(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }

  return value
    .split(/[,\s;]+/)
    .map((tag) => normalizeTag(tag))
    .filter(Boolean);
}

function matchPlayerTag(playerTag, searchTags) {
  if (searchTags.length === 0) {
    return true;
  }

  const normalizedPlayerTag = normalizeTag(playerTag) ?? '';
  const barePlayerTag = normalizedPlayerTag.replace(/^#/, '');

  return searchTags.some((tag) => {
    const bareSearchTag = tag.replace(/^#/, '');
    return bareSearchTag && barePlayerTag.includes(bareSearchTag);
  });
}

function applyTagFilter() {
  const searchTags = parseSearchTags(searchInputEl?.value ?? '');

  if (totalPlayersInDatabase === 0) {
    playersGridEl.hidden = true;
    statusEl.hidden = false;
    statusEl.textContent =
      'Aucun joueur professionnel en base pour le moment. Ajoute des tags pros dans data/players.json puis lance le workflow.';

    if (searchMetaEl) {
      if (searchTags.length === 0) {
        searchMetaEl.textContent = '0 joueur(s) pro indexe(s) dans la base.';
      } else {
        searchMetaEl.textContent = `0 resultat(s) pour ${searchTags.join(', ')} (base vide).`;
      }
    }

    return;
  }

  let visibleCount = 0;

  for (const entry of renderedPlayers) {
    const visible = matchPlayerTag(entry.tag, searchTags);
    entry.card.hidden = !visible;
    if (visible) {
      visibleCount += 1;
    }
  }

  if (searchMetaEl) {
    if (searchTags.length === 0) {
      searchMetaEl.textContent = `${visibleCount} joueur(s) pro disponible(s).`;
    } else {
      searchMetaEl.textContent = `${visibleCount} resultat(s) pour ${searchTags.join(', ')}.`;
    }
  }

  if (visibleCount === 0) {
    playersGridEl.hidden = true;
    statusEl.hidden = false;
    statusEl.textContent = 'Aucun joueur pro suivi ne correspond a ce tag.';
    return;
  }

  playersGridEl.hidden = false;
  statusEl.hidden = true;
}

function bindSearchEvents() {
  if (searchEventsBound) {
    return;
  }

  if (searchInputEl) {
    searchInputEl.addEventListener('input', applyTagFilter);
  }

  if (clearSearchBtnEl) {
    clearSearchBtnEl.addEventListener('click', () => {
      if (!searchInputEl) {
        return;
      }
      searchInputEl.value = '';
      applyTagFilter();
      searchInputEl.focus();
    });
  }

  searchEventsBound = true;
}

function renderPlayerCard(player, assets) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  const matches = Array.isArray(player.matches) ? player.matches : [];
  card.dataset.playerTag = normalizeTag(player.tag) ?? '';

  const wins = matches.filter((match) => match.result === 'victory').length;
  const defeats = matches.filter((match) => match.result === 'defeat').length;
  const total = matches.length;
  const winrate = total > 0 ? (wins / total) * 100 : 0;

  card.querySelector('.player-name').textContent = player.alias || player.tag;
  card.querySelector('.player-tag').textContent = player.tag;
  card.querySelector('.player-team').textContent =
    `Equipe pro actuelle: ${player?.liquipedia?.team ?? 'inconnue'}`;

  const cashPrize = player?.liquipedia?.cashPrizeUsd;
  card.querySelector('.player-cashprize').textContent =
    `Cashprize estime (Liquipedia): ${typeof cashPrize === 'number' ? currencyFormatter.format(cashPrize) : 'inconnu'}`;

  const sourceEl = card.querySelector('.player-source');
  if (sourceEl) {
    const sourceUrl =
      player?.liquipedia?.articleUrl ??
      buildLiquipediaArticleUrl(player?.liquipedia?.page ?? player?.liquipediaPage ?? null);

    sourceEl.textContent = 'Donnees Liquipedia: ';

    const sourceLink = document.createElement('a');
    sourceLink.href = sourceUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = 'source';

    sourceEl.append(sourceLink, document.createTextNode(' (CC BY-SA 3.0).'));
  }

  card.querySelector('.total-matches').textContent = String(total);

  const winrateEl = card.querySelector('.winrate');
  winrateEl.textContent = `${winrate.toFixed(1)}%`;
  winrateEl.classList.add(winrate >= 50 ? 'winrate-positive' : 'winrate-negative');

  card.querySelector('.wins').textContent = String(wins);
  card.querySelector('.defeats').textContent = String(defeats);

  const topBrawlersEl = card.querySelector('.top-brawlers');
  const topBrawlers = computeTopBrawlers(matches);

  if (topBrawlers.length === 0) {
    topBrawlersEl.appendChild(createEmptyItem('Pas assez de matchs.'));
  } else {
    for (const brawler of topBrawlers) {
      const li = document.createElement('li');

      const left = document.createElement('span');
      left.className = 'brawler-item';

      const imageUrl = assets?.brawlers?.[brawler.name]?.imageUrl;
      if (imageUrl) {
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = brawler.name;
        left.appendChild(image);
      }

      const text = document.createElement('span');
      text.textContent = `${brawler.name} (${brawler.games})`;
      left.appendChild(text);

      const right = document.createElement('strong');
      right.textContent = `${brawler.winrate.toFixed(0)}%`;

      li.append(left, right);
      topBrawlersEl.appendChild(li);
    }
  }

  const topAlliesEl = card.querySelector('.top-allies');
  const topAllies = computeTopAllies(matches);

  if (topAllies.length === 0) {
    topAlliesEl.appendChild(createEmptyItem('Pas assez de matchs en equipe.'));
  } else {
    for (const ally of topAllies) {
      const li = document.createElement('li');
      const label = ally.name === ally.tag ? ally.tag : `${ally.name} (${ally.tag})`;
      const left = document.createElement('span');
      left.textContent = label;

      const right = document.createElement('strong');
      right.textContent = `${ally.games} matchs`;

      li.append(left, right);
      topAlliesEl.appendChild(li);
    }
  }

  return card;
}

async function loadDatabase() {
  const response = await fetch('./database.json', {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Impossible de charger database.json (${response.status})`);
  }

  return response.json();
}

async function init() {
  try {
    const database = await loadDatabase();
    const players = Object.values(database?.players ?? {});
    totalPlayersInDatabase = players.length;

    lastUpdateEl.textContent = `Derniere mise a jour: ${formatDate(database?.updatedAt)}`;
    bindSearchEvents();

    if (players.length === 0) {
      if (searchMetaEl) {
        searchMetaEl.textContent = '0 joueur(s) pro indexe(s) dans la base.';
      }
      statusEl.textContent =
        'Aucun joueur professionnel en base pour le moment. Ajoute des tags pros dans data/players.json puis lance le workflow.';
      return;
    }

    players.sort((a, b) => {
      const left = (a.alias || a.tag || '').toLowerCase();
      const right = (b.alias || b.tag || '').toLowerCase();
      return left.localeCompare(right);
    });

    const fragment = document.createDocumentFragment();
    renderedPlayers = [];
    for (const player of players) {
      const card = renderPlayerCard(player, database.assets ?? {});
      renderedPlayers.push({
        card,
        tag: player.tag ?? '',
      });
      fragment.appendChild(card);
    }

    playersGridEl.appendChild(fragment);
    if (searchMetaEl) {
      searchMetaEl.textContent = `${players.length} joueur(s) pro disponible(s).`;
    }

    applyTagFilter();
  } catch (error) {
    totalPlayersInDatabase = 0;
    if (searchMetaEl) {
      searchMetaEl.textContent = 'Recherche indisponible (erreur de chargement).';
    }
    statusEl.textContent = error.message;
    statusEl.hidden = false;
  }
}

init();
