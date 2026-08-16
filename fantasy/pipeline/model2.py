"""Stage 3b: does de-luckifying touchdowns beat 'just use last year'?

Builds expected fantasy points (xFP) from volume alone, then tests whether
volume-based projection outperforms points-based projection out of sample.
"""
import pandas as pd, numpy as np, json, warnings, pickle
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")

# ------------------------------------------------- expected fantasy points (xFP)
# Strip TDs out and re-add them at the league-average rate for that usage type.
# Anything above xFP was touchdown luck; the question is how much of it repeats.
lg = sp[sp.season >= 2009]
td_per_carry = lg["rushing_tds"].sum() / lg["carries"].sum()
td_per_target = lg["receiving_tds"].sum() / lg["targets"].sum()
td_per_patt = lg["passing_tds"].sum() / lg["attempts"].sum()
print(f"league TD rates: {td_per_carry:.4f}/carry  {td_per_target:.4f}/target  {td_per_patt:.4f}/pass att")

sp["xfp"] = (
    sp["rushing_yards"] * 0.1 + sp["carries"] * td_per_carry * 6
    + sp["receptions"] * 1.0 + sp["receiving_yards"] * 0.1 + sp["targets"] * td_per_target * 6
    + sp["passing_yards"] * 0.04 + sp["attempts"] * td_per_patt * 4
    + sp["passing_interceptions"] * -2 + sp["fum_lost"] * -2
)
sp["xfp_pg"] = sp["xfp"] / sp["games"]
sp["td_luck_pg"] = sp["ppg"] - sp["xfp_pg"]

print("\n" + "=" * 78)
print("H. TOUCHDOWN LUCK  —  how much of an over-performance repeats?")
print("=" * 78)
n = sp[["player_id", "season", "ppg", "xfp_pg", "fpts", "games"]].copy()
n["season"] -= 1
n.columns = ["player_id", "season", "y_ppg", "y_xfp_pg", "y_fpts", "y_games"]
pan = sp.merge(n, on=["player_id", "season"], how="inner")
pan = pan[(pan.games >= 8) & (pan.season >= 2009)]

for pos in ["QB", "RB", "WR", "TE"]:
    d = pan[pan.position == pos]
    r_ppg = spearmanr(d.ppg, d.y_ppg)[0]
    r_xfp = spearmanr(d.xfp_pg, d.y_ppg)[0]
    r_luck = spearmanr(d.td_luck_pg, d.y_ppg - d.y_xfp_pg)[0]
    # what happens to the biggest TD over-performers?
    hi = d[d.td_luck_pg >= d.td_luck_pg.quantile(0.90)]
    lo = d[d.td_luck_pg <= d.td_luck_pg.quantile(0.10)]
    print(f"  {pos}: last-yr PPG->next PPG rho={r_ppg:+.3f} | last-yr xFP->next PPG rho={r_xfp:+.3f}"
          f" | TD-luck repeatability rho={r_luck:+.3f}")
    print(f"       top-decile TD luck (+{hi.td_luck_pg.mean():.1f} ppg over xFP): "
          f"{hi.ppg.mean():.1f} -> {hi.y_ppg.mean():.1f} ppg ({hi.y_ppg.mean()-hi.ppg.mean():+.1f}), n={len(hi)}")
    print(f"       bottom-decile TD luck ({lo.td_luck_pg.mean():.1f}): "
          f"{lo.ppg.mean():.1f} -> {lo.y_ppg.mean():.1f} ppg ({lo.y_ppg.mean()-lo.ppg.mean():+.1f}), n={len(lo)}")

# ------------------------------------------------- head-to-head model bake-off
print("\n" + "=" * 78)
print("I. MODEL BAKE-OFF  —  out-of-sample, evaluated on next-season TOTAL points")
print("=" * 78)
LAGS = ["ppg", "xfp_pg", "games", "car_pg", "tgt_pg", "touch_pg", "td_pg", "target_share", "fpts"]
lag = sp[["player_id", "season"] + LAGS].copy()
lag["season"] += 1
lag.columns = ["player_id", "season"] + [c + "_l1" for c in LAGS]
lag2 = sp[["player_id", "season"] + LAGS].copy()
lag2["season"] += 2
lag2.columns = ["player_id", "season"] + [c + "_l2" for c in LAGS]
base = sp.merge(lag, on=["player_id", "season"], how="left").merge(lag2, on=["player_id", "season"], how="left")
nn = sp[["player_id", "season", "ppg", "games", "fpts"]].copy()
nn["season"] -= 1
nn.columns = ["player_id", "season", "y_ppg", "y_games", "y_fpts"]
P = base.merge(nn, on=["player_id", "season"], how="left")
P = P[(P.games >= 4) & (P.season >= 2009)]

COMMON = ["ppg", "xfp_pg", "td_luck_pg", "games", "age", "exp", "fpts",
          "ppg_l1", "xfp_pg_l1", "games_l1", "fpts_l1", "td_pg_l1",
          "ppg_l2", "xfp_pg_l2", "games_l2"]
