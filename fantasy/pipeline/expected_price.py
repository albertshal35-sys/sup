"""Stage 27: what a player is WORTH and what he will COST are different numbers.

The board prices a quarterback at what he is worth to a team that starts two of
them. This room does not pay that. Its 2025 sheet caps quarterbacks around $42 with
a hard cliff after QB5 ($31 -> $20 -> $16), and spends the difference on running
backs. Printing only the value gives a board where QB6 reads $39 in a room that
pays $20 for him — technically the right valuation and useless as a bid guide.

So the board carries two columns:

  VALUE     surplus over replacement, scaled to the league's money. What he is worth.
  EXPECT    that value pushed toward what THIS room actually pays for the position.

The ratio comes from the 2025 sheet priced with the identical function the 2026 board
uses, so it is a like-for-like comparison rather than a comparison against a
differently-built board. Both columns sum to the money in the room; the second is
just a different allocation of it.

The gap between the two columns IS the edge. A quarterback worth $54 that goes for
$33 is the trade this whole tool exists to find — and now you can see it without
having to hold two boards in your head.
"""
import pandas as pd, numpy as np, pickle, json, warnings

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
M = pd.read_csv("out/league_2025_matched.csv")
TEAMS, ROSTER, BUDGET = 10, 17, 200
DISC = BUDGET * TEAMS - ROSTER * TEAMS
POS = ("QB", "RB", "WR", "TE")
LINEUP = dict(QB=2, RB=2, WR=3, TE=1)
FLEX_POS = ("RB", "WR", "TE")
LAMBDA = json.load(open("out/research_lambda.json"))


def replacement(b, col):
    """Identical to project2026: allocate every starting slot including the flex."""
    taken = {p: n * TEAMS for p, n in LINEUP.items()}
    pools = {p: np.sort(b[b.position == p][col].values)[::-1] for p in FLEX_POS}
    for _ in range(TEAMS):
        best, bv = None, -1e9
        for p in FLEX_POS:
            i = taken[p]
            if i < len(pools[p]) and pools[p][i] > bv:
                best, bv = p, pools[p][i]
        if best:
            taken[best] += 1
    return {p: float(np.sort(b[b.position == p][col].values)[::-1][
        min(taken[p], (b.position == p).sum() - 1)]) for p in POS}, taken


def price_2025():
    b, _ = BOARDS[2025]
    b = b[b.position.isin(POS)].copy()
    rep, _ = replacement(b, "proj_blend")
    lam = b.position.map(LAMBDA).astype(float)
    anc = b.position.map(rep).astype(float)
    b["proj"] = anc + (b.proj_blend - anc) * lam
    rep2, _ = replacement(b, "proj")
    b["sur"] = np.maximum(0.0, b.proj - b.position.map(rep2))
    b["price"] = np.where(b.sur > 0, 1 + b.sur / b.sur.sum() * DISC, 1.0)
    return b


b25 = price_2025()
board_share = {p: b25.loc[b25.position == p, "price"].sum() / b25.price.sum() * 100
               for p in POS}
paid = M[M.position.isin(POS)]
room_share = {p: paid.loc[paid.position == p, "price"].sum() / paid.price.sum() * 100
              for p in POS}

print("=" * 74)
print("WHAT THIS ROOM PAYS PER POSITION, vs the same board that prices 2026")
print("=" * 74)
print(f"  {'pos':<6}{'board says':>12}{'room pays':>11}{'on the dollar':>16}")
for p in POS:
    print(f"  {p:<6}{board_share[p]:>11.1f}%{room_share[p]:>10.1f}%"
          f"{round(room_share[p]/board_share[p]*100):>14}¢")

# ---------------------------------------------------------------- the room's curve
# A single positional multiplier is not enough: it says quarterbacks should cost 57%
# of their value, which lands QB1 correctly at $32, but it also inflates the top
# running back to $75 in a room whose most expensive back went for $60. Each position
# has its own SHAPE, not just its own level.
#
# So map the board's positional rank straight onto what this room actually paid at
# that rank, smoothed to be monotone. This is one season of one league — it is a
# forecast of a ten-person habit, not a law — but it is the only direct evidence of
# what these nine people do, and it reproduces the cliff the multiplier missed.
from sklearn.isotonic import IsotonicRegression

