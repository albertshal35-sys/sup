"""Stage 26: is "quarterbacks are underpriced" real, or an artefact of shrinkage?

The board says this room should spend ~31% of its money on quarterbacks and it spends
17.9%. That gap is the app's single biggest strategic claim. But the room's own sheet
shows QB prices cliffing after QB5 ($31 -> $20 -> $16), while the board's QB prices
stay flat to QB11 ($40 -> $39 -> $38 -> $34 -> $31 -> $30). One of them is wrong about
the shape.

A gradient-boosted model predicts a conditional MEAN. That is the right target for one
player and the wrong one for a market: the predicted distribution is far narrower than
the real one. Actual QB1 scores 365-430 every year; the model projects 310. Actual
QB1-minus-QB12 is 114-152; the model says 94. Shrinkage pulls the middle of the
position up toward the top, and a flat curve is exactly what an auction should not pay.

The test: for each past season, price the board two ways —

  PROJECTED   what the model said going in (what the app actually charges)
  REALISED    what the players actually scored that season

and compare the budget share each implies per position. If QB's projected share is
much larger than its realised share, the "quarterbacks are cheap" finding is measuring
the model's own compression, not the room's mistake.
"""
import pandas as pd, numpy as np, pickle, json, warnings

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
TEAMS, ROSTER, BUDGET = 10, 17, 200
DISC = BUDGET * TEAMS - ROSTER * TEAMS
POS = ("QB", "RB", "WR", "TE")
# starters per team, with the flex allocated the way it actually fills
START = dict(QB=2 * TEAMS, RB=2 * TEAMS + 4, WR=3 * TEAMS + 4, TE=1 * TEAMS + 2)


def shares(frame, col):
    """Price off surplus over replacement, return budget share by position."""
    d = frame[frame.position.isin(POS)].copy()
    rep = {}
    for p in POS:
        v = d.loc[d.position == p, col].sort_values(ascending=False).values
        n = min(START[p], len(v))
        rep[p] = float(v[n - 1])
    d["sur"] = np.maximum(0.0, d[col] - d.position.map(rep))
    tot = d.sur.sum()
    return {p: d.loc[d.position == p, "sur"].sum() / tot * 100 for p in POS}, rep


rows = []
for s, (b, _) in sorted(BOARDS.items()):
    act = sp[(sp.season == s) & sp.position.isin(POS)][["player_id", "position", "fpts"]]
    prj = b[["player_id", "position", "proj_blend"]]
    sp_p, _ = shares(prj, "proj_blend")
    sp_a, _ = shares(act, "fpts")
    rows.append(dict(season=s, **{f"p_{k}": v for k, v in sp_p.items()},
                     **{f"a_{k}": v for k, v in sp_a.items()}))
D = pd.DataFrame(rows)

print("=" * 78)
print("A. BUDGET SHARE BY POSITION — what the model projected vs what actually happened")
print("=" * 78)
print(f"  {'season':>7}" + "".join(f"{p+' proj':>10}{p+' real':>10}" for p in POS))
for _, r in D.iterrows():
    print(f"  {int(r.season):>7}" + "".join(f"{r['p_'+p]:>10.1f}{r['a_'+p]:>10.1f}" for p in POS))
print(f"  {'MEAN':>7}" + "".join(f"{D['p_'+p].mean():>10.1f}{D['a_'+p].mean():>10.1f}" for p in POS))
print(f"  {'GAP':>7}" + "".join(f"{'':>10}{D['p_'+p].mean()-D['a_'+p].mean():>+10.1f}" for p in POS))

print("\n" + "=" * 78)
print("B. THE SHAPE OF THE QB CURVE — projected vs realised, points by rank")
print("=" * 78)
print(f"  {'':>10}{'QB1':>7}{'QB3':>7}{'QB5':>7}{'QB8':>7}{'QB12':>7}{'QB20':>7}{'1-12':>8}")
for lab, col, src in (("projected", "proj_blend", "b"), ("realised", "fpts", "a")):
    acc = []
    for s, (b, _) in sorted(BOARDS.items()):
        f = b if src == "b" else sp[(sp.season == s) & (sp.position == "QB")]
        v = f[f.position == "QB"].nlargest(24, col)[col].values if src == "b" \
            else f.nlargest(24, col)[col].values
        acc.append([v[i - 1] if i <= len(v) else np.nan for i in (1, 3, 5, 8, 12, 20)])
    m = np.nanmean(acc, axis=0)
    print(f"  {lab:>10}" + "".join(f"{x:>7.0f}" for x in m) + f"{m[0]-m[4]:>8.0f}")

# how much of the QB pool does each curve say is worth real money?
print("\n" + "=" * 78)
print("C. HOW MANY QBs CARRY A REAL PRICE")
print("=" * 78)
for lab, src, col in (("projected", "b", "proj_blend"), ("realised", "a", "fpts")):
    n = []
    for s, (b, _) in sorted(BOARDS.items()):
        f = b[b.position == "QB"] if src == "b" else sp[(sp.season == s) & (sp.position == "QB")]
        v = np.sort(f[col].values)[::-1]
        rep = v[min(2 * TEAMS, len(v)) - 1]
        sur = np.maximum(0, v - rep)
        n.append(int((sur > sur.sum() / len(sur[sur > 0]) * 0.25).sum()) if (sur > 0).any() else 0)
    print(f"  {lab:>10}: {np.mean(n):.1f} QBs above a quarter of the average surplus")

json.dump(dict(
    proj={p: round(float(D['p_' + p].mean()), 1) for p in POS},
    real={p: round(float(D['a_' + p].mean()), 1) for p in POS},
    gap={p: round(float(D['p_' + p].mean() - D['a_' + p].mean()), 1) for p in POS},
    seasons=[int(x) for x in D.season]),
    open("out/research_qbshape.json", "w"), indent=1)
print("\nwrote out/research_qbshape.json")
