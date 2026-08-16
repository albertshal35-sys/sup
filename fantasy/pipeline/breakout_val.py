"""Stage 16: do the situational signals beat the price sheet, or just decorate it?

The board already prices what a player did. The only thing a breakout list can
add is information about what changed around him. So the target here is not next
season's points — it is the RESIDUAL: how far a player finished above or below
what the projection already said. If the signals cannot predict that, they are
worth nothing on top of the board and should not pretend otherwise.

Tested leave-one-season-out, so every prediction is made by a model that never
saw that season.
"""
import pandas as pd, numpy as np, json, warnings, pickle
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
P = pd.read_parquet("out/breakout_panel.parquet")
cache = pickle.load(open("out/boards_cache.pkl", "rb"))
BOARDS = cache["BOARDS"]

SIG = ["vac_tgt_share", "vac_car_share", "vac_tgt", "vac_car", "climb", "depth",
       "new_team", "coach_change", "trend", "td_luck_pg", "exp", "age",
       "sos", "sos_playoff", "tgt_pg", "car_pg", "target_share", "ppg", "games"]

# attach the leak-free projection each season's board carried
rows = []
for season in sorted(P.season.unique()):
    if season not in BOARDS:
        continue
    b, _ = BOARDS[season]
    d = P[P.season == season].merge(
        b[["player_id", "proj_blend"]], on="player_id", how="inner")
    rows.append(d)
D = pd.concat(rows, ignore_index=True)
D = D[D.y_fpts.notna()]
D["resid"] = D.y_fpts - D.proj_blend
print(f"seasons with both a projection and an outcome: {sorted(D.season.unique())}  (n={len(D)})")

feat = [c for c in SIG if c in D.columns]
print(f"signals: {len(feat)}")

# ---------------------------------------------------------------- does it predict?
print("\n" + "=" * 76)
print("W. CAN THE SIGNALS PREDICT WHAT THE PRICE SHEET MISSED?")
print("=" * 76)
preds, actual, seasons = [], [], []
for s in sorted(D.season.unique()):
    tr, te = D[D.season != s], D[D.season == s]
    if len(tr) < 300 or len(te) < 40:
        continue
    m = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=250,
                                      min_samples_leaf=25, l2_regularization=1.0,
                                      random_state=0).fit(tr[feat], tr.resid)
    p = m.predict(te[feat])
    preds += list(p); actual += list(te.resid); seasons += [s] * len(te)
    print(f"  {s}: rho {spearmanr(p, te.resid)[0]:+.3f}   n={len(te)}")
preds, actual = np.array(preds), np.array(actual)
seasons = np.array(seasons)
rho = spearmanr(preds, actual)[0]
print(f"\n  pooled rho = {rho:+.3f}  (n={len(preds)})")

# what does acting on it actually buy you?
q = pd.DataFrame(dict(pred=preds, resid=actual, season=seasons))
q["bucket"] = pd.qcut(q.pred, 5, labels=["bottom 20%", "2nd", "middle", "4th", "top 20%"])
print("\n  mean points above projection, by how strongly the signals liked them:")
for b, d in q.groupby("bucket", observed=True):
    print(f"    {str(b):<12} {d.resid.mean():+7.1f} pts   (n={len(d)})")
spread = q[q.bucket == "top 20%"].resid.mean() - q[q.bucket == "bottom 20%"].resid.mean()
se = np.sqrt(q[q.bucket == "top 20%"].resid.var() / (q.bucket == "top 20%").sum()
             + q[q.bucket == "bottom 20%"].resid.var() / (q.bucket == "bottom 20%").sum())
print(f"\n  top fifth minus bottom fifth: {spread:+.1f} points  ({abs(spread)/se:.1f} SE)")

# which signals carry it
print("\n  signal strength on its own (rho with the residual):")
sig_rho = []
for c in feat:
    ok = D[c].notna()
    if ok.sum() < 200:
        continue
    r = spearmanr(D.loc[ok, c], D.loc[ok, "resid"])[0]
    sig_rho.append((c, r, int(ok.sum())))
sig_rho.sort(key=lambda t: -abs(t[1]))
for c, r, n in sig_rho[:10]:
    print(f"    {c:<16} {r:+.3f}  n={n}")

json.dump(dict(rho=round(float(rho), 3), spread=round(float(spread), 1),
               se=round(float(se), 1), n=int(len(preds)),
               seasons=[int(x) for x in sorted(D.season.unique())],
               signals=[(c, round(float(r), 3)) for c, r, _ in sig_rho[:12]]),
          open("out/research_breakout.json", "w"), indent=1)

# ---------------------------------------------------------------- the 2026 list
full = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=250,
                                     min_samples_leaf=25, l2_regularization=1.0,
                                     random_state=0).fit(D[feat], D.resid)
now = P[P.season == 2026].copy()
now["edge"] = full.predict(now[feat])
now.to_parquet("out/breakout_2026.parquet")
print(f"\nscored {len(now)} players for 2026 -> out/breakout_2026.parquet")
print("\n  top 15 by projected points above their price:")
show = now.nlargest(15, "edge")[["player_display_name", "position", "team", "edge",
                                 "vac_tgt_share", "climb", "new_team", "coach_change", "sos"]]
print(show.round(2).to_string(index=False))
