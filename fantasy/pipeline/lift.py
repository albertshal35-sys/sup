"""Stage 19: LIFT — the gap between the job a player has now and the work he did.

The first attempt at a breakout stat (RUNWAY) multiplied efficiency-over-teammates
by unclaimed opportunity. It returned nothing, and the post-mortem is the useful
part: efficiency over one's own teammates graded out NEGATIVE. Coaches do not hand
work to the efficient backup. A high rate on few touches is mostly small-sample
noise, and it regresses.

What did carry signal was cruder and more literal: where a player sits on the
depth chart, and how far he has moved on it. So the stat should measure the ROLE,
not the running. And the sharpest version of role is not the depth chart rank on
its own — it is the mismatch between the job a player holds today and the workload
he actually carried last year.

    LIFT = (touches per game a player in his 2026 role normally gets)
         - (touches per game he actually got in 2025)

A rookie starter has enormous LIFT. So does a backup promoted after the man ahead
of him left. A player already carrying a full load has none, no matter how good he
is — which is the point, because the board has already paid for what he did.

Expected touches per role are measured, not assumed: for every position and every
depth-chart rank, what such players have actually received since 2021.
"""
import pandas as pd, numpy as np, json, pickle, warnings
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
PANEL = pd.read_parquet("out/breakout_panel.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
POS = ("QB", "RB", "WR", "TE")

# ---------------------------------------------------------------- touches per game
sp = sp[sp.position.isin(POS)].copy()
sp["opp"] = np.where(sp.position == "QB", sp.attempts + sp.carries, sp.targets + sp.carries)
sp["opp_pg"] = sp.opp / sp.games.clip(lower=1)
USE = sp[["player_id", "season", "position", "opp_pg", "games"]]

# ---------------------------------------------------------------- what a role is worth
# PANEL carries the preseason depth-chart rank for each player-season, so join
# actual workload onto it and read off what each rung of the ladder pays.
P = PANEL[["player_id", "season", "position", "depth", "depth_prev", "team",
           "new_team", "coach_change", "exp", "age"]].copy()
# ESPN-style charts rank a receiver within his alignment, so several men on one
# team all read "1". Re-rank inside team and position so WR1 means WR1.
P["depth"] = (P.sort_values("depth")
               .groupby(["season", "team", "position"])
               .cumcount() + 1).reindex(P.index)
cur_use = USE.rename(columns={"opp_pg": "opp_now"})[["player_id", "season", "opp_now"]]
P = P.merge(cur_use, on=["player_id", "season"], how="left")          # what he then did
prev_use = USE.copy(); prev_use["season"] += 1
prev_use = prev_use.rename(columns={"opp_pg": "opp_prev", "games": "games_prev"})
P = P.merge(prev_use[["player_id", "season", "opp_prev", "games_prev"]],
            on=["player_id", "season"], how="left")

def role_curve(exclude_season=None):
    """What each rung of the ladder pays, in touches per game. Fit leaving the
    season under test out, so the curve never sees the outcomes it is scoring."""
    h = P[(P.season <= 2025) & P.depth.notna() & P.opp_now.notna()]
    if exclude_season is not None:
        h = h[h.season != exclude_season]
    r = h.groupby(["position", "depth"]).agg(
        role_opp=("opp_now", "median"), n=("opp_now", "size")).reset_index()
    return r[r.n >= 12]


ROLE = role_curve()                     # full curve, for scoring 2026
print("what each rung of the depth chart is worth, in touches per game:")
for pos in POS:
    r = ROLE[ROLE.position == pos].sort_values("depth")
    print(f"  {pos}: " + "  ".join(f"#{int(d)}:{v:.1f}" for d, v in zip(r.depth, r.role_opp)))

P["opp_prev"] = P.opp_prev.fillna(0.0)
P = P.merge(ROLE[["position", "depth", "role_opp"]], on=["position", "depth"], how="left")
P["lift_raw"] = P.role_opp - P.opp_prev


def to_lift(df, col="lift_raw"):
    """Touches mean different things at different positions — a quarterback drops
    back 35 times, a third receiver sees five. So the gap is scored against other
    men at the same position, and reported on a 0-100 scale."""
    z = df.groupby("position")[col].transform(lambda s: (s - s.mean()) / s.std(ddof=0))
    return (50 + 15 * z).clip(0, 100)


P["LIFT"] = to_lift(P)

# ---------------------------------------------------------------- validate
rows = []
for s in sorted(set(P.season) & set(BOARDS)):
    b, _ = BOARDS[s]
    nx = sp[sp.season == s][["player_id", "fpts"]].rename(columns={"fpts": "y_fpts"})
    # score this season with a role curve that never saw it
    rc = role_curve(exclude_season=s)
    ds = P[P.season == s].drop(columns=["role_opp", "LIFT"]).merge(
        rc[["position", "depth", "role_opp"]], on=["position", "depth"], how="left")
    ds["lift_raw"] = ds.role_opp - ds.opp_prev
    ds["LIFT"] = to_lift(ds)
    d = ds.merge(b[["player_id", "proj_blend"]], on="player_id", how="inner")
    d = d.merge(nx, on="player_id", how="inner")
    rows.append(d)
D = pd.concat(rows, ignore_index=True)
D = D[D.LIFT.notna()]
D["resid"] = D.y_fpts - D.proj_blend
print(f"\ntestable player-seasons: {len(D)}  seasons {sorted(D.season.unique())}")

print("\n" + "=" * 74)
print("Y. DOES LIFT FIND WHAT THE PRICE SHEET MISSED?")
print("=" * 74)
print(f"  {'metric':<30}{'rho vs residual':>16}")
for col, lab in [("LIFT", "LIFT"), ("role_opp", "  role alone (2026 job)"),
                 ("opp_prev", "  last year's touches alone"),
                 ("depth", "  depth chart rank alone")]:
    ok = D[col].notna()
    print(f"  {lab:<30}{spearmanr(D.loc[ok, col], D.loc[ok, 'resid'])[0]:>+16.3f}")

print("\n  by season:")
for s, d in D.groupby("season"):
    if len(d) < 40:
        continue
    print(f"    {s}: {spearmanr(d.LIFT, d.resid)[0]:+.3f}   n={len(d)}")

print("\n  mean points above projection, by LIFT quintile:")
D["q"] = pd.qcut(D.LIFT.rank(method="first"), 5, labels=["bottom", "2nd", "middle", "4th", "top"])
for q, d in D.groupby("q", observed=True):
    print(f"    {str(q):<8} {d.resid.mean():+7.1f} pts   (n={len(d)})   "
          f"median LIFT {d.LIFT.median():.0f}, {d.lift_raw.median():+.1f} touches/gm")
hi, lo = D[D.q == "top"], D[D.q == "bottom"]
spread = hi.resid.mean() - lo.resid.mean()
se = np.sqrt(hi.resid.var() / len(hi) + lo.resid.var() / len(lo))
print(f"\n  top fifth minus bottom fifth: {spread:+.1f} pts  ({abs(spread)/se:.1f} SE)")

# does it beat its own parts?
print("\n  the product test — does the gap beat either half on its own?")
for lab, col in [("role only", "role_opp"), ("last year only", "opp_prev"),
                 ("raw touch gap", "lift_raw")]:
    d2 = D.copy()
    d2["qq"] = pd.qcut(d2[col].rank(method="first"), 5, labels=False)
    s2 = d2[d2.qq == 4].resid.mean() - d2[d2.qq == 0].resid.mean()
    print(f"    {lab:<16} {s2:+6.1f} pts")
print(f"    {'LIFT':<16} {spread:+6.1f} pts")

# hit rate on the thing people actually care about
print("\n  share of players who beat their projection by 50+ points:")
for q, d in D.groupby("q", observed=True):
    print(f"    {str(q):<8} {(d.resid >= 50).mean():.1%}")

json.dump(dict(rho=round(float(spearmanr(D.LIFT, D.resid)[0]), 3),
               spread=round(float(spread), 1), se=round(float(se), 1), n=int(len(D)),
               seasons=[int(x) for x in sorted(D.season.unique())],
               role_curve={p: {int(r.depth): round(float(r.role_opp), 1)
                               for _, r in ROLE[ROLE.position == p].iterrows()} for p in POS},
               quintiles={str(q): dict(resid=round(float(d.resid.mean()), 1),
                                       hit=round(float((d.resid >= 50).mean()), 3),
                                       lift=round(float(d.LIFT.median()), 1))
                          for q, d in D.groupby("q", observed=True)}),
          open("out/research_lift.json", "w"), indent=1)
P.to_parquet("out/lift.parquet")
print("\nwrote out/research_lift.json, out/lift.parquet")
