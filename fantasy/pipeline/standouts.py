"""Stage 23: who sits in the odd corners of the chart.

The matrix says which stats are independent of price, and stage 22 says which of
those survive with price held fixed. Exactly one does: LOAD, the size of a
player's job. So the chart is LOAD against price, and the interesting players are
the ones far off its diagonal.

Two corners, both defined by the same validated gap, read in opposite directions:

  CHEAP JOB   large role, small price -- the board has not paid for the workload
  PAID PAST   large price, small role -- the touchdowns came, the volume did not

Everything is standardised inside position, so a tight end and a quarterback sit
on the same chart without one drowning the other.
"""
import pandas as pd, numpy as np, json, warnings

warnings.filterwarnings("ignore")
board = pd.read_parquet("out/board2026.parquet")
LOAD = pd.read_parquet("out/load.parquet")
L26 = LOAD[LOAD.season == 2026][["player_id", "LOAD", "load_raw", "role_opp",
                                 "opp_prev", "depth"]]

b = board.merge(L26, on="player_id", how="left")
b = b[b.position.isin(["QB", "RB", "WR", "TE"]) & (b.auction >= 1)].copy()


def z(col):
    return b.groupby("position")[col].transform(
        lambda s: (s - s.mean()) / s.std(ddof=0) if s.std(ddof=0) > 0 else s * 0)


b["z_price"] = z("auction")
b["z_load"] = z("LOAD")
b["gap"] = b.z_load - b.z_price          # the one gap that survived the control

sel = b[(b.auction >= 2) & b.LOAD.notna()].copy()
print(f"{len(sel)} priced players on the chart")

CORNERS = [
    ("Cheap job", "gap", True,
     "the job is bigger than the price — where the validated edge lives"),
    ("Paying for the past", "gap", False,
     "priced for production his current workload does not support"),
]
out = {}
for name, col, high, blurb in CORNERS:
    d = sel.nlargest(10, col) if high else sel.nsmallest(10, col)
    out[name] = dict(blurb=blurb, players=[
        dict(id=str(r.player_id), name=str(r["name"]), pos=str(r.position),
             team=(None if pd.isna(r.team) else str(r.team)), auc=int(r.auction),
             load=(None if pd.isna(r.LOAD) else round(float(r.LOAD))),
             role=(None if pd.isna(r.role_opp) else round(float(r.role_opp), 1)),
             prev=(None if pd.isna(r.opp_prev) else round(float(r.opp_prev), 1)),
             depth=(None if pd.isna(r.depth) else int(r.depth)),
             gap=round(float(r[col]), 2))
        for _, r in d.iterrows()])
    print(f"\n{name.upper()} — {blurb}")
    for _, r in d.iterrows():
        print(f"  {r['name'][:22]:23s}{r.position:4s}${r.auction:>3.0f}  "
              f"LOAD {r.LOAD:>3.0f}  role {r.role_opp:>4.1f} + prior {r.opp_prev:>4.1f}/gm")

pts = [dict(id=str(r.player_id), n=str(r["name"]), p=str(r.position),
            x=round(float(r.auction), 1), y=round(float(r.LOAD), 1),
            g=round(float(r.gap), 2), pts=round(float(r.proj_total)),
            t=(None if pd.isna(r.team) else str(r.team)))
       for _, r in sel.iterrows()]
print(f"\nscatter points: {len(pts)}")

json.dump(dict(corners=out, scatter=pts,
               median_load=round(float(sel.LOAD.median()), 1),
               median_price=round(float(sel.auction.median()), 1)),
          open("out/research_standouts.json", "w"), indent=1)
print("wrote out/research_standouts.json")
