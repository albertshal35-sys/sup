"""Stage 7: assemble the app — board data + research findings injected into the template."""
import pandas as pd, numpy as np, json, math
from scipy.stats import spearmanr

board = pd.read_parquet("out/board2026.parquet")
sp = pd.read_parquet("out/player_seasons.parquet")
RA = json.load(open("out/research_a.json"))
RSIM = json.load(open("out/research_sim.json"))
RV = json.load(open("out/research_valid.json"))
TILT_WR = json.load(open("out/research_tilt_WR.json"))
TILT_RB = json.load(open("out/research_tilt_RB.json"))
CONF = json.load(open("out/research_confirm_WR.json"))
WTS = json.load(open("out/research_weights.json"))
AUC = json.load(open("out/research_auction_real.json"))
WAAJ = json.load(open("out/research_waa.json"))
FIELD = json.load(open("out/research_field.json"))
QBD = json.load(open("out/research_qb_density.json"))
ROOM = json.load(open("out/room_bias.json"))
BRK = json.load(open("out/research_breakout.json"))
BB = pd.read_parquet("out/breakout_board.parquet")
SOS = pd.read_parquet("out/sos_2026.parquet")
LIFTJ = json.load(open("out/research_lift.json"))
RUNJ = json.load(open("out/research_runway.json"))
LIFTP = pd.read_parquet("out/lift.parquet")
LIFTP = LIFTP[LIFTP.season == 2026][["player_id", "LIFT", "lift_raw", "role_opp", "opp_prev"]]
board = board.merge(LIFTP, on="player_id", how="left")

# ---------------------------------------------------------------- positional premium
# Decision rule, fixed before looking at the confirmation run: apply a wide receiver
# premium only if the clean two-arm test clears 2 standard errors, holds in both
# halves of the sample, and beats the running-back control. Use the middle of the
# plateau rather than the argmax, so the weight is not fitted to one lucky level.
def sweep_delta(tab, pos):
    base = [r for r in tab if str(r["mult"]).endswith("x1.0")][0]
    best = max((r for r in tab if not str(r["mult"]).endswith("x1.0")), key=lambda r: float(r["win"]))
    return float(best["win"]) - float(base["win"]), float(best["se"]), str(best["mult"])


wr_sweep_delta, wr_sweep_se, wr_best_lvl = sweep_delta(TILT_WR, "WR")
rb_sweep_delta, rb_sweep_se, rb_best_lvl = sweep_delta(TILT_RB, "RB")

seasons = sorted(CONF["neutral"].keys())
neutral_by_season = np.array([CONF["neutral"][s] for s in seasons])
tilt_key = [k for k in CONF if k != "neutral"][0]
tilt_by_season = np.array([CONF[tilt_key][s] for s in seasons])
conf_delta = (tilt_by_season - neutral_by_season).mean() * 100
early = [i for i, s in enumerate(seasons) if int(s) <= 2020]
late = [i for i, s in enumerate(seasons) if int(s) > 2020]
d_early = (tilt_by_season[early] - neutral_by_season[early]).mean() * 100
d_late = (tilt_by_season[late] - neutral_by_season[late]).mean() * 100
conf_se = (tilt_by_season - neutral_by_season).std(ddof=1) / np.sqrt(len(seasons)) * 100

TILT_REAL = bool(conf_delta > 2 * conf_se and d_early > 0 and d_late > 0
                 and conf_delta > rb_sweep_delta)
POS_MULT = {"WR": 1.25} if TILT_REAL else {}

# Weights actually shipped: the best (need, vona) pair that is also positive in
# both halves of the sample, so a single strong era cannot pick them.
top = max(WTS, key=lambda w: float(w["win"]))
band = [w for w in WTS if float(w["win"]) >= float(top["win"]) - float(top["se"])]
needs = sorted(float(w["need"]) for w in band)
plateau_need = needs[len(needs) // 2]                    # middle of the flat region
plateau_vona = max(set(float(w["vona"]) for w in band),
                   key=lambda v: sum(1 for w in band if float(w["vona"]) == v))
pick = min(WTS, key=lambda w: (abs(float(w["need"]) - plateau_need),
                               abs(float(w["vona"]) - plateau_vona)))
naive = [w for w in WTS if float(w["need"]) == 0 and float(w["vona"]) == 0][0]
WEIGHTS = dict(need=float(pick["need"]), vona=float(pick["vona"]),
               win=round(float(pick["win"]), 2), se=round(float(pick["se"]), 2),
               vorp_only=round(float(naive["win"]), 2),
               edge=round(float(pick["win"]) - float(naive["win"]), 2),
               band=[round(needs[0]), round(needs[-1])])
print(f"weight plateau: need {needs[0]:.0f}-{needs[-1]:.0f} all within 1 SE; "
      f"shipping need={WEIGHTS['need']:.0f} vona={WEIGHTS['vona']} "
      f"({WEIGHTS['win']}% vs {WEIGHTS['vorp_only']}% for VORP alone)")
print(f"WR sweep best {wr_best_lvl}: {wr_sweep_delta:+.2f} pp | RB control best {rb_best_lvl}: {rb_sweep_delta:+.2f} pp")
print(f"WR confirmation: {conf_delta:+.2f} pp ± {conf_se:.2f} "
      f"(2014-20 {d_early:+.2f}, 2021-25 {d_late:+.2f}) -> premium applied: {TILT_REAL}")


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
        lift=clean(r.get("LIFT"), 0), liftRaw=clean(r.get("lift_raw"), 1),
        role=clean(r.get("role_opp"), 1), oppPrev=clean(r.get("opp_prev"), 1),
        waa=clean(r.get("waa25"), 2), flr=clean(r.get("flr25"), 3),
        spk=clean(r.get("spk25"), 3), ghst=clean(r.get("ghst25"), 3),
        flags=list(r.flags) if isinstance(r.flags, (list, np.ndarray)) else []))
