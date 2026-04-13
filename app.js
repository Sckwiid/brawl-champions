const statusEl = document.querySelector('#status');
const playersGridEl = document.querySelector('#playersGrid');
const lastUpdateEl = document.querySelector('#lastUpdate');
const cardTemplate = document.querySelector('#playerCardTemplate');

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

function renderPlayerCard(player, assets) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  const matches = Array.isArray(player.matches) ? player.matches : [];

  const wins = matches.filter((match) => match.result === 'victory').length;
  const defeats = matches.filter((match) => match.result === 'defeat').length;
  const total = matches.length;
  const winrate = total > 0 ? (wins / total) * 100 : 0;

  card.querySelector('.player-name').textContent = player.alias || player.tag;
  card.querySelector('.player-tag').textContent = player.tag;
  card.querySelector('.player-team').textContent =
    `Equipe actuelle: ${player?.liquipedia?.team ?? 'inconnue'}`;

  const cashPrize = player?.liquipedia?.cashPrizeUsd;
  card.querySelector('.player-cashprize').textContent =
    `Cashprize estimé: ${typeof cashPrize === 'number' ? currencyFormatter.format(cashPrize) : 'inconnu'}`;

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

    lastUpdateEl.textContent = `Derniere mise a jour: ${formatDate(database?.updatedAt)}`;

    if (players.length === 0) {
      statusEl.textContent =
        'Aucun joueur actif dans data/players.json. Ajoute des tags puis laisse le workflow remplir l historique.';
      return;
    }

    players.sort((a, b) => {
      const left = (a.alias || a.tag || '').toLowerCase();
      const right = (b.alias || b.tag || '').toLowerCase();
      return left.localeCompare(right);
    });

    const fragment = document.createDocumentFragment();
    for (const player of players) {
      fragment.appendChild(renderPlayerCard(player, database.assets ?? {}));
    }

    playersGridEl.appendChild(fragment);
    playersGridEl.hidden = false;
    statusEl.hidden = true;
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.hidden = false;
  }
}

init();
