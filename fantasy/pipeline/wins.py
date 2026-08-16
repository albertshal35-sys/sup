"""Stage 9: custom win-denominated statistics.

Points are the currency; wins are what you actually buy. In head-to-head you do
not get paid for running up the score — you get paid for clearing one opponent,
once a week. That makes the map from points to wins an S-curve, and an S-curve
values players differently than a sum does:

  * points far above what you needed are wasted,
  * points that flip a loss into a win are worth far more than their face value,
  * a zero is not "a bad week", it is a near-certain loss in that slot,
  * so consistency is worth real wins, not just comfort.

Four statistics come out of this file.

  WAA   Wins Above Available. Expected head-to-head wins a player adds over a
        season versus the best player you could have had for a dollar, given the
        rest of a normal roster and a normal opponent. Missed weeks count as
        zeros, so availability is priced in rather than hidden by a per-game
        average.
  FLR   Floor rate. Share of the season's weeks he beat a typical starter at his
        position — how often he actually wins you the slot.
  SPK   Spike rate. Share of weeks in the top decile of outcomes at his position
        — the weeks that beat a good opponent rather than a bad one.
  GHST  Ghost rate. Share of weeks he gave you nothing at all.
"""
import pandas as pd, numpy as np, json, warnings
from scipy.stats import norm, spearmanr

warnings.filterwarnings("ignore")
SEASONS = list(range(2012, 2026))
LINEUP = dict(QB=2, RB=2, WR=3, TE=1)
FLEX_POS = ("RB", "WR", "TE")
TEAMS = 12
WEEKS = 17

S = dict(pass_yd=0.04, pass_td=4.0, itc=-2.0, rush_yd=0.10, rush_td=6.0,
         rec=1.0, rec_yd=0.10, rec_td=6.0, fum=-2.0, two=2.0)


def weekly(y):
    d = pd.read_csv(f"data/wk_{y}.csv", low_memory=False)
    d = d[(d.season_type == "REG") & d.position.isin(["QB", "RB", "WR", "TE"])].copy()
    g = lambda c: pd.to_numeric(d.get(c), errors="coerce").fillna(0.0)
    pts = (g("passing_yards") * S["pass_yd"] + g("passing_tds") * S["pass_td"]
           + g("passing_interceptions") * S["itc"] + g("rushing_yards") * S["rush_yd"]
           + g("rushing_tds") * S["rush_td"] + g("receptions") * S["rec"]
           + g("receiving_yards") * S["rec_yd"] + g("receiving_tds") * S["rec_td"]
           + (g("sack_fumbles_lost") + g("rushing_fumbles_lost") + g("receiving_fumbles_lost")) * S["fum"]
           + (g("passing_2pt_conversions") + g("rushing_2pt_conversions")
              + g("receiving_2pt_conversions")) * S["two"])
    return pd.DataFrame(dict(player_id=d.player_id, season=y, week=d.week.astype(int),
                             position=d.position, pts=pts))


WK = pd.concat([weekly(y) for y in SEASONS], ignore_index=True)
sp = pd.read_parquet("out/player_seasons.parquet")
print("weekly rows:", len(WK))

