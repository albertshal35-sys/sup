"""Stage 26b: undo the model's shrinkage before pricing.

A gradient-boosted model predicts a conditional mean. For one player that is the
right target. For a market it is the wrong one: conditional means are shrunk toward
the population mean, so the predicted DISTRIBUTION is narrower than the real one.
Measured over twelve seasons, projected QB1-minus-QB12 is 96 points where the
realised gap is 121. The consequence at an auction is a curve with no cliff — the
board priced QB6 at $39 in a room whose QB6 goes for $20.

The fix is a per-position variance rescale, fitted leave-one-season-out:

    scaled = anchor + (proj - anchor) * lambda_pos

where the anchor is the position's replacement-rank projection, so the bottom of the
pool stays put and the top stretches. lambda is the ratio of realised spread to
projected spread among players who carry a price.

This is deliberately calibrated to REALITY, not to the room's prices. Matching the
room's quarterback prices would erase the very gap the tool exists to find; matching
what quarterbacks actually score is a defect fix.
"""
import pandas as pd, numpy as np, pickle, json, warnings

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
TEAMS = 10
POS = ("QB", "RB", "WR", "TE")
START = dict(QB=2 * TEAMS, RB=2 * TEAMS + 4, WR=3 * TEAMS + 4, TE=1 * TEAMS + 2)
# how deep the priced pool runs at each position in a 10-team, 17-round auction
DEPTH = dict(QB=24, RB=40, WR=50, TE=16)


def curves(season):
    """Projected and realised points by positional rank for one season."""
    b, _ = BOARDS[season]
    act = sp[(sp.season == season) & sp.position.isin(POS)]
    out = {}
    for p in POS:
        pj = np.sort(b[b.position == p].proj_blend.values)[::-1][:DEPTH[p]]
        ac = np.sort(act[act.position == p].fpts.values)[::-1][:DEPTH[p]]
        n = min(len(pj), len(ac))
        out[p] = (pj[:n], ac[:n])
    return out


def fit_lambda(exclude=None):
    """Ratio of realised to projected spread, per position, around the anchor."""
    num, den = {p: [] for p in POS}, {p: [] for p in POS}
    for s in BOARDS:
        if s == exclude:
            continue
        c = curves(s)
        for p in POS:
            pj, ac = c[p]
            k = min(START[p], len(pj)) - 1
            num[p].append(np.abs(ac - ac[k]).mean())
            den[p].append(np.abs(pj - pj[k]).mean())
    return {p: float(np.sum(num[p]) / np.sum(den[p])) for p in POS}


LAM = fit_lambda()
print("spread correction by position (realised spread / projected spread):")
for p in POS:
    print(f"  {p}: x{LAM[p]:.3f}")

print("\n" + "=" * 78)
print("A. DOES IT MATCH REALITY BETTER?  mean abs error, points by rank,")
print("   leave-one-season-out so a season never calibrates itself")
print("=" * 78)
print(f"  {'pos':<5}{'raw model':>12}{'rescaled':>11}{'better by':>12}")
tot_r, tot_s = 0.0, 0.0
for p in POS:
    er, es = [], []
    for s in BOARDS:
        lam = fit_lambda(exclude=s)[p]
        pj, ac = curves(s)[p]
        k = min(START[p], len(pj)) - 1
        sc = pj[k] + (pj - pj[k]) * lam
        er.append(np.abs(pj - ac).mean())
        es.append(np.abs(sc - ac).mean())
    tot_r += np.mean(er); tot_s += np.mean(es)
    print(f"  {p:<5}{np.mean(er):>12.1f}{np.mean(es):>11.1f}{np.mean(er)-np.mean(es):>+12.1f}")
print(f"  {'ALL':<5}{tot_r/4:>12.1f}{tot_s/4:>11.1f}{(tot_r-tot_s)/4:>+12.1f}")

print("\n" + "=" * 78)
print("B. THE QB CURVE AFTER RESCALING")
print("=" * 78)
acc_p, acc_s, acc_a = [], [], []
for s in BOARDS:
    pj, ac = curves(s)["QB"]
    k = min(START["QB"], len(pj)) - 1
    sc = pj[k] + (pj - pj[k]) * LAM["QB"]
    idx = [i - 1 for i in (1, 3, 5, 8, 12, 20) if i <= len(pj)]
    acc_p.append(pj[idx]); acc_s.append(sc[idx]); acc_a.append(ac[idx])
print(f"  {'':>12}{'QB1':>7}{'QB3':>7}{'QB5':>7}{'QB8':>7}{'QB12':>7}{'QB20':>7}{'1-12':>8}")
for lab, arr in (("raw model", acc_p), ("rescaled", acc_s), ("realised", acc_a)):
    m = np.mean(arr, axis=0)
    print(f"  {lab:>12}" + "".join(f"{x:>7.0f}" for x in m) + f"{m[0]-m[4]:>8.0f}")

json.dump({p: round(LAM[p], 3) for p in POS}, open("out/research_lambda.json", "w"), indent=1)
print("\nwrote out/research_lambda.json")
