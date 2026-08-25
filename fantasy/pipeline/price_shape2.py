"""Stage 25b: separating "wrong shape" from "we disagree about McCaffrey".

The first pass fit gamma to per-player prices and barely beat the linear map. That
objective was wrong. Per-player error mixes two things:

  1. the SHAPE of the price curve — how concentrated the money is
  2. genuine disagreement about individual players

Only (1) is a bug in the pricing function. The board is allowed to think the room
overpaid for McCaffrey; that is the entire point of having a board. So fit the
SORTED price vectors against each other, which compares curve to curve and is blind
to which player sits at which rank.

Two knobs, both structural:

  CUT     where replacement is drawn. The board currently uses the last man BOUGHT
          (~rank 150 of the skill pool), which leaves almost everyone with a large
          surplus and flattens the curve. The alternative is the last man STARTED,
          which is where a player stops being irreplaceable.
  GAMMA   the exponent on surplus.
"""
import pandas as pd, numpy as np, pickle, json, warnings

warnings.filterwarnings("ignore")
board = pd.read_parquet("out/board2026.parquet")
L = pd.read_csv("out/league_2025.csv")
TEAMS, ROSTER, BUDGET = 10, 17, 200
DISC = BUDGET * TEAMS - ROSTER * TEAMS
STARTERS = dict(QB=2, RB=2, WR=3, TE=1, DST=1, K=1)   # plus 1 FLEX among RB/WR/TE

real = np.sort(L.price.values)[::-1].astype(float)
print(f"room 2025: {len(real)} buys, ${real.sum():.0f}, "
      f"max ${real.max():.0f}, {(real <= 1).sum()} at $1")

b = board.copy()
skill = b[b.position.isin(["QB", "RB", "WR", "TE"])]
b["rk"] = b.groupby("position").proj_total.rank(ascending=False, method="first")


def cut_line(kind):
    """Points at which a player stops being worth real money."""
    cut = {}
    for pos, n_start in STARTERS.items():
        d = b[b.position == pos].sort_values("proj_total", ascending=False)
        if kind == "starter":
            # last man who actually starts somewhere, flex allocated to RB/WR/TE
            n = n_start * TEAMS
            if pos in ("RB", "WR", "TE"):
                n += {"RB": 4, "WR": 4, "TE": 2}[pos]      # the flex, split by usage
        else:
            n = {"QB": 45, "RB": 55, "WR": 65, "TE": 25, "K": TEAMS, "DST": TEAMS}[pos] \
                if kind == "bought" else n_start * TEAMS
        n = min(int(n), len(d))
        cut[pos] = float(d.proj_total.iloc[n - 1]) if n else 0.0
    return cut


def price(kind, gamma, budget=DISC):
    cut = cut_line(kind)
    s = np.maximum(0.0, b.proj_total - b.position.map(cut)).values ** gamma
    # only players with surplus compete for the discretionary money; the rest are $1
    tot = s.sum()
    p = np.where(s > 0, 1 + s / tot * budget, 1.0)
    # a 10-team, 17-round auction buys exactly 170 players; everyone else is off-board
    order = np.argsort(-p)
    keep = np.zeros(len(p), bool)
    keep[order[:ROSTER * TEAMS]] = True
    return np.sort(p[keep])[::-1]


def shape_err(v):
    """Compare curve to curve on the ranks both have."""
    n = min(len(v), len(real))
    return np.abs(v[:n] - real[:n]).mean()


print("\n" + "=" * 74)
print("SHAPE ERROR — sorted board curve vs sorted room curve, $/rank")
print("=" * 74)
print(f"  {'replacement at':<18}{'gamma':>7}{'mean $/rank':>14}{'top-10 sh':>11}{'at $1':>7}")
best = None
for kind in ("bought", "starter"):
    for g in (1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.4):
        v = price(kind, g)
        e = shape_err(v)
        if best is None or e < best[0]:
            best = (e, kind, g)
        print(f"  {kind:<18}{g:>7.1f}{e:>14.2f}{v[:10].sum() / v.sum():>11.1%}"
              f"{int((v <= 1).sum()):>7}")
print(f"\n  room, for reference:{'':>16}{'':>14}{real[:10].sum() / real.sum():>11.1%}"
      f"{int((real <= 1).sum()):>7}")
print(f"\n  best: replacement at last {best[1]}, gamma {best[2]}, "
      f"${best[0]:.2f} per rank off")

# finer sweep around the winner
print("\n" + "=" * 74)
print("FINE SWEEP around the winner")
print("=" * 74)
fine = None
for g in np.arange(1.0, 2.61, 0.05):
    e = shape_err(price(best[1], g))
    if fine is None or e < fine[0]:
        fine = (e, g)
print(f"  gamma {fine[1]:.2f}: ${fine[0]:.2f} per rank")

v = price(best[1], fine[1])
lin = price("bought", 1.0)
print("\n" + "=" * 74)
print("THE CURVE, rank by rank")
print("=" * 74)
print(f"  {'rank':>5}{'room':>8}{'current':>10}{'fixed':>8}")
for i in (0, 1, 2, 4, 9, 19, 29, 49, 79, 109, 139, 168):
    r = real[i] if i < len(real) else float("nan")
    c = lin[i] if i < len(lin) else float("nan")
    f = v[i] if i < len(v) else float("nan")
    print(f"  {i+1:>5}{r:>8.0f}{c:>10.0f}{f:>8.0f}")
print(f"\n  totals: room ${real.sum():.0f}  current ${lin.sum():.0f}  fixed ${v.sum():.0f}")
print(f"  at $1:  room {(real<=1).sum()}  current {(lin<=1).sum()}  fixed {(v<=1).sum()}")

json.dump(dict(kind=best[1], gamma=round(float(fine[1]), 2),
               err=round(float(fine[0]), 2),
               err_current=round(float(shape_err(lin)), 2),
               room_top10=round(float(real[:10].sum() / real.sum()), 3),
               fixed_top10=round(float(v[:10].sum() / v.sum()), 3),
               cur_top10=round(float(lin[:10].sum() / lin.sum()), 3),
               room_at1=int((real <= 1).sum()), fixed_at1=int((v <= 1).sum()),
               cur_at1=int((lin <= 1).sum())),
          open("out/research_priceshape.json", "w"), indent=1)
print("\nwrote out/research_priceshape.json")
