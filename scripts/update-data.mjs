import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const PLAYERS_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'players.json');
const DATABASE_PATH = path.join(ROOT_DIR, 'database.json');

const SUPERCELL_API_BASE = process.env.SUPERCELL_API_BASE ?? 'https://api.brawlstars.com/v1';
const LIQUIPEDIA_MEDIAWIKI_API_BASE =
  process.env.LIQUIPEDIA_MEDIAWIKI_API_BASE ??
  process.env.LIQUIPEDIA_API_BASE ??
  'https://liquipedia.net/brawlstars/api.php';
const LIQUIPEDIA_DB_API_BASE = process.env.LIQUIPEDIA_DB_API_BASE ?? 'https://api.liquipedia.net/api/v3';
const LIQUIPEDIA_DB_WIKI = process.env.LIQUIPEDIA_DB_WIKI ?? 'brawlstars';
const BRAWLAPI_BASE = process.env.BRAWLAPI_BASE ?? 'https://api.brawlapi.com/v1';

const SUPERCELL_TOKEN = process.env.BRAWLSTARS_API_TOKEN;
const LIQUIPEDIA_API_KEY = process.env.LIQUIPEDIA_API_KEY;
const LIQUIPEDIA_USER_AGENT =
  process.env.LIQUIPEDIA_USER_AGENT ?? 'BrawlStarsTrackerBot/1.0 (GitHub Actions)';

const REQUEST_TIMEOUT_MS = 20000;
const LIQUIPEDIA_MIN_INTERVAL_MS = Number.isFinite(Number(process.env.LIQUIPEDIA_MIN_INTERVAL_MS))
  ? Math.max(0, Number(process.env.LIQUIPEDIA_MIN_INTERVAL_MS))
  : 350;
const LIQUIPEDIA_RETRY_COUNT = Number.isFinite(Number(process.env.LIQUIPEDIA_RETRY_COUNT))
  ? Math.max(0, Number(process.env.LIQUIPEDIA_RETRY_COUNT))
  : 2;
const LIQUIPEDIA_RETRY_BASE_MS = Number.isFinite(Number(process.env.LIQUIPEDIA_RETRY_BASE_MS))
  ? Math.max(100, Number(process.env.LIQUIPEDIA_RETRY_BASE_MS))
  : 1200;

let lastLiquipediaRequestAt = 0;
const liquipediaTeamNameCache = new Map();

function normalizeTag(tag) {
  if (!tag || typeof tag !== 'string') {
    return null;
  }

  const cleaned = tag.trim().toUpperCase().replace(/^#/, '');
  if (!cleaned || cleaned === 'PLAYER_TAG') {
    return null;
  }

  return `#${cleaned}`;
}

function parseBattleTimeToISO(battleTime) {
  if (!battleTime || typeof battleTime !== 'string') {
    return null;
  }

  const match = battleTime.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!match) {
    return null;
  }

  const [, y, m, d, hh, mm, ss] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))).toISOString();
}

function cleanWikiText(value) {
  if (!value) {
    return null;
  }

  return value
    .replace(/<!--.*?-->/g, '')
    .replace(/\{\{[^|}]+\|([^}]+)\}\}/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .trim();
}

