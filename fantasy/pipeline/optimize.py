"""Stage 5: find the best draft formula, then validate it out of sample.

Parameterised strategy:
    score(player) = VORP * posmult[pos]
                  + need_bonus     if a starting slot at that pos is still empty
                  - surplus_pen    if the starting slots at that pos are already full
                  + vona_weight * (best VORP at pos now - best VORP at pos at my next turn)

Tuned on 2014-2020, validated untouched on 2021-2025.
"""
import pandas as pd, numpy as np, json, pickle, warnings, itertools, sys
from sklearn.ensemble import HistGradientBoostingRegressor

warnings.filterwarnings("ignore")
exec(open("simulate.py").read().split("# ---------------------------------------------------------------- strategies")[0])

BOARDS = {}
for season in range(2014, 2026):
    b = board_for(season)
    BOARDS[season] = (b, replacement_levels(b))
    print("board", season, len(b), flush=True)

WKP = {}
for season in range(2014, 2026):
    wk = WK[WK.season == season]
    p = wk.pivot_table(index="player_id", columns="week", values="pts", aggfunc="sum")
    WKP[season] = p.reindex(columns=range(1, 18)).fillna(0.0)


class Param:
    def __init__(self, name, need=0.0, surplus=0.0, vona=0.0,
                 mult=None, qb_floor_round=99, max_qb=4):
        self.name = name; self.need = need; self.surplus = surplus; self.vona = vona
        self.mult = mult or {}
        self.qb_floor_round = qb_floor_round
        self.max_qb = max_qb

    def multv(self, pos):
        return self.mult.get(pos, 1.0)


def run_league(board, rep, params, order, noise, rng):
    ids = board.player_id.values
    pos = board.position.values
    proj = board.proj_blend.values
    vorp = proj - np.array([rep[p] for p in pos])
    avail = np.ones(len(ids), dtype=bool)
    rosters = [[] for _ in range(TEAMS)]
    counts = [dict(QB=0, RB=0, WR=0, TE=0) for _ in range(TEAMS)]
    pos_idx = {p: np.where(pos == p)[0] for p in ("QB", "RB", "WR", "TE")}

    for rd in range(1, ROUNDS + 1):
        slots = list(range(TEAMS)) if rd % 2 == 1 else list(range(TEAMS - 1, -1, -1))
        for oi, slot in enumerate(slots):
            P_ = params[order[slot]]
            base = vorp * np.array([P_.multv(p) for p in pos])
            score = base + noise[slot]

            # need / surplus
            for p in LINEUP:
                if counts[slot][p] < LINEUP[p]:
                    score = np.where(pos == p, score + P_.need, score)
                else:
                    score = np.where(pos == p, score - P_.surplus, score)

            # value over next available
            if P_.vona > 0:
                picks_until = 2 * (TEAMS - 1 - oi) + 1 if rd < ROUNDS else 0
                order_by = np.where(avail, vorp, -1e18)
                if picks_until > 0:
                    gone = np.argsort(-order_by)[:picks_until]
                    fut = avail.copy(); fut[gone] = False
                else:
                    fut = avail.copy()
                for p in ("QB", "RB", "WR", "TE"):
                    ix = pos_idx[p]
                    now = vorp[ix][avail[ix]]
                    later = vorp[ix][fut[ix]]
                    gain = (now.max() if len(now) else 0) - (later.max() if len(later) else 0)
                    score = np.where(pos == p, score + P_.vona * gain, score)

            for p, cap in CAP.items():
                lim = P_.max_qb if p == "QB" else cap
                if counts[slot][p] >= lim:
                    score = np.where(pos == p, -1e9, score)

            # hard floor: two QBs on the roster by this round
            if rd >= P_.qb_floor_round and counts[slot]["QB"] < LINEUP["QB"]:
                score = np.where(pos == "QB", score, -1e9)

            need = {p: max(0, LINEUP[p] - counts[slot][p]) for p in LINEUP}
            if sum(need.values()) >= ROUNDS - rd + 1:
                forced = np.isin(pos, [p for p in LINEUP if need[p] > 0])
                score = np.where(forced, score, -1e9)

            score = np.where(avail, score, -1e9)
            pick = int(np.argmax(score))
            avail[pick] = False
            rosters[slot].append(pick)
            counts[slot][pos[pick]] += 1
    return rosters, pos