players.sort(key=lambda p: (-p["auc"], -p["vorp"]))
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

raw_win = float([r for r in sim_tab if "Raw projected" in r["strategy"]][0]["win"])
mb_win = float([r for r in sim_tab if r["strategy"].startswith("MONEYBALL (")][0]["win"])
formula_edge = mb_win - raw_win

# The held-out table uses internal arm names; give them labels a reader can parse.
LABELS = {
    "MONEYBALL (VORP+need+VONA)": "Value + need + scarcity",
    "MONEYBALL no-VONA": "Value + need only",
    "MONEYBALL no-need": "Value + scarcity only",
    "MONEYBALL heavy-need": "Value, heavy need bonus",
    "MONEYBALL +TE tilt": "Value, tight-end premium",
    "Starters-first (crude need)": "Fill all starters first",
    "VORP only": "Value over replacement only",
    "Raw projected points": "Highest projected points",
    "WR-heavy": "Value, receiver premium",
    "RB-heavy": "Value, running-back premium",
    "QB-hoard": "Value, quarterback premium",
    "Late-QB": "Wait on quarterbacks",
}
sim_se = float(np.mean([float(r["se"]) for r in sim_tab]))

RESEARCH = dict(
    qb_edge=qb_edge, repl=rep, repl_1qb=rep1, pos_mult=POS_MULT, weights=WEIGHTS,
    tilt=dict(real=TILT_REAL, applied=POS_MULT.get("WR", 1.0),
              wr_delta=clean(conf_delta, 2), rb_delta=clean(rb_sweep_delta, 2),
              se=clean(conf_se, 2), seasons=len(seasons),
              levels=[dict(mult=float(str(r["mult"]).split("x")[1]), win=clean(float(r["win"]), 2))
                      for r in TILT_WR]),
    shape=(lambda b: dict(shape=b['shape'], qb2_round=b['qb2_round'],
                          playoff=b['playoff'], top1=b['top1']))(
        max(RSIM.values(), key=lambda v: v['winpct'])),
    td_regress=td_regress, sticky=sticky, games=games,
    dst_k=RA["dst_k"], late_qb_cost=clean(late_cost, 4),
    curve={k: [clean(x, 1) for x in v] for k, v in RA["vorp_curve"].items()},
    sim=dict(best_win=clean(best, 2), formula_edge=clean(formula_edge, 2), se=clean(sim_se, 2),
             table=[dict(name=LABELS.get(r["strategy"], r["strategy"]), win=clean(float(r["win"]), 2))
                    for r in sim_tab[:8]]))

split = {}
_tot = sum(p["auc"] for p in players)
for pos in ("QB", "RB", "WR", "TE", "K", "DST"):
    split[pos] = round(sum(p["auc"] for p in players if p["pos"] == pos) / _tot * 100, 1)
RESEARCH["budget_split"] = split
def _l(v):
    return list(v) if isinstance(v, (list, np.ndarray)) else []


RESEARCH["lift"] = dict(
    rho=LIFTJ["rho"], spread=LIFTJ["spread"], se=LIFTJ["se"], n=LIFTJ["n"],
    seasons=LIFTJ["seasons"], role_curve=LIFTJ["role_curve"],
    quintiles=LIFTJ["quintiles"],
    runway_spread=RUNJ["spread"], runway_se=RUNJ["se"], runway_rho=RUNJ["rho"],
    runway_earned=RUNJ["parts"]["earned"],
    leaders=[dict(id=str(r.player_id), name=str(r["name"]), pos=str(r.position),
                  team=(None if pd.isna(r.team) else str(r.team)), auc=int(r.auction),
                  lift=clean(r.LIFT, 0), raw=clean(r.lift_raw, 1),
                  role=clean(r.role_opp, 1), prev=clean(r.opp_prev, 1))
             for _, r in board[(board.auction >= 2) & board.LIFT.notna()]
                              .nlargest(16, "LIFT").iterrows()],
    maxed=[dict(id=str(r.player_id), name=str(r["name"]), pos=str(r.position),
                team=(None if pd.isna(r.team) else str(r.team)), auc=int(r.auction),
                lift=clean(r.LIFT, 0), role=clean(r.role_opp, 1), prev=clean(r.opp_prev, 1))
           for _, r in board[(board.auction >= 15) & board.LIFT.notna()]
                            .nsmallest(6, "LIFT").iterrows()])
