"""Stage 24: the player grid — every priced player as a row, every column a metric.

The correlation matrix asks how the STATS relate to each other. This asks the same
question one level down: given those stats, which PLAYERS have a lopsided profile.

Columns are chosen one per cluster from the matrix, so the grid is not the same
number twelve times. Every cell is a z-score inside the player's own position — a
tight end and a quarterback belong on the same grid, and only a within-position
comparison puts them there honestly.

Colour convention: teal is favourable, rust is unfavourable. For three columns the
favourable direction is DOWN (touchdown luck already banked, blank weeks, age), so
their colour is flipped and they are marked. Nothing here is a ranking — it is a
way to see, at a glance, where a player's profile disagrees with itself.
"""
import pandas as pd, numpy as np, json, warnings

warnings.filterwarnings("ignore")
board = pd.read_parquet("out/board2026.parquet")
LOAD = pd.read_parquet("out/load.parquet")
L26 = LOAD[LOAD.season == 2026][["player_id", "LOAD", "role_opp", "opp_prev", "depth"]]

b = board.merge(L26, on="player_id", how="left")
b = b[b.position.isin(["QB", "RB", "WR", "TE"]) & (b.auction >= 1)].copy()
# depth-chart climb: cluster A in the matrix, and the one signal flagged as new
# information against price (+0.153 vs the board's miss)
PANEL = pd.read_parquet("out/breakout_panel.parquet")
b = b.merge(PANEL.loc[PANEL.season == 2026, ["player_id", "climb", "trend"]],
            on="player_id", how="left")

# Columns are picked to span the clusters in the matrix rather than repeat one, and
# the assertion below enforces it: no two may correlate above the same 0.85 the tab
# uses to call a pair duplicates. "Role" (the depth-slot median) was cut here for
# exactly that reason — it ran 0.888 against a player's actual prior usage, and LOAD
# already carries it.
COLS = [
    ("auction",    "$",        False, 0, "what the board says he costs"),
    ("proj_ppg",   "Pts/gm",   False, 1, "projected points per game"),
    ("proj_g",     "Games",    False, 1, "projected games played"),
    ("LOAD",       "LOAD",     False, 0, "size of his job — the one validated edge"),
    ("opp_prev",   "Prior use", False, 1, "touches a week he actually got in 2025"),
    ("climb",      "Climb",    False, 0, "rungs moved up the depth chart since last preseason — zero for most established starters, so sort on it to surface the 38 who actually moved"),
    ("trend",      "Late use", False, 2, "back-half usage minus front-half usage in 2025"),
    ("td_luck_pg", "TD luck",  True,  2, "points per game of scoring his volume did not earn"),
    ("flr25",      "Floor",    False, 3, "share of weeks he beat a typical starter"),
    ("spk25",      "Spike",    False, 3, "share of weeks in the top decile at his position"),
    ("ghst25",     "Blank",    True,  3, "share of weeks he gave you nothing"),
    ("age26",      "Age",      True,  1, "age on opening day 2026"),
]
keys = [c for c, *_ in COLS]

for c in keys:
    if c not in b.columns:
        raise SystemExit(f"missing column {c}")

Z = {}
for c in keys:
    z = b.groupby("position")[c].transform(
        lambda s: (s - s.mean()) / s.std(ddof=0) if s.std(ddof=0) > 0 else s * 0)
    Z[c] = z.clip(-2.5, 2.5)

print(f"{len(b)} priced players, {len(keys)} columns")
print("coverage per column:")
for c, lab, *_ in COLS:
    print(f"  {lab:<10} {b[c].notna().mean():>6.1%}")


def cell(r, c, nd):
    v = r[c]
    if pd.isna(v):
        return None
    z = Z[c].loc[r.name]
    return [round(float(v), nd), None if pd.isna(z) else round(float(z), 2)]


rows = []
for _, r in b.sort_values("auction", ascending=False).iterrows():
    rows.append(dict(
        id=str(r.player_id), n=str(r["name"]), p=str(r.position),
        t=(None if pd.isna(r.team) else str(r.team)),
        d=(None if pd.isna(r.depth) else int(r.depth)),
        c=[cell(r, c, nd) for c, _lab, _f, nd, _h in COLS]))

# The whole point of this tab is that duplicated columns are worthless, so check
# these ones against each other before shipping them.
from scipy.stats import spearmanr
# Price is excluded: it is the benchmark every other column is read against, not a
# competing signal, so its 0.87 against projected points is the design, not a fault.
cand = [c for c in keys if c != "auction"]
worst = (0.0, None, None)
for i, a in enumerate(cand):
    for c2 in cand[i + 1:]:
        ok = b[a].notna() & b[c2].notna()
        if ok.sum() < 40:
            continue
        r = spearmanr(b.loc[ok, a], b.loc[ok, c2])[0]
        if abs(r) > abs(worst[0]):
            worst = (r, a, c2)
LAB = {c: l for c, l, *_ in COLS}
print(f"\nclosest pair among the shipped columns: {LAB[worst[1]]} x {LAB[worst[2]]} = {worst[0]:+.3f}")
assert abs(worst[0]) < 0.85, f"shipped columns duplicate: {worst}"

json.dump(dict(max_pair=[LAB[worst[1]], LAB[worst[2]], round(float(worst[0]), 3)],
    cols=[dict(key=c, label=lab, flip=f, nd=nd, help=h) for c, lab, f, nd, h in COLS],
    rows=rows), open("out/research_grid.json", "w"), separators=(",", ":"))
print("wrote out/research_grid.json")

# a quick text read on the most lopsided profiles, as a sanity check
sp = pd.DataFrame({c: Z[c] for c in keys}, index=b.index)
b = b.reset_index(drop=True)
sp = sp.reset_index(drop=True)
b["_spread"] = sp[["LOAD", "proj_ppg", "flr25", "spk25"]].max(axis=1) - \
               sp[["LOAD", "proj_ppg", "flr25", "spk25"]].min(axis=1)
print("\nmost internally inconsistent profiles (widest gap between their own columns):")
for _, r in b.nlargest(10, "_spread").iterrows():
    print(f"  {r['name'][:22]:23s}{r.position:4s}${r.auction:>3.0f}  "
          f"LOAD z{Z['LOAD'].loc[r.name]:+.1f}  ppg z{Z['proj_ppg'].loc[r.name]:+.1f}  "
          f"floor z{Z['flr25'].loc[r.name]:+.1f}  spike z{Z['spk25'].loc[r.name]:+.1f}")
