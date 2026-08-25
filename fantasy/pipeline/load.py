"""Stage 22: LOAD — replacing LIFT, which was built with the wrong sign.

LIFT asked how much ROOM a player had to grow: the job he is walking into minus
the job he already had. It validated at +29 points a season, and that number was
real but it was not what it looked like. High-LIFT players are cheap players --
LIFT correlates -0.45 with what the board pays -- and cheap players beat their
projections for a reason that has nothing to do with role: the projection
over-shoots at the top and under-shoots at the bottom. Rank on price alone and you
get +17 points of the same effect for free.

Hold price fixed and LIFT dies:

    role ahead alone   +31.1 pts   (t 4.1)
    job he had alone   +17.7 pts   (t 2.1)
    LIFT = role - job   +5.3 pts   (t 0.7)

Both halves point the SAME way, so subtracting one from the other cancels them.
A regression that picks its own weights wants (+13.5, +9.1); LIFT forces (+1, -1).
That is not a subtle miscalibration, it is a sign error.

LOAD adds them instead:

    LOAD = z(touches the 2026 role normally pays) + z(touches he actually got)

and it measures one thing: the size of a player's job, counting both the part he
has already proven and the part the depth chart just handed him. The board sees
neither cleanly -- it projects fantasy points, and two players with identical
projections can arrive there on volume or on touchdowns. The volume one repeats.

Everything below is scored with price held fixed, because "beats the board" is
worthless if it only means "is cheap".
"""
import pandas as pd, numpy as np, json, pickle, warnings
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
rng = np.random.default_rng(0)
sp = pd.read_parquet("out/player_seasons.parquet")
PANEL = pd.read_parquet("out/breakout_panel.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
POS = ("QB", "RB", "WR", "TE")

sp = sp[sp.position.isin(POS)].copy()
sp["opp"] = np.where(sp.position == "QB", sp.attempts + sp.carries, sp.targets + sp.carries)
sp["opp_pg"] = sp.opp / sp.games.clip(lower=1)
USE = sp[["player_id", "season", "position", "opp_pg", "games"]]

P = PANEL[["player_id", "season", "position", "depth", "depth_prev", "team",
           "new_team", "coach_change", "exp", "age"]].copy()
P["depth"] = (P.sort_values("depth")
               .groupby(["season", "team", "position"]).cumcount() + 1).reindex(P.index)
P = P.merge(USE.rename(columns={"opp_pg": "opp_now"})[["player_id", "season", "opp_now"]],
            on=["player_id", "season"], how="left")
prev = USE.copy(); prev["season"] += 1
P = P.merge(prev.rename(columns={"opp_pg": "opp_prev", "games": "games_prev"})
            [["player_id", "season", "opp_prev", "games_prev"]],
            on=["player_id", "season"], how="left")
P["opp_prev"] = P.opp_prev.fillna(0.0)


def role_curve(exclude_season=None):
    h = P[(P.season <= 2025) & P.depth.notna() & P.opp_now.notna()]
    if exclude_season is not None:
        h = h[h.season != exclude_season]
    r = h.groupby(["position", "depth"]).agg(
        role_opp=("opp_now", "median"), n=("opp_now", "size")).reset_index()
    return r[r.n >= 12]


ROLE = role_curve()
P = P.merge(ROLE[["position", "depth", "role_opp"]], on=["position", "depth"], how="left")


def to_load(df):
    """Both halves standardised within position, then summed and put on 0-100.
    Equal weights: the fitted ones are 1.5:1, close enough that forcing 1:1 costs
    almost nothing and cannot overfit four seasons."""
    def zz(c):
        return df.groupby("position")[c].transform(
            lambda s: (s - s.mean()) / s.std(ddof=0) if s.std(ddof=0) > 0 else s * 0)
    raw = zz("role_opp") + zz("opp_prev")
    z = (raw - raw.mean()) / raw.std(ddof=0)
    return raw, (50 + 15 * z).clip(0, 100)


P["load_raw"], P["LOAD"] = to_load(P)
P["lift_raw"] = P.role_opp - P.opp_prev      # kept so the retraction is inspectable

print("what each rung of the depth chart is worth, in touches per game:")
for pos in POS:
    r = ROLE[ROLE.position == pos].sort_values("depth")
    print(f"  {pos}: " + "  ".join(f"#{int(d)}:{v:.1f}" for d, v in zip(r.depth, r.role_opp)))

# ---------------------------------------------------------------- validate
rows = []
for s in sorted(set(P.season) & set(BOARDS)):
    b, rep = BOARDS[s]
    nx = sp[sp.season == s][["player_id", "fpts"]].rename(columns={"fpts": "y_fpts"})
    rc = role_curve(exclude_season=s)                 # curve never sees this season
    ds = P[P.season == s].drop(columns=["role_opp", "LOAD", "load_raw"]).merge(
        rc[["position", "depth", "role_opp"]], on=["position", "depth"], how="left")
    ds["load_raw"], ds["LOAD"] = to_load(ds)
    ds["lift_raw"] = ds.role_opp - ds.opp_prev
    d = ds.merge(b[["player_id", "proj_blend", "position"]].rename(
        columns={"position": "pos_b"}), on="player_id", how="inner")
    d["vorp_proj"] = d.proj_blend - d.pos_b.map(rep)
    rows.append(d.merge(nx, on="player_id", how="inner"))
D = pd.concat(rows, ignore_index=True)
D = D[D.LOAD.notna() & D.vorp_proj.notna()].copy()
D["resid"] = D.y_fpts - D.proj_blend

# the priced pool — a 10-team league buys ~140 skill players
D["rk"] = D.groupby("season").vorp_proj.rank(ascending=False, method="first")
D = D[D.rk <= 140].copy()
print(f"\ntestable player-seasons in the priced pool: {len(D)}  "
      f"seasons {sorted(D.season.unique().astype(int))}")

D["z_price"] = D.groupby(["season", "position"]).vorp_proj.transform(
    lambda s: (s - s.mean()) / s.std(ddof=0) if s.std(ddof=0) > 0 else s * 0)
D["pdec"] = D.groupby("season").z_price.transform(
    lambda s: pd.qcut(s.rank(method="first"), 5, labels=False))


def held_fixed(col, frac=0.30):
    """Top vs bottom on `col` INSIDE each price band, so the comparison is always
    between players who cost about the same."""
    tops, bots = [], []
    for (s, q), g in D.groupby(["season", "pdec"]):
        g = g[g[col].notna()]
        if len(g) < 8:
            continue
        k = max(2, int(round(len(g) * frac)))
        tops.append(g.nlargest(k, col).resid.values)
        bots.append(g.nsmallest(k, col).resid.values)
    t, b = np.concatenate(tops), np.concatenate(bots)
    obs = t.mean() - b.mean()
    bs = np.array([rng.choice(t, len(t), True).mean() - rng.choice(b, len(b), True).mean()
                   for _ in range(4000)])
    return obs, bs.std()


print("\n" + "=" * 74)
print("W. PRICE HELD FIXED — points above projection, top 30% vs bottom 30%")
print("=" * 74)
print(f"  {'stat':<28}{'spread':>9}{'SE':>7}{'t':>7}")
CARD = [("LOAD  (role + usage)", "LOAD"), ("role alone", "role_opp"),
        ("last year's usage alone", "opp_prev"), ("LIFT  (retracted)", "lift_raw"),
        ("depth chart rank", "depth")]
res = {}
for lab, col in CARD:
    o, s = held_fixed(col)
    res[lab] = (o, s)
    print(f"  {lab:<28}{o:>+9.1f}{s:>7.1f}{o/s:>7.1f}")

print("\n  and the null it has to beat:")
o, s = held_fixed("z_price")
print(f"  {'price alone (inside band)':<28}{o:>+9.1f}{s:>7.1f}{o/s:>7.1f}")

print("\n" + "=" * 74)
print("X. BY SEASON — does it hold up every year, or is one season carrying it?")
print("=" * 74)
for s_, d in D.groupby("season"):
    ok = d.LOAD.notna()
    r_all = spearmanr(d.loc[ok, "LOAD"], d.loc[ok, "resid"])[0]
    print(f"    {int(s_)}: rho {r_all:+.3f}   n={int(ok.sum())}")

print("\n" + "=" * 74)
print("Y. WHAT YOU ACTUALLY GET, by LOAD quintile (price held fixed within band)")
print("=" * 74)
D["q"] = pd.qcut(D.LOAD.rank(method="first"), 5, labels=["bottom", "2nd", "middle", "4th", "top"])
for q, d in D.groupby("q", observed=True):
    print(f"    {str(q):<8} {d.resid.mean():+7.1f} pts   (n={len(d)})   "
          f"median LOAD {d.LOAD.median():.0f}   beat proj by 50+: {(d.resid >= 50).mean():.1%}")

load_spread, load_se = res["LOAD  (role + usage)"]
lift_spread, lift_se = res["LIFT  (retracted)"]
json.dump(dict(spread=round(float(load_spread), 1), se=round(float(load_se), 1),
               t=round(float(load_spread / load_se), 1), n=int(len(D)),
               seasons=[int(x) for x in sorted(D.season.unique())],
               lift_spread=round(float(lift_spread), 1), lift_se=round(float(lift_se), 1),
               lift_t=round(float(lift_spread / lift_se), 1),
               null_price=round(float(o), 1),
               card=[dict(stat=l, spread=round(float(v[0]), 1), se=round(float(v[1]), 1),
                          t=round(float(v[0] / v[1]), 1)) for l, v in res.items()],
               role_curve={p: {int(r.depth): round(float(r.role_opp), 1)
                               for _, r in ROLE[ROLE.position == p].iterrows()} for p in POS},
               quintiles={str(q): dict(resid=round(float(d.resid.mean()), 1),
                                       hit=round(float((d.resid >= 50).mean()), 3),
                                       load=round(float(d.LOAD.median()), 1))
                          for q, d in D.groupby("q", observed=True)}),
          open("out/research_load.json", "w"), indent=1)
P.to_parquet("out/load.parquet")
print("\nwrote out/research_load.json, out/load.parquet")