function parseCashPrize(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(/[,\s']/g, '');
  const numberMatch = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!numberMatch) {
    return null;
  }

  const parsed = Number(numberMatch[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeLiquipediaConditionValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value).replace(/[\[\]]/g, '').trim();
}

function resolveStringFromUnknown(input, preferredObjectKeys = []) {
  if (input === null || input === undefined) {
    return null;
  }

  if (typeof input === 'string' || typeof input === 'number') {
    const cleaned = cleanWikiText(String(input));
    return cleaned || null;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const resolved = resolveStringFromUnknown(item, preferredObjectKeys);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (typeof input === 'object') {
    for (const key of preferredObjectKeys) {
      if (Object.hasOwn(input, key)) {
        const resolved = resolveStringFromUnknown(input[key], preferredObjectKeys);
        if (resolved) {
          return resolved;
        }
      }
    }

    for (const nested of Object.values(input)) {
      const resolved = resolveStringFromUnknown(nested, preferredObjectKeys);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function pickFirstField(record, fields) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  for (const field of fields) {
    if (Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined) {
      return record[field];
    }
  }

  return null;
}

function extractTeamIdentifierFromPlayerRecord(playerRecord) {
  const raw = pickFirstField(playerRecord, [
    'teamtemplateid',
    'team_id',
    'teamid',
    'currentteamid',
    'teamtemplate',
    'team',
    'currentteam',
    'current_team',
  ]);

  const resolved = resolveStringFromUnknown(raw, ['id', 'teamid', 'team_id', 'name', 'teamname']);
  return resolved || null;
}

function extractTeamNameFromPlayerRecord(playerRecord) {
  const raw = pickFirstField(playerRecord, [
    'currentteam',
    'current_team',
    'team',
    'teamname',
    'team_name',
    'organization',
    'org',
  ]);

  return resolveStringFromUnknown(raw, ['name', 'teamname', 'team_name', 'displayname', 'id']);
}

function extractTeamNameFromTeamRecord(teamRecord) {
  const raw = pickFirstField(teamRecord, ['name', 'teamname', 'team_name', 'displayname', 'id', 'pagename']);
  return resolveStringFromUnknown(raw, ['name', 'teamname', 'team_name', 'displayname', 'id']);
}

function extractCashPrizeFromPlayerRecord(playerRecord) {
  const raw = pickFirstField(playerRecord, [
    'earnings',
    'prizemoney',
    'prize_money',
    'totalprizemoney',
    'cashprize',
    'winnings',
  ]);

  const rawCashPrize = resolveStringFromUnknown(raw, ['amount', 'value', 'usd', 'prizemoney']);
  return {
    cashPrizeUsd: parseCashPrize(rawCashPrize),
    rawCashPrize: rawCashPrize || null,
  };
}

function buildLiquipediaArticleUrl(pageName) {
  const normalizedPage = sanitizeLiquipediaConditionValue(pageName)?.replace(/\s+/g, '_');
  if (!normalizedPage) {
    return 'https://liquipedia.net/brawlstars/Main_Page';
  }

  return `https://liquipedia.net/brawlstars/${normalizedPage}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fetchJson(url, options = {}, context = 'request') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${context} failed with ${response.status}: ${errorBody.slice(0, 200)}`);
      }

      return await response.json();
    } catch (error) {
      throw new Error(`${context} failed: ${error.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

function ensureDatabaseShape(database) {
  const safe = database && typeof database === 'object' ? database : {};

  return {
    updatedAt: safe.updatedAt ?? null,
    sources: {
      supercellLastSync: safe.sources?.supercellLastSync ?? null,
      liquipediaLastSync: safe.sources?.liquipediaLastSync ?? null,
      brawlApiLastSync: safe.sources?.brawlApiLastSync ?? null,
    },
    players: safe.players && typeof safe.players === 'object' ? safe.players : {},
    assets: {
      brawlers: safe.assets?.brawlers && typeof safe.assets.brawlers === 'object' ? safe.assets.brawlers : {},
      maps: safe.assets?.maps && typeof safe.assets.maps === 'object' ? safe.assets.maps : {},
    },
  };
}

function inferResult(battle) {
  if (!battle || typeof battle !== 'object') {
    return 'unknown';
  }

  if (typeof battle.result === 'string') {
    const normalized = battle.result.toLowerCase();
    if (normalized === 'victory' || normalized === 'defeat' || normalized === 'draw') {
      return normalized;
    }
  }

  if (typeof battle.rank === 'number') {
    return battle.rank === 1 ? 'victory' : 'defeat';
  }

  if (typeof battle.trophyChange === 'number') {
    if (battle.trophyChange > 0) {
      return 'victory';
    }

    if (battle.trophyChange < 0) {
      return 'defeat';
    }
  }

  return 'unknown';
}

function extractParticipantData(item, playerTag) {
  const battle = item?.battle ?? {};
  const normalizedPlayerTag = normalizeTag(playerTag);

  let playerEntry = null;
  let allies = [];
  let enemies = [];

  if (Array.isArray(battle.teams)) {
    let playerTeamIndex = -1;

    battle.teams.forEach((team, teamIndex) => {
      team.forEach((member) => {
        const memberTag = normalizeTag(member?.tag);
        if (memberTag && memberTag === normalizedPlayerTag) {
          playerTeamIndex = teamIndex;
          playerEntry = member;
        }
      });
    });

    if (playerTeamIndex >= 0) {
      allies = (battle.teams[playerTeamIndex] ?? [])
        .filter((member) => normalizeTag(member?.tag) !== normalizedPlayerTag)
        .map((member) => ({
          tag: normalizeTag(member?.tag),
          name: member?.name ?? null,
        }))
        .filter((member) => member.tag);

      enemies = battle.teams
        .flatMap((team, index) => (index === playerTeamIndex ? [] : team))
        .map((member) => ({
          tag: normalizeTag(member?.tag),
          name: member?.name ?? null,
        }))
        .filter((member) => member.tag);
    }
  } else if (Array.isArray(battle.players)) {
    battle.players.forEach((member) => {
      const memberTag = normalizeTag(member?.tag);
      if (memberTag && memberTag === normalizedPlayerTag) {
        playerEntry = member;
      }
    });

    enemies = battle.players
      .filter((member) => normalizeTag(member?.tag) !== normalizedPlayerTag)
      .map((member) => ({
        tag: normalizeTag(member?.tag),
        name: member?.name ?? null,
      }))
      .filter((member) => member.tag);
  }

  return {
    playerEntry,
    allies,
    enemies,
  };
}

function normalizeBattleItem(item, playerTag) {
  const battle = item?.battle ?? {};
  const event = item?.event ?? {};
  const { playerEntry, allies, enemies } = extractParticipantData(item, playerTag);

  return {
    battleTime: item?.battleTime ?? null,
    battleTimeIso: parseBattleTimeToISO(item?.battleTime),
    mode: battle?.mode ?? event?.mode ?? null,
    type: battle?.type ?? null,
    result: inferResult(battle),
    duration: typeof battle?.duration === 'number' ? battle.duration : null,
    trophyChange: typeof battle?.trophyChange === 'number' ? battle.trophyChange : null,
    rank: typeof battle?.rank === 'number' ? battle.rank : null,
    starPlayerTag: normalizeTag(battle?.starPlayer?.tag),
    map: event?.map ?? null,
    brawler: {
      id: playerEntry?.brawler?.id ?? null,
      name: playerEntry?.brawler?.name ?? null,
      power: playerEntry?.brawler?.power ?? null,
      trophies: playerEntry?.brawler?.trophies ?? null,
    },
    allies,
    enemies,
  };
}

function computePlayerStats(matches) {
  const totalMatches = matches.length;
  const wins = matches.filter((match) => match.result === 'victory').length;
  const defeats = matches.filter((match) => match.result === 'defeat').length;
  const draws = matches.filter((match) => match.result === 'draw').length;
  const winRate = totalMatches > 0 ? Number(((wins / totalMatches) * 100).toFixed(2)) : 0;
  const lastBattleTime = matches.length > 0 ? matches[matches.length - 1].battleTime : null;

  return {
    totalMatches,
    wins,
    defeats,
    draws,
    winRate,
    lastBattleTime,
    lastBattleTimeIso: parseBattleTimeToISO(lastBattleTime),
  };
}

async function fetchBattleLog(playerTag) {
  const encodedTag = encodeURIComponent(playerTag);
  const url = `${SUPERCELL_API_BASE}/players/${encodedTag}/battlelog`;

  const json = await fetchJson(
    url,
    {
      headers: {
        Authorization: `Bearer ${SUPERCELL_TOKEN}`,
      },
    },
    `Supercell battlelog for ${playerTag}`,
  );

  return Array.isArray(json?.items) ? json.items : [];
}

async function fetchLiquipediaDbRows(endpoint, params, context) {
  const url = new URL(`${LIQUIPEDIA_DB_API_BASE}/${endpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const json = await fetchJson(
    url.toString(),
    {
      headers: {
        Authorization: `Apikey ${LIQUIPEDIA_API_KEY}`,
        'User-Agent': LIQUIPEDIA_USER_AGENT,
        'Accept-Encoding': 'gzip',
      },
    },
    context,
  );

  if (Array.isArray(json?.error) && json.error.length > 0) {
    throw new Error(`${context} returned API errors: ${json.error.join('; ')}`);
  }

  return Array.isArray(json?.result) ? json.result : [];
}

async function fetchLiquipediaTeamNameFromDb(teamIdentifier) {
  const safeTeamIdentifier = sanitizeLiquipediaConditionValue(teamIdentifier);
  if (!safeTeamIdentifier) {
    return null;
  }

  const conditions = `[[id::${safeTeamIdentifier}]] OR [[name::${safeTeamIdentifier}]] OR [[pagename::${safeTeamIdentifier}]]`;
  const teams = await fetchLiquipediaDbRows(
    'team',
    {
      wiki: LIQUIPEDIA_DB_WIKI,
      limit: 1,
      conditions,
    },
    `Liquipedia DB team lookup (${safeTeamIdentifier})`,
  );

  if (teams.length === 0) {
    return null;
  }

  return extractTeamNameFromTeamRecord(teams[0]);
}

async function fetchLiquipediaDataFromDb(pageName) {
  const safePageName = sanitizeLiquipediaConditionValue(pageName);
  if (!safePageName) {
    return null;
  }

  const pageAsName = safePageName.replace(/_/g, ' ');
  const conditions = `[[pagename::${safePageName}]] OR [[id::${safePageName}]] OR [[name::${pageAsName}]]`;
  const players = await fetchLiquipediaDbRows(
    'player',
    {
      wiki: LIQUIPEDIA_DB_WIKI,
      limit: 1,
      conditions,
    },
    `Liquipedia DB player lookup (${safePageName})`,
  );

  if (players.length === 0) {
    return null;
  }

  const playerRecord = players[0];
  const cashPrize = extractCashPrizeFromPlayerRecord(playerRecord);

  let team = extractTeamNameFromPlayerRecord(playerRecord);
  if (!team) {
    const teamIdentifier = extractTeamIdentifierFromPlayerRecord(playerRecord);
    if (teamIdentifier) {
      team = await fetchLiquipediaTeamNameFromDb(teamIdentifier);
    }
  }

  return {
    page: pageName,
    articleUrl: buildLiquipediaArticleUrl(pageName),
    source: 'liquipedia-db-v3',
    cashPrizeUsd: cashPrize.cashPrizeUsd,
    team: team || null,
    rawCashPrize: cashPrize.rawCashPrize,
  };
}

async function fetchLiquipediaDataFromMediaWiki(pageName) {
  if (!pageName) {
    return null;
  }

  const url = `${LIQUIPEDIA_MEDIAWIKI_API_BASE}?action=parse&page=${encodeURIComponent(pageName)}&prop=wikitext&format=json`;

  const json = await fetchJson(
    url,
    {
      headers: {
        'User-Agent': LIQUIPEDIA_USER_AGENT,
      },
    },
    `Liquipedia MediaWiki page ${pageName}`,
  );

  const wikiText = json?.parse?.wikitext?.['*'];
  if (!wikiText) {
    return null;
  }

  const earningsMatch = wikiText.match(/\|\s*(?:earnings|prize_money|totalprizemoney)\s*=\s*([^\n\r]+)/i);
  const teamMatch = wikiText.match(/\|\s*(?:team|current_team|team1)\s*=\s*([^\n\r]+)/i);

  const earningsRaw = cleanWikiText(earningsMatch?.[1] ?? null);
  const teamRaw = cleanWikiText(teamMatch?.[1] ?? null);

  return {
    page: pageName,
    articleUrl: buildLiquipediaArticleUrl(pageName),
    source: 'liquipedia-mediawiki',
    cashPrizeUsd: parseCashPrize(earningsRaw),
    team: teamRaw || null,
    rawCashPrize: earningsRaw || null,
  };
}

async function fetchLiquipediaData(pageName) {
  if (!pageName) {
    return null;
  }

  if (LIQUIPEDIA_API_KEY) {
    try {
      const liquipediaDbData = await fetchLiquipediaDataFromDb(pageName);
      if (liquipediaDbData) {
        return liquipediaDbData;
      }
      console.warn(`[warn] Liquipedia DB found no player for ${pageName}, fallback to MediaWiki parsing`);
    } catch (error) {
      console.warn(`[warn] ${error.message}`);
    }
  }

  return fetchLiquipediaDataFromMediaWiki(pageName);
}

async function fetchBrawlApiAssets() {
  const [brawlersJson, mapsJson] = await Promise.all([
    fetchJson(`${BRAWLAPI_BASE}/brawlers`, {}, 'BrawlAPI brawlers'),
    fetchJson(`${BRAWLAPI_BASE}/maps`, {}, 'BrawlAPI maps'),
  ]);

  const brawlers = {};
  const maps = {};

  const brawlerList = Array.isArray(brawlersJson?.list) ? brawlersJson.list : [];
  for (const brawler of brawlerList) {
    if (!brawler?.name) {
      continue;
    }

    brawlers[brawler.name] = {
      id: brawler.id ?? null,
      name: brawler.name,
      imageUrl: brawler.imageUrl2 ?? brawler.imageUrl ?? null,
      rarity: brawler?.rarity?.name ?? null,
      class: brawler?.class?.name ?? null,
    };
  }

  const mapsList = Array.isArray(mapsJson?.list) ? mapsJson.list : [];
  for (const map of mapsList) {
    if (!map?.name) {
      continue;
    }

    maps[map.name] = {
      id: map.id ?? null,
      name: map.name,
      imageUrl: map.imageUrl ?? null,
      gameMode: map?.gameMode?.name ?? null,
      disabled: Boolean(map.disabled),
    };
  }

  return { brawlers, maps };
}

async function main() {
  const playersConfig = await readJson(PLAYERS_CONFIG_PATH, []);
  if (!Array.isArray(playersConfig)) {
    throw new Error('data/players.json must be an array');
  }

  const database = ensureDatabaseShape(await readJson(DATABASE_PATH, {}));

  const activePlayers = playersConfig
    .filter((player) => player && typeof player === 'object')
    .map((player) => ({
      ...player,
      tag: normalizeTag(player.tag),
    }))
    .filter((player) => player.tag && player.enabled !== false);

  if (activePlayers.length > 0 && !SUPERCELL_TOKEN) {
    throw new Error('BRAWLSTARS_API_TOKEN is required when active players are configured');
  }

  if (!LIQUIPEDIA_API_KEY) {
    console.warn('[warn] LIQUIPEDIA_API_KEY is missing, fallback to MediaWiki page parsing for Liquipedia fields');
  }

  let totalNewMatches = 0;
  let processedPlayers = 0;
  let hasMeaningfulChanges = false;
  let hasSupercellChanges = false;
  let hasLiquipediaChanges = false;
  let hasAssetChanges = false;

  for (const playerConfig of activePlayers) {
    const tag = playerConfig.tag;
    const previousRecord = database.players[tag];
    const currentRecord = previousRecord ? deepClone(previousRecord) : {
      tag,
      alias: playerConfig.alias ?? null,
      liquipediaPage: playerConfig.liquipediaPage ?? null,
      liquipedia: null,
      matches: [],
      stats: {
        totalMatches: 0,
        wins: 0,
        defeats: 0,
        draws: 0,
        winRate: 0,
        lastBattleTime: null,
        lastBattleTimeIso: null,
      },
    };

    let playerHasNewMatches = false;
    let playerHasLiquipediaChanges = false;

    currentRecord.tag = tag;
    currentRecord.alias = playerConfig.alias ?? currentRecord.alias ?? null;
    currentRecord.liquipediaPage = playerConfig.liquipediaPage ?? currentRecord.liquipediaPage ?? null;

    const existingMatches = Array.isArray(currentRecord.matches) ? currentRecord.matches : [];
    const existingBattleTimes = new Set(existingMatches.map((match) => match.battleTime).filter(Boolean));

    try {
      const battleLog = await fetchBattleLog(tag);
      for (const item of battleLog) {
        const battleTime = item?.battleTime;
        if (!battleTime || existingBattleTimes.has(battleTime)) {
          continue;
        }

        existingMatches.push(normalizeBattleItem(item, tag));
        existingBattleTimes.add(battleTime);
        totalNewMatches += 1;
        playerHasNewMatches = true;
      }

      existingMatches.sort((a, b) => String(a.battleTime).localeCompare(String(b.battleTime)));
      currentRecord.matches = existingMatches;
    } catch (error) {
      console.warn(`[warn] ${error.message}`);
    }

    if (currentRecord.liquipediaPage) {
      try {
        const liquipedia = await fetchLiquipediaData(currentRecord.liquipediaPage);
        if (liquipedia) {
          const previousLiquipedia = currentRecord.liquipedia
            ? {
                page: currentRecord.liquipedia.page ?? null,
                articleUrl: currentRecord.liquipedia.articleUrl ?? null,
                source: currentRecord.liquipedia.source ?? null,
                cashPrizeUsd: currentRecord.liquipedia.cashPrizeUsd ?? null,
                team: currentRecord.liquipedia.team ?? null,
                rawCashPrize: currentRecord.liquipedia.rawCashPrize ?? null,
              }
            : null;

          if (!jsonEquals(previousLiquipedia, liquipedia)) {
            currentRecord.liquipedia = {
              ...liquipedia,
              updatedAt: new Date().toISOString(),
            };
            playerHasLiquipediaChanges = true;
          }
        }
      } catch (error) {
        console.warn(`[warn] ${error.message}`);
      }
    }

    currentRecord.stats = computePlayerStats(currentRecord.matches ?? []);
    database.players[tag] = currentRecord;
    processedPlayers += 1;

    if (!previousRecord || !jsonEquals(previousRecord, currentRecord)) {
      hasMeaningfulChanges = true;
    }

    if (playerHasNewMatches) {
      hasSupercellChanges = true;
    }

    if (playerHasLiquipediaChanges) {
      hasLiquipediaChanges = true;
    }
  }

  try {
    const assets = await fetchBrawlApiAssets();
    if (!jsonEquals(database.assets, assets)) {
      database.assets = assets;
      hasAssetChanges = true;
      hasMeaningfulChanges = true;
    }
  } catch (error) {
    console.warn(`[warn] ${error.message}`);
  }

  if (hasSupercellChanges || hasLiquipediaChanges || hasAssetChanges || hasMeaningfulChanges) {
    const nowIso = new Date().toISOString();

    if (hasSupercellChanges) {
      database.sources.supercellLastSync = nowIso;
    }

    if (hasLiquipediaChanges) {
      database.sources.liquipediaLastSync = nowIso;
    }

    if (hasAssetChanges) {
      database.sources.brawlApiLastSync = nowIso;
    }

    database.updatedAt = nowIso;
  }

  await writeFile(DATABASE_PATH, `${JSON.stringify(database, null, 2)}\n`, 'utf8');

  console.log(`[ok] Players processed: ${processedPlayers}`);
  console.log(`[ok] New matches added: ${totalNewMatches}`);
  console.log(`[ok] Database written: ${DATABASE_PATH}`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
