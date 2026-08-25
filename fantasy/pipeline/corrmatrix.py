"""Stage 20: the correlation matrix — what is redundant, and what is genuinely new.

Every stat added over this project was tested on its own. That is not the same as
testing whether it adds anything the others do not already say. A metric that
correlates 0.95 with points per game is not a metric, it is points per game
wearing a hat.

Two questions this answers:

  1. WHICH STATS ARE THE SAME STAT. Cluster the matrix and the duplicates fall
     into blocks. Anything inside a block can be dropped without losing anything.

  2. WHICH STATS ARE INDEPENDENT OF PRICE. This is the one that matters at an
     auction. A stat correlated with what a player costs is already in the price;
     you are paying for it. Only the ones near zero against price can move a bid.
"""
import pandas as pd, numpy as np, json, pickle, warnings
from scipy.stats import spearmanr
from scipy.cluster.hierarchy import linkage, leaves_list
from scipy.spatial.distance import squareform

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
W = pd.read_parquet("out/win_metrics.parquet")
LIFT = pd.read_parquet("out/load.parquet")
PANEL = pd.read_parquet("out/breakout_panel.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
POS = ("QB", "RB", "WR", "TE")

# ---------------------------------------------------------------- assemble
base = sp[sp.position.isin(POS)].copy()
base = base.merge(W.drop(columns=["position"]), on=["player_id", "season"], how="left")
# LIFT and the situational panel are indexed by the season they PREDICT, while a
# row here is the season a player played. Shift them back one so each row carries
# the signals that were known going into its following season — the same season
# `y_fpts` and `resid` describe.
_lift = LIFT[["player_id", "season", "LOAD", "lift_raw", "role_opp", "opp_prev"]].copy()
_lift["season"] -= 1
base = base.merge(_lift, on=["player_id", "season"], how="left")
_pan = PANEL[["player_id", "season", "vac_tgt_share", "vac_car_share", "climb",
              "depth", "new_team", "coach_change", "trend", "sos", "sos_playoff"]].copy()
_pan["season"] -= 1
base = base.merge(_pan, on=["player_id", "season"], how="left")

# next season's outcome, and the board's own view going in
nxt = sp[["player_id", "season", "fpts"]].copy()
nxt["season"] -= 1
nxt.columns = ["player_id", "season", "y_fpts"]
base = base.merge(nxt, on=["player_id", "season"], how="left")
proj = []
for s, (b, rep) in BOARDS.items():
    d = b[["player_id", "proj_blend"]].copy()
    d["season"] = s
    d["vorp_proj"] = b.proj_blend - b.position.map(rep)
    proj.append(d)
proj = pd.concat(proj, ignore_index=True)
# the board for season S is built from season S-1, so it lines up with row S-1
proj["season"] -= 1
base = base.merge(proj, on=["player_id", "season"], how="left")
base["resid"] = base.y_fpts - base.proj_blend

METRICS = [
    # production
    ("ppg", "Points/gm"), ("fpts", "Season points"), ("xfp_pg", "Expected pts/gm"),
    ("td_pg", "TDs/gm"), ("td_luck_pg", "TD luck"),
    # volume
    ("tgt_pg", "Targets/gm"), ("car_pg", "Carries/gm"), ("touch_pg", "Touches/gm"),
    ("target_share", "Target share"), ("air_yards_share", "Air-yard share"), ("wopr", "WOPR"),
    # efficiency
    ("ypc", "Yards/carry"), ("ypt", "Yards/target"), ("catch_rate", "Catch rate"),
    ("adot", "Depth of target"), ("td_rate", "TD rate"), ("epa_rec", "Receiving EPA"),
    ("expl_pg", "Explosives/gm"), ("fd_pg", "First downs/gm"), ("yac_pg", "YAC/gm"),
    # availability and shape of week
    ("games", "Games played"), ("ghst", "Blank weeks"), ("flr", "Floor rate"),
    ("spk", "Spike rate"), ("wk_sd", "Weekly spread"), ("waa", "WAA"),
    # role and situation
    ("LOAD", "LOAD"), ("lift_raw", "LIFT (retracted)"), ("role_opp", "Role (touches)"), ("depth", "Depth chart rank"),
    ("climb", "Depth chart climb"), ("vac_tgt_share", "Vacated targets"),
    ("trend", "Late-season usage"), ("sos", "Schedule"),
    # age
    ("age", "Age"), ("exp", "Experience"),
    # what it is all for
    ("proj_blend", "Board projection"), ("vorp_proj", "Board VORP"),
    ("y_fpts", "NEXT season points"), ("resid", "What the board MISSED"),
]
cols = [c for c, _ in METRICS if c in base.columns]
LABEL = {c: l for c, l in METRICS}

D = base[base.games >= 4].copy()
print(f"rows: {len(D)}  seasons {int(D.season.min())}-{int(D.season.max())}")
print(f"rows with a next season and a board projection: {int(D.resid.notna().sum())}")

# ---------------------------------------------------------------- the matrix
M = np.full((len(cols), len(cols)), np.nan)
N = np.zeros((len(cols), len(cols)), dtype=int)
for i, a in enumerate(cols):
    for j, b in enumerate(cols):
        ok = D[a].notna() & D[b].notna() & np.isfinite(D[a]) & np.isfinite(D[b])
        if ok.sum() < 80:
            continue
        M[i, j] = spearmanr(D.loc[ok, a], D.loc[ok, b])[0]
        N[i, j] = int(ok.sum())
M = np.nan_to_num(M, nan=0.0)

# cluster so that stats saying the same thing sit next to each other
dist = 1 - np.abs(M)
np.fill_diagonal(dist, 0.0)
dist = (dist + dist.T) / 2
order = leaves_list(linkage(squareform(dist, checks=False), method="average"))
cols_o = [cols[i] for i in order]
M_o = M[np.ix_(order, order)]

print("\n" + "=" * 76)
print("Z1. WHICH STATS ARE THE SAME STAT  (|rho| >= 0.85)")
print("=" * 76)
dupes = []
for i in range(len(cols)):
    for j in range(i + 1, len(cols)):
        if abs(M[i, j]) >= 0.85:
            dupes.append((LABEL[cols[i]], LABEL[cols[j]], round(float(M[i, j]), 3)))
for a, b, r in sorted(dupes, key=lambda t: -abs(t[2])):
    print(f"  {a:<22} {b:<22} {r:+.3f}")
if not dupes:
    print("  none")

print("\n" + "=" * 76)
print("Z2. WHAT IS INDEPENDENT OF PRICE  —  the only stats that can move a bid")
print("=" * 76)
pi = cols.index("vorp_proj")
ri = cols.index("resid")
rows = []
for i, c in enumerate(cols):
    if c in ("vorp_proj", "proj_blend", "y_fpts", "resid"):
        continue
    rows.append((LABEL[c], M[i, pi], M[i, ri]))
rows.sort(key=lambda t: abs(t[1]))
print(f"  {'stat':<22}{'vs board value':>16}{'vs what board MISSED':>24}")
for lab, pr, rr in rows[:14]:
    flag = "  <-- new information" if abs(pr) < 0.25 and abs(rr) >= 0.08 else ""
    print(f"  {lab:<22}{pr:>+16.3f}{rr:>+24.3f}{flag}")

print("\n  ...and the stats already inside the price:")
for lab, pr, rr in rows[-6:]:
    print(f"  {lab:<22}{pr:>+16.3f}{rr:>+24.3f}")

json.dump(dict(cols=cols_o, labels=[LABEL[c] for c in cols_o], n_rows=int(len(D)),
               matrix=[[round(float(x), 3) for x in row] for row in M_o],
               dupes=dupes,
               independence=[dict(stat=lab, vs_price=round(float(pr), 3),
                                  vs_miss=round(float(rr), 3)) for lab, pr, rr in rows]),
          open("out/research_corr.json", "w"), indent=1)
D.to_parquet("out/corr_panel.parquet")
print("\nwrote out/research_corr.json, out/corr_panel.parquet")