POSF = {
    "QB": ["pass_att_pg", "pass_yd_pg", "epa_pass", "cpoe", "car_pg", "rushyd_pg", "td_pg", "car_pg_l1"],
    "RB": ["car_pg", "touch_pg", "tgt_pg", "rec_pg", "rushyd_pg", "ryd_pg", "fd_pg", "expl_pg",
           "td_rate", "ypc", "target_share", "epa_rush", "yac_pg", "car_pg_l1", "touch_pg_l1", "tgt_pg_l1"],
    "WR": ["tgt_pg", "rec_pg", "ryd_pg", "ayd_pg", "target_share", "air_yards_share", "wopr",
           "adot", "catch_rate", "ypt", "td_rate", "fd_pg", "expl_pg", "yac_pg", "epa_rec", "racr",
           "tgt_pg_l1", "target_share_l1", "ryd_pg_l1"],
    "TE": ["tgt_pg", "rec_pg", "ryd_pg", "ayd_pg", "target_share", "air_yards_share", "wopr",
           "adot", "catch_rate", "td_rate", "fd_pg", "expl_pg", "yac_pg", "epa_rec",
           "tgt_pg_l1", "target_share_l1"],
}


def mk(pos):
    f = [c for c in COMMON + POSF[pos] if c in P.columns]
    d = P[(P.position == pos) & P.y_fpts.notna()].copy()
    return f, d


def hgb(seed=0, depth=4, it=400):
    return HistGradientBoostingRegressor(max_depth=depth, learning_rate=0.05, max_iter=it,
                                         min_samples_leaf=20, l2_regularization=1.0,
                                         random_state=seed)


results, final = {}, {}
for pos in ["QB", "RB", "WR", "TE"]:
    f, d = mk(pos)
    rows = []
    for s in range(2013, 2025):
        tr, te = d[d.season < s], d[d.season == s]
        if len(te) < 20 or len(tr) < 200:
            continue
        mppg = hgb().fit(tr[f], tr.y_ppg)
        mg = hgb(depth=3, it=250).fit(tr[f], tr.y_games)
        pp, pg = mppg.predict(te[f]), np.clip(mg.predict(te[f]), 0, 17)
        rows.append(pd.DataFrame(dict(season=s, pred_total=pp * pg, pred_ppg=pp,
                                      naive_total=te.fpts.values, naive_ppg=te.ppg.values,
                                      xfp_total=(te.xfp_pg * te.games).values,
                                      y_total=te.y_fpts.values, y_ppg=te.y_ppg.values)))
    bt = pd.concat(rows)
    r_model = spearmanr(bt.pred_total, bt.y_total)[0]
    r_naive = spearmanr(bt.naive_total, bt.y_total)[0]
    r_xfp = spearmanr(bt.xfp_total, bt.y_total)[0]
    # blend
    bl = 0.75 * bt.pred_total.rank(pct=True) + 0.25 * bt.naive_total.rank(pct=True)
    r_blend = spearmanr(bl, bt.y_total)[0]
    # per-season mean so a single weird year cannot carry it
    per = bt.groupby("season").apply(lambda g: pd.Series(dict(
        m=spearmanr(g.pred_total, g.y_total)[0], n=spearmanr(g.naive_total, g.y_total)[0])))
    print(f"\n  {pos}  (n={len(bt)} player-seasons, 2010-2024 out of sample)")
    print(f"     model rho={r_model:+.3f}   naive last-yr-total rho={r_naive:+.3f}   "
          f"xFP-total rho={r_xfp:+.3f}   blend rho={r_blend:+.3f}")
    print(f"     per-season mean: model={per.m.mean():+.3f} naive={per.n.mean():+.3f}  "
          f"model wins {(per.m>per.n).sum()}/{len(per)} seasons")
    # top-24 hit rate: of players the method ranks top 24, how many finish top 24?
    def hit(col, k=24):
        h = []
        for s, g in bt.groupby("season"):
            top = g.nlargest(k, col)
            h.append((top.y_total.rank(ascending=False) <= k).mean() if False else
                     (top.y_total >= g.y_total.nlargest(k).min()).mean())
        return np.mean(h)
    print(f"     top-24 hit rate: model={hit('pred_total'):.1%}  naive={hit('naive_total'):.1%}")
    results[pos] = dict(model=round(float(per.m.mean()), 3), naive=round(float(per.n.mean()), 3),
                        xfp=round(float(r_xfp), 3), blend=round(float(r_blend), 3),
                        seasons_won=int((per.m > per.n).sum()), seasons=int(len(per)),
                        hit_model=round(float(hit('pred_total')), 3),
                        hit_naive=round(float(hit('naive_total')), 3))
    fm = hgb().fit(d[f], d.y_ppg)
    fg = hgb(depth=3, it=250).fit(d[f], d.y_games)
    final[pos] = dict(ppg=fm, games=fg, feats=f)

pickle.dump(final, open("out/models2.pkl", "wb"))
sp.to_parquet("out/player_seasons.parquet")
json.dump(results, open("out/research_c.json", "w"), indent=1, default=str)
print("\nwrote out/models2.pkl, out/research_c.json")