def evaluate(params, seasons, rotations=12, noise_seeds=6):
    """All-play win% per parameter set, competing head to head in shared leagues."""
    res = {p.name: [] for p in params}
    top1 = {p.name: [] for p in params}
    for season in seasons:
        board, rep = BOARDS[season]
        mat = WKP[season].reindex(board.player_id.values).fillna(0.0).values
        sd = board.groupby("position")["proj_blend"].transform("std").values
        for ns in range(noise_seeds):
            rng = np.random.default_rng((season * 977 + ns * 13) % (2**31))
            noise = [rng.normal(0, 0.35 * sd) for _ in range(TEAMS)]
            for rot in range(rotations):
                order = [(t + rot) % len(params) for t in range(TEAMS)]
                rosters, posv = run_league(board, rep, params, order, noise, rng)
                scores = np.zeros((TEAMS, 17))
                for t in range(TEAMS):
                    ix = np.array(rosters[t])
                    scores[t] = optimal_weekly(posv[ix], mat[ix])
                wins = np.zeros(TEAMS)
                for w in range(17):
                    col = scores[:, w]
                    wins += (col[:, None] > col[None, :]).sum(axis=1)
                wins /= 17 * (TEAMS - 1)
                tot = scores.sum(axis=1)
                rank = (-tot).argsort().argsort()
                for t in range(TEAMS):
                    nm = params[order[t]].name
                    res[nm].append(wins[t]); top1[nm].append(1.0 if rank[t] == 0 else 0.0)
    return ({k: float(np.mean(v)) for k, v in res.items()},
            {k: float(np.mean(v)) for k, v in top1.items()})


TUNE = list(range(2014, 2021))
VALID = list(range(2021, 2026))

# ---------------------------------------------------------------- round 1
print("\n" + "=" * 78)
print("K. FORMULA SEARCH  —  round 1, tuned on 2014-2020")
print("=" * 78)
cands = [
    Param("A vorp only"),
    Param("B need60", need=60),
    Param("C need100", need=100),
    Param("D need60+surp40", need=60, surplus=40),
    Param("E vona0.5", vona=0.5),
    Param("F vona1.0", vona=1.0),
    Param("G need60+vona0.5", need=60, vona=0.5),
    Param("H need100+vona1", need=100, vona=1.0),
    Param("I need60 qbmult1.15", need=60, mult={"QB": 1.15}),
    Param("J need60 qbfloor7", need=60, qb_floor_round=7),
    Param("K need60+vona.5 qb1.1", need=60, vona=0.5, mult={"QB": 1.10}),
    Param("L need80+surp30+vona.7", need=80, surplus=30, vona=0.7),
]
w, t1 = evaluate(cands, TUNE)
r1 = pd.DataFrame([dict(name=k, win=v * 100, top1=t1[k] * 100) for k, v in w.items()]).sort_values("win", ascending=False)
print(r1.round(2).to_string(index=False))

# ---------------------------------------------------------------- round 2
print("\n" + "=" * 78)
print("K. FORMULA SEARCH  —  round 2, refining the leaders")
print("=" * 78)
cands2 = [
    Param("need60+vona.5", need=60, vona=0.5),
    Param("need80+vona.5", need=80, vona=0.5),
    Param("need100+vona.5", need=100, vona=0.5),
    Param("need80+vona.8", need=80, vona=0.8),
    Param("need80+vona.3", need=80, vona=0.3),
    Param("need80+surp20+vona.5", need=80, surplus=20, vona=0.5),
    Param("need80+vona.5+qb1.1", need=80, vona=0.5, mult={"QB": 1.10}),
    Param("need80+vona.5+qb1.2", need=80, vona=0.5, mult={"QB": 1.20}),
    Param("need80+vona.5+te1.1", need=80, vona=0.5, mult={"TE": 1.10}),
    Param("need80+vona.5+rb0.9", need=80, vona=0.5, mult={"RB": 0.90}),
    Param("need80+vona.5 qbfloor8", need=80, vona=0.5, qb_floor_round=8),
    Param("need80+vona.5 maxqb3", need=80, vona=0.5, max_qb=3),
]
w2, t2 = evaluate(cands2, TUNE)
r2 = pd.DataFrame([dict(name=k, win=v * 100, top1=t2[k] * 100) for k, v in w2.items()]).sort_values("win", ascending=False)
print(r2.round(2).to_string(index=False))

json.dump(dict(round1=r1.to_dict("records"), round2=r2.to_dict("records")),
          open("out/research_opt.json", "w"), indent=1, default=str)
print("\nwrote out/research_opt.json")