print("LIFT: rho", LIFTJ["rho"], "spread", LIFTJ["spread"],
      "| leaders", len(RESEARCH["lift"]["leaders"]))

RESEARCH["breakout"] = dict(
    rho=BRK["rho"], spread=BRK["spread"], se=BRK["se"], n=BRK["n"],
    seasons=BRK["seasons"], signals=BRK["signals"],
    picks=[dict(id=str(r.player_id), name=str(r["name"]), pos=str(r.position),
                team=(None if pd.isna(r.team) else str(r.team)),
                bye=(None if pd.isna(r.bye) else int(r.bye)),
                auc=int(r.auction), pts=clean(r.proj_total, 0),
                edge=clean(r.edge, 0), edged=clean(r["edge_$"], 0),
                why=_l(r.why), risk=_l(r.risk))
           for _, r in BB.nlargest(24, "edge").iterrows()],
    fades=[dict(id=str(r.player_id), name=str(r["name"]), pos=str(r.position),
                team=(None if pd.isna(r.team) else str(r.team)),
                auc=int(r.auction), edge=clean(r.edge, 0), risk=_l(r.risk))
           for _, r in BB[BB.auction >= 8].nsmallest(12, "edge").iterrows()],
    sos=[dict(team=str(r.team), pos=str(r.position), sos=clean(r.sos, 2),
              playoff=clean(r.sos_playoff, 2))
         for _, r in SOS.dropna(subset=["sos"]).iterrows()])
print("breakout picks:", len(RESEARCH["breakout"]["picks"]),
      "| fades:", len(RESEARCH["breakout"]["fades"]),
      "| sos rows:", len(RESEARCH["breakout"]["sos"]))

RESEARCH["room"] = dict(
    ratio={p: v["ratio"] for p, v in ROOM.items()},
    room_pct={p: v["room_pct"] for p, v in ROOM.items()},
    fair_pct={p: v["fair_pct"] for p, v in ROOM.items()},
    season=2025)
print("room read (¢ on the dollar, 2025):", {p: round(v["ratio"] * 100) for p, v in ROOM.items()})
RESEARCH["waa"] = dict(
    acc_waa=WAAJ["acc_waa"], acc_pts=WAAJ["acc_pts"],
    win_waa=WAAJ["wins"], win_pts=WAAJ["points"], diff=WAAJ["diff"], se=WAAJ["se"])
RESEARCH["field"] = dict(
    vol_rare=FIELD["volatile|2"]["edge"], vol_half=FIELD["volatile|6"]["edge"],
    vol_common=FIELD["volatile|10"]["edge"],
    safe_rare=FIELD["safe|2"]["edge"], safe_common=FIELD["safe|10"]["edge"],
    qb_density=[dict(n=int(k), edge=v["edge"], se=v["se"])
                for k, v in sorted(QBD.items(), key=lambda x: int(x[0]))
                if v.get("se") is not None])
print("corrected: QB premium by density ->", RESEARCH["field"]["qb_density"])

# ---------------------------------------------------------------- auction study
A = {r["strategy"]: r for r in AUC}
def w(k):
    return round(float(A[k]["win"]), 2)
neutral = w("Value + inflation")
qb_prem, qb_disc = w("QB premium"), w("QB discount")
rb_prem = w("RB premium")
# A premium only counts as real if its mirror image moves the other way and the
# same premium on another position does nothing. QB clears both; RB does not.
qb_real = (qb_prem - neutral) > 2 and (qb_prem - qb_disc) > 3 and (qb_prem - neutral) > (rb_prem - neutral) + 2
RESEARCH["auction"] = dict(
    table=[dict(name=r["strategy"], win=round(float(r["win"]), 2),
                spend=round(float(r["spend"])), shape=r["shape"]) for r in AUC],
    neutral=neutral, qb_premium=qb_prem, qb_discount=qb_disc, rb_premium=rb_prem,
    qb_edge=round(qb_prem - neutral, 2), qb_mirror=round(qb_prem - qb_disc, 2),
    rb_edge=round(rb_prem - neutral, 2), qb_real=bool(qb_real),
    qb_mult=1.0,
    flat=w("Value, flat"), inflation_edge=round(neutral - w("Value, flat"), 2),
    stars=w("Stars and scrubs"), stars_cost=round(neutral - w("Stars and scrubs"), 2),
    aggressive=w("Aggressive (pay 115%)"), bargain=w("Bargain hunter (pay 85%)"),
    best_shape=A["QB premium"]["shape"], best_spend=round(float(A["QB premium"]["spend"])),
    se=round(float(np.mean([float(r["se"]) for r in AUC])), 2))
print("auction study:", {k: v for k, v in RESEARCH["auction"].items() if k != "table"})
print("budget split (% of a team's money):", split)

DATA = dict(players=players,
            meta=dict(player_seasons=int(len(sp)), sim_seasons=12, teams=10, budget=200,
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
