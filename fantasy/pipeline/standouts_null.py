"""Stage 21c: the control that decides whether the corners mean anything.

Every corner is defined as (signal - price). If the board systematically
over-projects expensive players and under-projects cheap ones, then the price term
alone wins and the signal is decoration. So run the null: rank on -price and
nothing else, and see how much of each corner's spread it already explains.

Also fix the error bars. Four seasons give four numbers; an SE from four numbers is
barely an SE. Bootstrap over players instead, which is what the corner list is
actually selecting.
"""
import pandas as pd, numpy as np, warnings

warnings.filterwarnings("ignore")
rng = np.random.default_rng(0)
D = pd.read_parquet("out/corr_panel.parquet")
POS = ("QB", "RB", "WR", "TE")

D = D[D.position.isin(POS) & D.resid.notna() & D.vorp_proj.notna()].copy()
D["rk"] = D.groupby("season").vorp_proj.rank(ascending=False, method="first")
P = D[D.rk <= 140].copy()


def z(df, col):
    return df.groupby(["season", "position"])[col].transform(
        lambda s: (s - s.mean()) / s.std(ddof=0) if s.std(ddof=0) > 0 else s * 0)


P["z_price"] = z(P, "vorp_proj")
for c in ("LIFT", "climb", "role_opp", "opp_prev"):
    P["z_" + c] = z(P, c)
P = P[P.z_LIFT.notna()].copy()          # depth-chart era only, one common sample
print(f"common sample: {len(P)} player-seasons, "
      f"{sorted(P.season.unique().astype(int))}")


def spread(d, gapcol, frac=0.15, nboot=2000):
    """top-vs-bottom residual spread, with a bootstrap over players."""
    tops, bots = [], []
    for s, g in d.groupby("season"):
        k = max(6, int(round(len(g) * frac)))
        tops.append(g.nlargest(k, gapcol).resid.values)
        bots.append(g.nsmallest(k, gapcol).resid.values)
    t, b = np.concatenate(tops), np.concatenate(bots)
    obs = t.mean() - b.mean()
    bs = np.array([rng.choice(t, len(t), True).mean() - rng.choice(b, len(b), True).mean()
                   for _ in range(nboot)])
    return obs, bs.std(), (bs > 0).mean()


CASES = {
    "PRICE ALONE (the null)":        lambda d: -d.z_price,
    "Cheap upside  LIFT - price":    lambda d: d.z_LIFT - d.z_price,
    "Cheap climb   climb - price":   lambda d: d.z_climb - d.z_price,
    "Cheap role    role - price":    lambda d: d.z_role_opp - d.z_price,
    "Cheap workload usage - price":  lambda d: d.z_opp_prev - d.z_price,
    "LIFT alone":                    lambda d: d.z_LIFT,
    "climb alone":                   lambda d: d.z_climb,
    "role alone":                    lambda d: d.z_role_opp,
    "usage alone":                   lambda d: d.z_opp_prev,
}
print("\n" + "=" * 82)
print("A. RAW SPREADS, bootstrapped over players")
print("=" * 82)
print(f"  {'definition':<32}{'spread':>9}{'SE':>7}{'t':>7}{'P(>0)':>8}")
raw = {}
for name, fn in CASES.items():
    d = P.copy()
    d["gap"] = fn(d)
    d = d[d["gap"].notna()]
    obs, se, p = spread(d, "gap")
    raw[name] = obs
    print(f"  {name:<32}{obs:>+9.1f}{se:>7.1f}{obs/se:>7.1f}{p:>8.3f}")

# ------------------------------------------------------------------ the real test
print("\n" + "=" * 82)
print("B. DOES THE SIGNAL ADD ANYTHING TO PRICE?")
print("   Hold price fixed: inside each price decile, rank on the signal only.")
print("=" * 82)
P["pdec"] = P.groupby("season").z_price.transform(
    lambda s: pd.qcut(s.rank(method="first"), 5, labels=False))
print(f"  {'signal':<32}{'spread':>9}{'SE':>7}{'t':>7}{'P(>0)':>8}")
for name, col in [("LIFT", "z_LIFT"), ("climb", "z_climb"),
                  ("role", "z_role_opp"), ("usage", "z_opp_prev")]:
    tops, bots = [], []
    for (s, q), g in P.groupby(["season", "pdec"]):
        g = g[g[col].notna()]
        if len(g) < 8:
            continue
        k = max(2, int(round(len(g) * 0.3)))
        tops.append(g.nlargest(k, col).resid.values)
        bots.append(g.nsmallest(k, col).resid.values)
    t, b = np.concatenate(tops), np.concatenate(bots)
    obs = t.mean() - b.mean()
    bs = np.array([rng.choice(t, len(t), True).mean() - rng.choice(b, len(b), True).mean()
                   for _ in range(2000)])
    print(f"  {name:<32}{obs:>+9.1f}{bs.std():>7.1f}{obs/bs.std():>7.1f}{(bs>0).mean():>8.3f}")

print("\n  If a signal's within-price-band spread collapses toward zero, the corner")
print("  built on it was really just 'buy the cheap ones' with extra steps.")
