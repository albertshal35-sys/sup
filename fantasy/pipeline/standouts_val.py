"""Stage 21b: do the corners of the chart actually beat the board?

The matrix said LIFT and depth-chart climb are the two signals least contaminated
by price. That is a claim about correlation across all players. Shipping a corner
list is a stronger claim: that the eight most extreme players in a corner beat the
board's own projection.

Test it the only honest way — on the seasons where the signal existed, using the
board built from prior data, scoring on the residual (what the player actually did
minus what the board said he would do). A corner is worth shipping only if the
top group beats the bottom group by more than the noise.
"""
import pandas as pd, numpy as np, warnings

warnings.filterwarnings("ignore")
D = pd.read_parquet("out/corr_panel.parquet")
POS = ("QB", "RB", "WR", "TE")

# the priced pool: a 10-team league buys ~140 skill players. Rank within season by
# the board's own value and keep that many, because a corner list is only useful
# among players somebody would actually bid on.
D = D[D.position.isin(POS) & D.resid.notna() & D.vorp_proj.notna()].copy()
D["rk"] = D.groupby("season").vorp_proj.rank(ascending=False, method="first")
P = D[D.rk <= 140].copy()
print(f"priced pool: {len(P)} player-seasons, "
      f"{int(P.season.min())}-{int(P.season.max())}")


def z(df, col):
    return df.groupby(["season", "position"])[col].transform(
        lambda s: (s - s.mean()) / s.std(ddof=0) if s.std(ddof=0) > 0 else s * 0)


P["z_price"] = z(P, "vorp_proj")
for c in ("LIFT", "climb", "role_opp", "opp_prev"):
    P["z_" + c] = z(P, c)

GAPS = {
    "Cheap upside (LIFT - price)":   ("z_LIFT", "z_price"),
    "Cheap climb (climb - price)":   ("z_climb", "z_price"),
    "Cheap role (role - price)":     ("z_role_opp", "z_price"),
    "Cheap workload (usage - price)": ("z_opp_prev", "z_price"),
    "LIFT alone":                    ("z_LIFT", None),
    "climb alone":                   ("z_climb", None),
}

print("\n" + "=" * 78)
print("CORNER TEST — mean residual (actual minus board projection), top 15% vs bottom 15%")
print("=" * 78)
print(f"  {'definition':<32}{'top':>9}{'bottom':>9}{'spread':>9}{'SE':>7}{'n/yr':>7}")
results = {}
for name, (a, b) in GAPS.items():
    d = P.copy()
    d["gap"] = d[a] - (d[b] if b else 0)
    d = d[d["gap"].notna()]
    if not len(d):
        continue
    tops, bots, per = [], [], []
    for s, g in d.groupby("season"):
        k = max(6, int(round(len(g) * 0.15)))
        tops.append(g.nlargest(k, "gap").resid.mean())
        bots.append(g.nsmallest(k, "gap").resid.mean())
        per.append(k)
    tops, bots = np.array(tops), np.array(bots)
    diff = tops - bots
    se = diff.std(ddof=1) / np.sqrt(len(diff)) if len(diff) > 1 else np.nan
    results[name] = (diff.mean(), se, len(diff))
    print(f"  {name:<32}{tops.mean():>+9.1f}{bots.mean():>+9.1f}"
          f"{diff.mean():>+9.1f}{se:>7.1f}{np.mean(per):>7.0f}")

print("\n  seasons in the test:", sorted(d.season.unique().astype(int)))
print("\n  A spread needs to clear roughly 2x its SE to be worth a line in the app.")
print("  Anything that does not is a pattern in four seasons of noise.")

# does the corner survive if you also demand the player be affordable?
print("\n" + "=" * 78)
print("SAME TEST, CHEAP HALF ONLY (below-median board value within position)")
print("=" * 78)
P["cheap"] = P.z_price < 0
for name, (a, b) in GAPS.items():
    d = P[P.cheap].copy()
    d["gap"] = d[a] - (d[b] if b else 0)
    d = d[d["gap"].notna()]
    if not len(d):
        continue
    diffs = []
    for s, g in d.groupby("season"):
        k = max(5, int(round(len(g) * 0.2)))
        diffs.append(g.nlargest(k, "gap").resid.mean() - g.nsmallest(k, "gap").resid.mean())
    diffs = np.array(diffs)
    se = diffs.std(ddof=1) / np.sqrt(len(diffs)) if len(diffs) > 1 else np.nan
    print(f"  {name:<32}{diffs.mean():>+9.1f}{se:>7.1f}")
