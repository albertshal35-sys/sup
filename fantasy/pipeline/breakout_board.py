"""Stage 17: turn the situational model into a list you can actually bid on.

Two guards on the raw model output. It likes backup quarterbacks, because a
third-stringer who wins a job gains two hundred points and the model has learned
that low projections have the most room above them. That is true and useless: you
cannot spend an auction on lottery tickets. So the list is restricted to players
the board already prices, and each name carries the reasons that put it there.
"""
import pandas as pd, numpy as np, json

bo = pd.read_parquet("out/breakout_2026.parquet")
board = pd.read_parquet("out/board2026.parquet")

b = board[["player_id", "name", "position", "team", "bye", "auction", "proj_total",
           "proj_ppg", "proj_g", "vorp", "pos_rank", "age26", "flr25", "ghst25"]]
m = bo.merge(b, on="player_id", how="inner", suffixes=("", "_b"))
m = m[m.auction >= 2]                       # has to be someone you would actually bid on
print(f"{len(m)} priced players carry a situational read")

# Dollars are the currency here, so convert at the MARGIN the board itself uses:
# a dollar buys you `surplus` points above the last man bought, not average points.
priced = board[board.auction > 0]
surplus_total = float(priced["surplus"].sum()) if "surplus" in priced else np.nan
discretionary = float(priced.auction.sum() - len(priced))
pts_per_dollar = surplus_total / discretionary
m["edge_$"] = (m.edge / pts_per_dollar).round(0)
print(f"a dollar buys {pts_per_dollar:.1f} points of surplus at the margin")


def reasons(r):
    out = []
    if pd.notna(r.climb) and r.climb >= 1:
        out.append(f"up {int(r.climb)} on the depth chart since last preseason")
    if pd.notna(r.depth) and r.depth == 1 and (pd.isna(r.climb) or r.climb < 1):
        out.append("listed first at his position")
    if pd.notna(r.vac_tgt_share) and r.vac_tgt_share >= 0.25 and r.position in ("WR", "TE"):
        out.append(f"{r.vac_tgt_share:.0%} of the team's targets left the building")
    if pd.notna(r.vac_car_share) and r.vac_car_share >= 0.25 and r.position == "RB":
        out.append(f"{r.vac_car_share:.0%} of the team's carries are unclaimed")
    if r.coach_change == 1:
        out.append("new head coach")
    if r.new_team == 1:
        out.append("new team")
    if pd.notna(r.trend) and r.trend >= 1.5:
        out.append(f"finished last season with {r.trend:.1f} more touches a game than he started it")
    if pd.notna(r.td_luck_pg) and r.td_luck_pg <= -1.0:
        out.append("scored below what his volume deserved, which usually rebounds")
    if pd.notna(r.exp) and r.exp in (1, 2):
        out.append(f"year {int(r.exp) + 1}, where the age curve is steepest")
    if pd.notna(r.sos) and r.sos >= 0.25:
        out.append("draws one of the softer schedules for his position")
    if pd.notna(r.sos_playoff) and r.sos_playoff >= 0.35:
        out.append("and a soft weeks 15-17")
    return out


def warnings_(r):
    out = []
    if pd.notna(r.sos) and r.sos <= -0.3:
        out.append("hard schedule for his position")
    if pd.notna(r.ghst25) and r.ghst25 >= 0.35:
        out.append(f"gave you nothing in {r.ghst25:.0%} of weeks last year")
    if r.new_team == 1:
        out.append("new team — situational reads are least reliable here")
    return out


m["why"] = m.apply(lambda r: reasons(r), axis=1)
m["risk"] = m.apply(lambda r: warnings_(r), axis=1)
m = m[m.why.str.len() > 0]
m = m.sort_values("edge", ascending=False)

cols = ["player_id", "name", "position", "team", "bye", "auction", "proj_total",
        "edge", "edge_$", "why", "risk", "vac_tgt_share", "vac_car_share", "climb",
        "depth", "new_team", "coach_change", "trend", "sos", "sos_playoff", "exp", "flr25"]
out = m[cols].copy()
out.to_parquet("out/breakout_board.parquet")

print("\nTOP 20 MUST-DRAFTS FOR 2026 (priced players only)")
print("=" * 100)
for i, (_, r) in enumerate(out.head(20).iterrows(), 1):
    print(f"{i:2d}. {r['name']:24s} {r.position} {str(r.team):<4} ${r.auction:>3.0f}  "
          f"+{r.edge:5.1f} pts (~${r['edge_$']:+.0f})")
    print(f"    {'; '.join(r.why[:3])}")

print("\n\nBIGGEST FADES (priced high, situation says no)")
print("=" * 100)
fade = m[(m.auction >= 8)].nsmallest(10, "edge")
for _, r in fade.iterrows():
    rs = warnings_(r) or ["situation points down"]
    print(f"  {r['name']:24s} {r.position} {str(r.team):<4} ${r.auction:>3.0f}  {r.edge:+6.1f} pts   {rs[0]}")

# schedule table for the tab
sos = m.drop_duplicates(subset=["team", "position"])[["team", "position", "sos", "sos_playoff"]]
sos.to_parquet("out/sos_2026.parquet")
print(f"\nwrote out/breakout_board.parquet ({len(out)} names) and out/sos_2026.parquet")
