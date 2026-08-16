#!/usr/bin/env bash
# Pull every input the pipeline needs from nflverse. ~120 MB, all public.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
B=https://github.com/nflverse/nflverse-data/releases/download

for y in $(seq 1999 2025); do
  ( curl -sL --max-time 180 -o "data/sp_$y.csv" "$B/stats_player/stats_player_reg_$y.csv"
    curl -sL --max-time 180 -o "data/st_$y.csv" "$B/stats_team/stats_team_reg_$y.csv" ) &
done
wait

for y in $(seq 2012 2025); do
  curl -sL --max-time 180 -o "data/wk_$y.csv" "$B/stats_player/stats_player_week_$y.csv" &
done
wait

curl -sL --max-time 180 -o data/players.csv     "$B/players/players.csv"
curl -sL --max-time 180 -o data/rost_2026.csv   "$B/rosters/roster_2026.csv"
curl -sL --max-time 180 -o data/draft_picks.csv "$B/draft_picks/draft_picks.csv"
curl -sL --max-time 180 -o data/games.csv       "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

echo "done: $(ls data | wc -l) files, $(du -sh data | cut -f1)"
