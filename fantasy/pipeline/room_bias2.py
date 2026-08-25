"""Compare the room's 2025 spending with what the board would have said in 2025,
so the gap is not an artefact of comparing against a different season's target."""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings("ignore")
import sim_env
sim_env.load(globals())          # BOARDS (leak-free 2025 projections), TEAMS=10

BUDGET, SPOTS = 200, 15
b, rep = BOARDS[2025]
b = b.reset_index(drop=True).copy()
# Apply the same spread correction the 2026 board uses, so this comparison is
# against the board that actually ships rather than an uncorrected one.
_lam = json.load(open("out/research_lambda.json"))
_anc = b.position.map(rep).astype(float)
b["proj_blend"] = _anc + (b.proj_blend - _anc) * b.position.map(_lam).astype(float)
b["vorp"] = b.proj_blend - b.position.map(rep)

cap = dict(QB=3 * TEAMS, RB=5 * TEAMS, WR=6 * TEAMS, TE=2 * TEAMS)
order = b.sort_values("vorp", ascending=False)
keep, counts = [], {p: 0 for p in cap}
for i, r in order.iterrows():
    if len(keep) >= TEAMS * SPOTS:
        break
    if counts[r.position] >= cap[r.position]:
        continue
    keep.append(i); counts[r.position] += 1
# Surplus over REPLACEMENT (the last man who starts), not over the last man kept.
# The latter leaves everyone rostered holding a big surplus and flattens the curve,
# which is the pricing bug corrected in project2026.py.
b["surplus"] = np.maximum(0.0, b.vorp)
tot = b.loc[keep, "surplus"].sum()
b["price"] = 1.0 + b.surplus / tot * (TEAMS * BUDGET - TEAMS * SPOTS)
b.loc[~b.index.isin(keep), "price"] = 1.0

fair_tot = b.loc[keep, "price"].sum()
fair = {p: b.loc[keep][b.loc[keep].position == p].price.sum() / fair_tot * 100 for p in cap}

hit = pd.read_csv("out/league_2025_matched.csv")
paid_tot = hit.price.sum()
print("=" * 74)
print("THE ROOM VS FAIR VALUE, BOTH MEASURED IN 2025")
print("=" * 74)
print(f"  {'pos':<6}{'room paid':>11}{'room %':>9}{'fair %':>9}{'gap':>8}{'ratio':>8}")
out = {}
for p in ("QB", "RB", "WR", "TE"):
    paid = hit[hit.position == p].price.sum()
    rs, fs = paid / paid_tot * 100, fair[p]
    ratio = rs / fs
    out[p] = dict(room_pct=round(rs, 1), fair_pct=round(fs, 1),
                  gap=round(rs - fs, 1), ratio=round(ratio, 3))
    print(f"  {p:<6}{paid:>11.0f}{rs:>8.1f}%{fs:>8.1f}%{rs-fs:>+8.1f}{ratio:>8.2f}")

# where the overpay sits: top of the board or the middle?
mm = hit.merge(b[["player_id", "price"]], on="player_id", how="left", suffixes=("", "_fair"))
mm = mm[mm.price_fair.notna()]
mm["over"] = mm.price - mm.price_fair
print("\n  biggest overpays vs the 2025 board:")
for _, r in mm.nlargest(8, "over").iterrows():
    print(f"    {r.player_display_name:24s} {r.position}  paid ${r.price:>3.0f}  worth ${r.price_fair:>4.1f}  (+${r.over:.0f})")
print("\n  biggest bargains:")
for _, r in mm.nsmallest(8, "over").iterrows():
    print(f"    {r.player_display_name:24s} {r.position}  paid ${r.price:>3.0f}  worth ${r.price_fair:>4.1f}  ({r.over:+.0f})")

tier = mm.copy()
tier["band"] = pd.cut(tier.price_fair, [0, 5, 15, 30, 100], labels=["$1-5", "$6-15", "$16-30", "$31+"])
print("\n  by price band — what the room pays on the dollar:")
for band, d in tier.groupby("band", observed=True):
    if len(d) < 3:
        continue
    print(f"    {str(band):<8} n={len(d):<4} paid ${d.price.sum():>4.0f} vs worth ${d.price_fair.sum():>5.0f}"
          f"  -> {d.price.sum()/d.price_fair.sum()*100:.0f}¢ on the dollar")
json.dump(out, open("out/room_bias.json", "w"), indent=1)
print("\nwrote out/room_bias.json")
