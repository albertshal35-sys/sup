"""Stage 28: does the games-played model beat guessing the average?

Projected points are points-per-game times EXPECTED GAMES, so the games model is
half the board. It is also the half nobody validated. Two 2026 projections make the
case that something is wrong:

    Joe Burrow      played  8 games in 2025  ->  projected 16.0
    Jayden Daniels  played  7 games in 2025  ->  projected  8.7

Same evidence, opposite conclusions. And Jalen Hurts, who played 17, 15 and 16
games in the last three seasons, is projected for 12.0 — which is what drops him to
QB13 on a board where the industry consensus has him top four.

The test is the obvious one and should have been run at the start: against a holdout
season, does the model's games prediction beat the dumbest possible baselines?

    MEAN        every player at his position gets the positional average
    LAST        every player repeats his own last season
    SHRUNK      the positional average, nudged toward last season by a fitted weight

If the model cannot beat MEAN, it is adding noise to half of every projection.
"""
import pandas as pd, numpy as np, json, warnings
from sklearn.ensemble import HistGradientBoostingRegressor

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
POS = ("QB", "RB", "WR", "TE")

d = sp[sp.position.isin(POS)].copy()
nxt = d[["player_id", "season", "games"]].copy()
nxt["season"] -= 1
nxt.columns = ["player_id", "season", "g_next"]
d = d.merge(nxt, on=["player_id", "season"], how="inner")
d = d[(d.season >= 2010) & (d.games >= 1)].copy()
print(f"{len(d)} player-seasons with a following season, {int(d.season.min())}-{int(d.season.max())}")

# how much does last season's availability actually carry?
print("\n" + "=" * 74)
print("A. DOES GAMES PLAYED REPEAT AT ALL?")
print("=" * 74)
print(f"  {'pos':<5}{'corr(g, g_next)':>18}{'mean g_next':>14}{'sd':>7}")
for p in POS:
    s = d[d.position == p]
    print(f"  {p:<5}{s.games.corr(s.g_next):>18.3f}{s.g_next.mean():>14.1f}{s.g_next.std():>7.1f}")

print("\n  ...and split by how much time a player missed:")
print(f"  {'pos':<5}{'played 16+':>12}{'played 12-15':>14}{'played 8-11':>13}{'played <8':>11}")
for p in POS:
    s = d[d.position == p]
    row = []
    for lo, hi in ((16, 99), (12, 15), (8, 11), (0, 7)):
        m = s[(s.games >= lo) & (s.games <= hi)]
        row.append(f"{m.g_next.mean():.1f}" if len(m) >= 20 else "-")
    print(f"  {p:<5}{row[0]:>12}{row[1]:>14}{row[2]:>13}{row[3]:>11}")

# ------------------------------------------------------------------ bake-off
FEATS = ["games", "age", "exp", "ppg", "touch_pg", "pass_att_pg", "rush_att_qb_pg",
         "car_pg", "tgt_pg", "fpts"]
FEATS = [c for c in FEATS if c in d.columns]

print("\n" + "=" * 74)
print("B. HOLDOUT TEST — mean absolute error in games, by test season")
print("=" * 74)
seasons = sorted(s for s in d.season.unique() if s >= 2015)
rows = []
for s in seasons:
    tr, te = d[d.season < s], d[d.season == s]
    if len(te) < 40:
        continue
    r = dict(season=int(s), n=len(te))
    # baseline 1: positional mean from the training years
    pm = tr.groupby("position").g_next.mean()
    r["mean"] = np.abs(te.position.map(pm) - te.g_next).mean()
    # baseline 2: repeat last season
    r["last"] = np.abs(te.games - te.g_next).mean()
    # baseline 3: shrink last season toward the positional mean, weight fitted on train
    best, bw = 1e9, 0.0
    for w in np.arange(0, 1.01, 0.05):
        pred = tr.position.map(pm) * (1 - w) + tr.games * w
        e = np.abs(pred - tr.g_next).mean()
        if e < best:
            best, bw = e, w
    r["shrunk"] = np.abs(te.position.map(pm) * (1 - bw) + te.games * bw - te.g_next).mean()
    r["w"] = bw
    # the model, per position, same recipe as the board
    pred = np.full(len(te), np.nan)
    for p in POS:
        mtr, mte = tr[tr.position == p], te[te.position == p]
        if len(mtr) < 100 or not len(mte):
            continue
        m = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.06,
                                          min_samples_leaf=25, random_state=0)
        m.fit(mtr[FEATS], mtr.g_next)
        pred[(te.position == p).values] = m.predict(mte[FEATS])
    ok = ~np.isnan(pred)
    r["model"] = np.abs(pred[ok] - te.g_next.values[ok]).mean()
    rows.append(r)

R = pd.DataFrame(rows)
print(f"  {'season':>7}{'n':>6}{'MEAN':>8}{'LAST':>8}{'SHRUNK':>9}{'MODEL':>8}{'w':>6}")
for _, r in R.iterrows():
    print(f"  {int(r.season):>7}{int(r.n):>6}{r['mean']:>8.2f}{r['last']:>8.2f}"
          f"{r['shrunk']:>9.2f}{r['model']:>8.2f}{r['w']:>6.2f}")
print(f"  {'MEAN':>7}{'':>6}{R['mean'].mean():>8.2f}{R['last'].mean():>8.2f}"
      f"{R['shrunk'].mean():>9.2f}{R['model'].mean():>8.2f}")

win = R['mean'].mean() - R['model'].mean()
print(f"\n  model beats the positional average by {win:+.2f} games "
      f"({'worth keeping' if win > 0.05 else 'NOT worth keeping'})")
print(f"  best simple baseline is {'SHRUNK' if R['shrunk'].mean() < R['mean'].mean() else 'MEAN'}"
      f" at {min(R['shrunk'].mean(), R['mean'].mean()):.2f}, shrink weight ~{R.w.mean():.2f}")

json.dump(dict(mean=round(float(R['mean'].mean()), 2), last=round(float(R['last'].mean()), 2),
               shrunk=round(float(R['shrunk'].mean()), 2), model=round(float(R['model'].mean()), 2),
               w=round(float(R.w.mean()), 2),
               seasons=[int(x) for x in R.season]),
          open("out/research_games.json", "w"), indent=1)
print("\nwrote out/research_games.json")