# ---------------------------------------------------------------- per season
rows = []
season_meta = {}
for season in SEASONS:
    wk = WK[WK.season == season]
    # a player's week is 0 if he did not play — that is what your lineup scored
    grid = wk.pivot_table(index="player_id", columns="week", values="pts", aggfunc="sum")
    grid = grid.reindex(columns=range(1, WEEKS + 1)).fillna(0.0)
    pos = wk.groupby("player_id").position.first()
    tot = grid.sum(axis=1)

    # who counts as a starter, and who is the dollar-player you could stream
    starters, repl_curve = {}, {}
    for p, n in LINEUP.items():
        ids = tot[pos == p].sort_values(ascending=False)
        n_start = n * TEAMS + (TEAMS // 2 if p in FLEX_POS else 0)
        starters[p] = ids.index[:n_start]
        # replacement = the band just past the last rostered player at the spot
        lo, hi = n_start + TEAMS, n_start + TEAMS * 3
        repl_curve[p] = grid.loc[ids.index[lo:hi]].mean(axis=0) if len(ids) > hi else grid.loc[ids.index[n_start:]].mean(axis=0)

    # a normal team's weekly score, to size the noise everything is judged against
    rng = np.random.default_rng(season)
    sims = []
    for _ in range(300):
        picks = []
        for p, n in LINEUP.items():
            pool = starters[p]
            picks += list(rng.choice(pool, size=min(n, len(pool)), replace=False))
        fl = [i for i in np.concatenate([starters[p] for p in FLEX_POS]) if i not in picks]
        if fl:
            picks.append(rng.choice(fl))
        sims.append(grid.loc[picks].sum(axis=0).values)
    sims = np.array(sims)
    team_sd = float(np.mean(sims.std(axis=0)))
    # spread of (opponent total − your other eight starters): two near-independent
    # sums of nine and eight starters
    sigma = team_sd * np.sqrt(1 + 8 / 9)

    # the bar each position is measured against: a typical starter's week
    bar = {p: float(grid.loc[starters[p]].values.mean()) for p in LINEUP}
    p90 = {p: float(np.quantile(grid.loc[starters[p]].values, 0.90)) for p in LINEUP}
    season_meta[season] = dict(team_sd=round(team_sd, 2), sigma=round(float(sigma), 2),
                               bar={k: round(v, 2) for k, v in bar.items()},
                               spike={k: round(v, 2) for k, v in p90.items()})

    for pid, r in grid.iterrows():
        p = pos.get(pid)
        if p not in LINEUP:
            continue
        x = r.values
        b, sig = bar[p], sigma
        win_with = norm.cdf((x - b) / sig)
        win_repl = norm.cdf((repl_curve[p].values - b) / sig)
        rows.append(dict(
            player_id=pid, season=season, position=p,
            waa=float((win_with - win_repl).sum()),
            flr=float((x > b).mean()),
            spk=float((x >= p90[p]).mean()),
            ghst=float((x <= 0.5).mean()),
            wk_sd=float(x.std()),
            fpts_wk=float(x.sum())))

W = pd.DataFrame(rows)
W.to_parquet("out/win_metrics.parquet")
json.dump(season_meta, open("out/win_meta.json", "w"), indent=1)

print("\n" + "=" * 78)
print("N. THE WIN CURVE  —  what a week is actually worth")
print("=" * 78)
m = season_meta[2025]
print(f"  2025: a normal team scores {m['team_sd']:.1f} points of weekly noise; the gap you are")
print(f"        shooting at has spread {m['sigma']:.1f}. A typical starting week is worth:")
for p in ("QB", "RB", "WR", "TE"):
    print(f"          {p}: {m['bar'][p]:5.1f} pts (top-decile week {m['spike'][p]:5.1f})")
print("\n  Marginal win probability per extra point, at the margin:")
for p in ("QB", "RB", "WR", "TE"):
    d = norm.pdf(0) / m["sigma"]
    print(f"          {p}: {d*100:.2f}% of a win per point at the bar; "
          f"{norm.pdf((m['spike'][p]-m['bar'][p])/m['sigma'])/m['sigma']*100:.2f}% once he is already spiking")

print("\n" + "=" * 78)
print("O. WINS ARE NOT POINTS  —  where the two rankings disagree")
print("=" * 78)
d25 = W[W.season == 2025].merge(sp[sp.season == 2025][["player_id", "player_display_name", "fpts", "games"]],
                                on="player_id", how="left")
d25 = d25[d25.fpts.notna()]
d25["pts_rank"] = d25.fpts.rank(ascending=False)
d25["waa_rank"] = d25.waa.rank(ascending=False)
d25["move"] = d25.pts_rank - d25.waa_rank
top = d25[d25.pts_rank <= 80]
print("\n  Most underrated by raw points (2025):")
for _, r in top.nlargest(6, "move").iterrows():
    print(f"    {r.player_display_name:24s} {r.position}  pts#{r.pts_rank:3.0f} -> wins#{r.waa_rank:3.0f}  "
          f"(+{r.move:.0f})  WAA {r.waa:+.2f}  floor {r.flr:.0%}  ghost {r.ghst:.0%}")
print("\n  Most overrated by raw points (2025):")
for _, r in top.nsmallest(6, "move").iterrows():
    print(f"    {r.player_display_name:24s} {r.position}  pts#{r.pts_rank:3.0f} -> wins#{r.waa_rank:3.0f}  "
          f"({r.move:.0f})  WAA {r.waa:+.2f}  floor {r.flr:.0%}  ghost {r.ghst:.0%}")

print("\n  Top 10 by Wins Above Available, 2025:")
for _, r in d25.nlargest(10, "waa").iterrows():
    print(f"    {r.player_display_name:24s} {r.position}  WAA {r.waa:+.2f} wins  "
          f"floor {r.flr:.0%}  spike {r.spk:.0%}  ghost {r.ghst:.0%}  ({r.fpts:.0f} pts)")

# ---------------------------------------------------------------- does it repeat?
print("\n" + "=" * 78)
print("P. DOES IT CARRY OVER?  —  year N metric vs year N+1 wins added")
print("=" * 78)
nx = W[["player_id", "season", "waa", "flr", "spk", "ghst"]].copy()
nx["season"] -= 1
nx.columns = ["player_id", "season", "waa_next", "flr_next", "spk_next", "ghst_next"]
J = W.merge(nx, on=["player_id", "season"]).merge(
    sp[["player_id", "season", "fpts", "ppg", "games", "age"]], on=["player_id", "season"], how="left")
J = J[J.games >= 6]
for p in ("QB", "RB", "WR", "TE"):
    d = J[J.position == p]
    if len(d) < 60:
        continue
    out = []
    for col in ("waa", "fpts", "ppg", "flr", "spk", "ghst", "wk_sd"):
        if col not in d.columns:
            continue
        ok = d[col].notna() & d.waa_next.notna()
        out.append((col, spearmanr(d.loc[ok, col], d.loc[ok, "waa_next"])[0]))
    out.sort(key=lambda t: -abs(t[1]))
    print(f"  {p} (n={len(d)}): " + "  ".join(f"{c}={r:+.3f}" for c, r in out))

print("\nwrote out/win_metrics.parquet")
