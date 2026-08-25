"""Stage 21d: taking LIFT apart.

LIFT = role_opp - opp_prev  (the job you are walking into, minus the job you had).

The control in stage 21c says something uncomfortable. Holding price fixed:

    role  alone   +31.1  (t 4.0)
    usage alone   +17.7  (t 2.1)
    LIFT = role - usage   +5.3  (t 0.7)

If both halves point the same way, subtracting one from the other cancels the
signal rather than sharpening it. That would make LIFT a construction error, not a
discovery — and it would mean the raw edge measured for LIFT earlier was mostly
the fact that high-LIFT players are cheap.

This tests it three ways: the sum instead of the difference, a regression that lets
the data pick the weights, and a correlation over the whole pool rather than the
tails (more power than a top-vs-bottom split on 559 rows).
"""
import pandas as pd, numpy as np, warnings
from scipy.stats import spearmanr

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


for c in ("vorp_proj", "LIFT", "role_opp", "opp_prev", "climb"):
    P["z_" + c] = z(P, c)
P = P[P.z_LIFT.notna() & P.z_role_opp.notna() & P.z_opp_prev.notna()].copy()
print(f"sample: {len(P)} player-seasons {sorted(P.season.unique().astype(int))}")

# residual of the residual: strip price out of everything, then correlate.
# regressing resid on price and taking what is left is the cleanest way to ask
# "what does this stat know that the price does not".
def strip(col):
    x = P.z_vorp_proj.values
    y = P[col].values
    b = np.polyfit(x, y, 1)
    return y - np.polyval(b, x)


P["r_resid"] = strip("resid")
CAND = {
    "role_opp  (the job ahead)": "z_role_opp",
    "opp_prev  (the job he had)": "z_opp_prev",
    "LIFT = role - usage": "z_LIFT",
    "role + usage": None,
    "climb": "z_climb",
}
print("\n" + "=" * 74)
print("A. AFTER REMOVING PRICE FROM BOTH SIDES — Spearman vs what the board missed")
print("=" * 74)
print(f"  {'stat':<30}{'rho':>8}{'SE':>7}{'t':>7}")
for name, col in CAND.items():
    v = (P.z_role_opp + P.z_opp_prev).values if col is None else P[col].values
    v = v - np.polyval(np.polyfit(P.z_vorp_proj.values, v, 1), P.z_vorp_proj.values)
    ok = np.isfinite(v) & np.isfinite(P.r_resid.values)
    rho = spearmanr(v[ok], P.r_resid.values[ok])[0]
    bs = np.array([spearmanr(*(lambda i: (v[ok][i], P.r_resid.values[ok][i]))(
        rng.integers(0, ok.sum(), ok.sum())))[0] for _ in range(600)])
    print(f"  {name:<30}{rho:>+8.3f}{bs.std():>7.3f}{rho/bs.std():>7.1f}")

# ------------------------------------------------------------------ let data weight
print("\n" + "=" * 74)
print("B. LET THE DATA CHOOSE THE WEIGHTS")
print("   resid ~ price + role + usage   (all standardised within season+position)")
print("=" * 74)
X = np.column_stack([np.ones(len(P)), P.z_vorp_proj, P.z_role_opp, P.z_opp_prev])
y = P.resid.values
beta, *_ = np.linalg.lstsq(X, y, rcond=None)
resid_fit = y - X @ beta
se = np.sqrt(np.diag(np.linalg.pinv(X.T @ X) * (resid_fit @ resid_fit) / (len(y) - X.shape[1])))
for nm, b_, s_ in zip(["intercept", "price", "role_opp", "opp_prev"], beta, se):
    print(f"  {nm:<14}{b_:>+9.2f}  +/- {s_:>5.2f}   t = {b_/s_:>+5.1f}")
print(f"\n  LIFT forces the role/usage weights to be (+1, -1).")
print(f"  The data wants ({beta[2]:+.2f}, {beta[3]:+.2f}) "
      f"-- {'same sign, so the minus sign in LIFT is wrong' if beta[2]*beta[3] > 0 else 'opposite signs, LIFT is built right'}.")

# ------------------------------------------------------------------ honest ranking
print("\n" + "=" * 74)
print("C. WHAT ACTUALLY BEATS THE BOARD, top 15% vs bottom 15%, price held fixed")
print("=" * 74)
P["pdec"] = P.groupby("season").z_vorp_proj.transform(
    lambda s: pd.qcut(s.rank(method="first"), 5, labels=False))
P["sum_ru"] = P.z_role_opp + P.z_opp_prev
for name, col in [("role_opp", "z_role_opp"), ("opp_prev", "z_opp_prev"),
                  ("LIFT", "z_LIFT"), ("role + usage", "sum_ru"), ("climb", "z_climb")]:
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
                   for _ in range(3000)])
    print(f"  {name:<30}{obs:>+9.1f}{bs.std():>7.1f}{obs/bs.std():>7.1f}")
