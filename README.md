# Brawl Stars Esport Tracker (Static + GitHub Pages)

Tracker esport 100% statique base sur `database.json` mis a jour automatiquement par GitHub Actions.

## Structure

- `scripts/update-data.mjs`: script Node.js execute toutes les heures en CI.
- `data/players.json`: liste statique des joueurs pros a suivre.
- `database.json`: historique de matchs + metadonnees (cashprize, equipe, assets).
- `.github/workflows/update-data.yml`: workflow cron (`0 * * * *`) + commit/push auto.
- `index.html`, `app.js`, `styles.css`: frontend statique GitHub Pages.

## Configuration

1. Remplir `data/players.json` avec les joueurs a suivre.
2. Ajouter les secrets GitHub dans `Settings > Secrets and variables > Actions`:
   - `BRAWLSTARS_API_TOKEN` (obligatoire)
   - `LIQUIPEDIA_API_KEY` (recommande, API Liquipedia DB v3)
   - `LIQUIPEDIA_USER_AGENT` (optionnel, ex: `MyTrackerBot/1.0 (contact@example.com)`)
3. Activer GitHub Pages sur la branche principale (root).
4. Lancer le workflow manuellement une premiere fois (`workflow_dispatch`).

## Format recommande pour data/players.json

```json
[
  {
    "tag": "#ABC123",
    "alias": "Player Name",
    "liquipediaPage": "Player_Name",
    "enabled": true
  }
]
```

## Fonctionnement de la deduplication

Le script compare strictement `battleTime` entre les nouveaux matchs et ceux deja stockes dans `database.json`.
Seuls les nouveaux `battleTime` sont ajoutes, ce qui cree un historique infini sans base SQL.

## Frontend

Le frontend fait un `fetch('./database.json')` puis calcule cote navigateur:

- winrate global
- top brawlers (joues + winrate)
- meilleurs allies (tags les plus frequents)

Aucune cle API n est exposee dans le client.

## Attribution Liquipedia (CC BY-SA)

Les donnees Liquipedia affichees sur le site doivent etre attribuees a proximite des donnees.
Le frontend affiche cette attribution dans chaque carte joueur:

- source Liquipedia avec lien vers l article
- mention de licence `CC BY-SA 3.0`
