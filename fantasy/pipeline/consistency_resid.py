"""Stage 11: where does the win-lens actually belong?

Pricing straight off Wins Above Available lost by 7 points of win rate even though
WAA is the better forecast of realised wins added. The reason is a modelling
error worth stating plainly:

    A team's weekly score is the SUM of its starters' points. Sums are linear.
    The win curve — the S-shaped map from score to victory — applies ONCE, at the
    team level, when your total meets an opponent's total. Applying it a second
    time to each player individually, as WAA does, double-counts the curve and
    misprices everyone.

So a player's contribution to the team mean is exactly his points, linearly. The
only place the win curve leaves room for a custom statistic is the team's
VARIANCE: for a team scoring above the league average, lower week-to-week
variance raises win probability at the same mean.

This sweeps that idea. Value = projected points − k × projected weekly spread.
k = 0 is ordinary points-based pricing. Negative k pays up for boom-bust.
"""
import pandas as pd, numpy as np, json, warnings
from sklearn.ensemble import HistGradientBoostingRegressor

warnings.filterwarnings("ignore")
exec(open("waa_proof.py").read().split("# ---------------------------------------------------------------- the bake-off")[0])

KS = [-12.0, -6.0, 0.0, 6.0, 12.0, 24.0]   # on RESIDUAL spread, so mean is held constant


def sd_board(season):
    """Projected week-to-week spread, trained only on data predating `season`."""
    out = []
    for pos in ("QB", "RB", "WR", "TE"):
        tr = P2[(P2.position == pos) & (P2.season < season - 1) & P2.wk_sd.notna()]
        tr = tr[tr.y_waa.notna()]
        te = P2[(P2.position == pos) & (P2.season == season - 1)]
        if len(tr) < 150 or len(te) == 0:
            continue
        nxt_sd = base[["player_id", "season", "wk_sd"]].copy()
        nxt_sd["season"] -= 1
        nxt_sd.columns = ["player_id", "season", "y_sd"]
        trj = tr.merge(nxt_sd, on=["player_id", "season"], how="inner")
        if len(trj) < 150:
            continue
        m = hgb(3, 250).fit(trj[FEAT], trj.y_sd)
        out.append(pd.DataFrame(dict(player_id=te.player_id.values, position=pos,
                                     proj_sd=m.predict(te[FEAT]))))
    return pd.concat(out, ignore_index=True) if out else None


print("=" * 78)
print("S. CONSISTENCY, MEAN HELD CONSTANT  —  value = points − k × RESIDUAL spread")
print("=" * 78)
obs = {k: [] for k in KS}
for season in ALL:
    pts_board, rep = BOARDS[season]
    sb = sd_board(season)
    if sb is None:
        continue
    b = pts_board.merge(sb, on=["player_id", "position"], how="inner").reset_index(drop=True)
    if len(b) < 150:
        continue
    # strip out the part of weekly spread that is just "he scores a lot" — big
    # scorers are mechanically more volatile, and rewarding that is only a
    # roundabout way of paying more for good players
    for pos in ("QB", "RB", "WR", "TE"):
        m = b.position == pos
        if m.sum() < 10:
            continue
        x = b.loc[m, "proj_blend"].values
        y = b.loc[m, "proj_sd"].values
        A = np.vstack([x, np.ones_like(x)]).T
        coef = np.linalg.lstsq(A, y, rcond=None)[0]
        b.loc[m, "sd_resid"] = y - (A @ coef)
    b["sd_resid"] = b["sd_resid"].fillna(0.0)
    price_sets_by_k = {}
    for k in KS:
        b["_v"] = b.proj_blend - k * b["sd_resid"]
        price_sets_by_k[k] = price_from(b, "_v")
    mat = WKP[season].reindex(b.player_id.values).fillna(0.0).values
    pos_arr = b.position.values

    for ns in range(14):
        rng = np.random.default_rng((season * 3931 + ns * 53) % (2**31))
        for rot in range(12):
            arms = [KS[(t + rot) % len(KS)] for t in range(TEAMS)]
            psets = [price_sets_by_k[a] for a in arms]
            teams = run(pos_arr, psets, [str(a) for a in arms], rng)
            sc = np.zeros((TEAMS, 17))
            for t in range(TEAMS):
                ix = np.array(teams[t].roster)
                sc[t] = optimal_weekly(pos_arr[ix], mat[ix])
            wins = np.zeros(TEAMS)
            for w in range(17):
                c = sc[:, w]
                wins += (c[:, None] > c[None, :]).sum(axis=1)
            wins /= 17 * (TEAMS - 1)
            for t in range(TEAMS):
                obs[arms[t]].append(wins[t])
    print("  ", season, "done", flush=True)

rows = []
for k in KS:
    v = np.array(obs[k])
    rows.append(dict(k=k, win=v.mean() * 100, se=v.std(ddof=1) / np.sqrt(len(v)) * 100, n=len(v)))
r = pd.DataFrame(rows)
base_w = float(r[r.k == 0].win.iloc[0])
r["vs_points"] = (r.win - base_w).round(2)
print("\n", r.round(2).to_string(index=False))
print(f"\n  k = 0 is ordinary points pricing ({base_w:.2f}%).")
for _, x in r.iterrows():
    if x.k == 0:
        continue
    se = np.sqrt(x.se ** 2 + float(r[r.k == 0].se.iloc[0]) ** 2)
    print(f"    k={x.k:+6.1f}: {x.vs_points:+5.2f} pp  ({abs(x.vs_points)/se:.1f} SE)")
json.dump(r.to_dict("records"), open("out/research_consistency_resid.json", "w"), indent=1, default=str)
print("\nwrote out/research_consistency_resid.json")
