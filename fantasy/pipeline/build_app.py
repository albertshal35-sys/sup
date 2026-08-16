"""Stage 7: assemble the app — board data + research findings injected into the template."""
import pandas as pd, numpy as np, json, math
from scipy.stats import spearmanr

board = pd.read_parquet("out/board2026.parquet")
sp = pd.read_parquet("out/player_seasons.parquet")
RA = json.load(open("out/research_a.json"))
RV = json.load(open("out/research_valid.json"))


def clean(v, nd=2):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else round(f, nd)


# ---------------------------------------------------------------- players
# A 12-team, 17-round draft consumes 204 players. Carry a deep enough pool at each
# position to cover every plausible run, then stop — the tail is waiver fodder.
DEPTH = dict(QB=45, RB=75, WR=90, TE=32, K=32, DST=32)
board = board.sort_values("proj_total", ascending=False)
board["pos_rank"] = board.groupby("position").cumcount() + 1
keepers = set()
for pos, n in DEPTH.items():
    d = board[board.position == pos]
    keepers |= set(d.head(n).player_id)
keepers |= set(board[board.vorp > 0].player_id)

players = []
for _, r in board.iterrows():
    if r.player_id not in keepers:
        continue
    players.append(dict(
        id=str(r.player_id), name=str(r["name"]), pos=str(r.position),
        team=(None if pd.isna(r.team) else str(r.team)),
        bye=(None if pd.isna(r.bye) else int(r.bye)),
        age=clean(r.age26, 1), ppg=clean(r.proj_ppg, 1), g=clean(r.proj_g, 1),
        pts=clean(r.proj_total, 1), vorp=clean(r.vorp, 1),
        tier=int(r.tier), posRank=int(r.pos_rank), auc=int(r.auction),
        flags=list(r.flags) if isinstance(r.flags, (list, np.ndarray)) else []))
players.sort(key=lambda p: -p["vorp"])
for i, p in enumerate(players):
    p["rank"] = i + 1
print("players in app:", len(players),
      {p: sum(1 for x in players if x["pos"] == p) for p in ("QB", "RB", "WR", "TE", "K", "DST")})

# ---------------------------------------------------------------- findings
# durability: games played the season after a full season
gnext = sp[["player_id", "season", "games"]].copy()
gnext["season"] -= 1
gnext.columns = ["player_id", "season", "g_next"]
j = sp.merge(gnext, on=["player_id", "season"])
j = j[(j.season >= 2015) & (j.games >= 15)]
games = {p: clean(j[j.position == p].g_next.mean(), 2) for p in ("QB", "RB", "WR", "TE")}

# touchdown regression: what the top decile of TD over-performers did next year
nx = sp[["player_id", "season", "ppg"]].copy()
nx["season"] -= 1
nx.columns = ["player_id", "season", "ppg_next"]
pan = sp.merge(nx, on=["player_id", "season"])
pan = pan[(pan.games >= 8) & (pan.season >= 2009)]
td_regress = {}
for p in ("QB", "RB", "WR", "TE"):
    d = pan[pan.position == p]
    hi = d[d.td_luck_pg >= d.td_luck_pg.quantile(0.90)]
    td_regress[p] = clean(hi.ppg_next.mean() - hi.ppg.mean(), 2)

sc = RA["self_corr"]
sticky = dict(
    tgt=clean(np.mean([sc[p].get("tgt_pg", 0) for p in ("RB", "WR", "TE")]), 3),
    car=clean(sc["RB"].get("car_pg"), 3),
    ypc=clean(sc["RB"].get("ypc"), 3),
    tdrate=clean(np.mean([sc[p].get("td_rate", 0) for p in ("RB", "WR", "TE")]), 3))

rep = {k: clean(v["repl"], 1) for k, v in RA["replacement"].items()}
rep1 = {k: clean(v["repl_1qb"], 1) for k, v in RA["replacement"].items()}
qb_edge = clean(RA["replacement"]["QB"]["top1_vorp"] - RA["replacement"]["QB"]["top1_vorp_1qb"], 1)

sim_tab = sorted(RV, key=lambda r: -float(r["win"]))
best = float(sim_tab[0]["win"])
late = [r for r in sim_tab if "Late-QB" in r["strategy"]]
late_cost = (best - float(late[0]["win"])) / 100 if late else 0

RESEARCH = dict(
    qb_edge=qb_edge, repl=rep, repl_1qb=rep1,
    td_regress=td_regress, sticky=sticky, games=games,
    dst_k=RA["dst_k"], late_qb_cost=clean(late_cost, 4),
    curve={k: [clean(x, 1) for x in v] for k, v in RA["vorp_curve"].items()},
    sim=dict(best_win=clean(best, 2),
             table=[dict(name=r["strategy"], win=clean(float(r["win"]), 2)) for r in sim_tab[:7]]))

DATA = dict(players=players,
            meta=dict(player_seasons=int(len(sp)), sim_seasons=12,
                      seasons="1999-2025", built="2026-08-16"))

tpl = open("app_template.html").read()
out = tpl.replace("/*__DATA__*/null", json.dumps(DATA, separators=(",", ":")))
out = out.replace("/*__RESEARCH__*/null", json.dumps(RESEARCH, separators=(",", ":")))
open("out/artifact.html", "w").write(out)

standalone = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
              '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
              + out.split("</style>")[0] + "</style>\n</head>\n<body>\n"
              + out.split("</style>", 1)[1] + "\n</body>\n</html>\n")
open("out/standalone.html", "w").write(standalone)
print("artifact.html:", len(out) // 1024, "KB | standalone.html:", len(standalone) // 1024, "KB")
print("research payload:", json.dumps(RESEARCH)[:400], "...")