CURVE = {}
for p in POS:
    v = np.sort(paid.loc[paid.position == p, "price"].values)[::-1].astype(float)
    r = np.arange(1, len(v) + 1)
    iso = IsotonicRegression(increasing=False, out_of_bounds="clip").fit(r, v)
    CURVE[p] = iso
print("\n  smoothed room curve, by positional rank:")
for p in POS:
    n = int((paid.position == p).sum())
    fit = CURVE[p].predict(np.arange(1, 13))
    print(f"    {p}: " + " ".join(f"{x:>4.0f}" for x in fit) + f"   (n={n} bought)")

board = pd.read_parquet("out/board2026.parquet")
d = board[(board.auction >= 1) & board.position.isin(POS)].copy()
d["pr"] = d.groupby("position").auction.rank(ascending=False, method="first")
bought = {p: int((paid.position == p).sum()) for p in POS}
d["expected"] = [max(1.0, float(CURVE[r.position].predict([r.pr])[0]))
                 if r.pr <= bought[r.position] else 1.0 for _, r in d.iterrows()]
# Deliberately NOT renormalised to the board's total. The board covers 150 skill
# players and this room bought 139, so scaling the curve up to cover the difference
# inflates every price by ~13% and quietly undoes the point of the column. What the
# room paid is what the room paid.
d["expected"] = d.expected.round(0).clip(lower=1)

print("\n" + "=" * 74)
print("THE QB CURVE: value, expected price, and what the room paid in 2025")
print("=" * 74)
rq = sorted(M[M.position == "QB"].price.tolist(), reverse=True)
q = d[d.position == "QB"].nlargest(14, "auction")
print(f"  {'':<22}{'value':>7}{'expect':>8}{'room 2025 QBn':>15}")
for i, (_, r) in enumerate(q.iterrows()):
    rr = f"${rq[i]:.0f}" if i < len(rq) else "-"
    print(f"  {r['name'][:21]:<22}{r.auction:>7.0f}{r.expected:>8.0f}{rr:>15}")

print("\n" + "=" * 74)
print("TOP OF THE BOARD BY EXPECTED PRICE")
print("=" * 74)
for _, r in d.nlargest(12, "expected").iterrows():
    print(f"  {r['name'][:22]:<23}{r.position:<4}value ${r.auction:>3.0f}   expect ${r.expected:>3.0f}"
          f"   edge ${r.auction - r.expected:>+4.0f}")

print("\n" + "=" * 74)
print("THE BIGGEST GAPS — worth more than this room will charge")
print("=" * 74)
d["edge"] = d.auction - d.expected
for _, r in d.nlargest(12, "edge").iterrows():
    print(f"  {r['name'][:22]:<23}{r.position:<4}value ${r.auction:>3.0f}   expect ${r.expected:>3.0f}"
          f"   edge ${r.edge:>+4.0f}")
print("\n  ...and the ones this room will make you overpay for:")
for _, r in d.nsmallest(8, "edge").iterrows():
    print(f"  {r['name'][:22]:<23}{r.position:<4}value ${r.auction:>3.0f}   expect ${r.expected:>3.0f}"
          f"   edge ${r.edge:>+4.0f}")

out = d[["player_id", "expected"]].copy()
out.to_parquet("out/expected_price.parquet")
json.dump(dict(ratio={p: round(room_share[p]/board_share[p], 3) for p in POS},
               curve={p: [round(float(x), 1) for x in CURVE[p].predict(np.arange(1, 25))] for p in POS},
               bought=bought,
               board_share={p: round(board_share[p], 1) for p in POS},
               room_share={p: round(room_share[p], 1) for p in POS}),
          open("out/research_expected.json", "w"), indent=1)
print(f"\nexpected total ${d.expected.sum():.0f} vs value total ${d.auction.sum():.0f}")
print("wrote out/expected_price.parquet, out/research_expected.json")
