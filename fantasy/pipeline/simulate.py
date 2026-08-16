"""Stage 4: draft strategy tournament.

Replays every season 2013-2025 as a 12-team snake draft under this exact lineup,
using real weekly scores, optimal weekly lineups, and an all-play record. Twelve
draft strategies compete in the same leagues so they are measured head to head.
DST and K are excluded: every strategy spends its last two picks on them, so they
cancel out. 9 starters + 6 bench = 15 rounds.
"""
import pandas as pd, numpy as np, json, pickle, warnings
from sklearn.ensemble import HistGradientBoostingRegressor

warnings.filterwarnings("ignore")
rng_global = np.random.default_rng(7)

sp = pd.read_parquet("out/player_seasons.parquet")

# ---------------------------------------------------------------- weekly points
S = dict(pass_yd=0.04, pass_td=4.0, itc=-2.0, rush_yd=0.10, rush_td=6.0,
         rec=1.0, rec_yd=0.10, rec_td=6.0, fum=-2.0, two=2.0)


def weekly(y):
    d = pd.read_csv(f"data/wk_{y}.csv", low_memory=False)
    d = d[(d.season_type == "REG") & d.position.isin(["QB", "RB", "WR", "TE"])].copy()
    g = lambda c: pd.to_numeric(d.get(c), errors="coerce").fillna(0.0)
    pts = (g("passing_yards") * S["pass_yd"] + g("passing_tds") * S["pass_td"]
           + g("passing_interceptions") * S["itc"] + g("rushing_yards") * S["rush_yd"]
           + g("rushing_tds") * S["rush_td"] + g("receptions") * S["rec"]
           + g("receiving_yards") * S["rec_yd"] + g("receiving_tds") * S["rec_td"]
           + (g("sack_fumbles_lost") + g("rushing_fumbles_lost") + g("receiving_fumbles_lost")) * S["fum"]
           + (g("passing_2pt_conversions") + g("rushing_2pt_conversions") + g("receiving_2pt_conversions")) * S["two"])
    return pd.DataFrame(dict(player_id=d.player_id, season=y, week=d.week.astype(int),
                             position=d.position, pts=pts))


WK = pd.concat([weekly(y) for y in range(2012, 2026)], ignore_index=True)
print("weekly rows:", len(WK))

# ---------------------------------------------------------------- leak-free boards
LAGS = ["ppg", "xfp_pg", "games", "car_pg", "tgt_pg", "touch_pg", "td_pg", "target_share", "fpts"]
lag = sp[["player_id", "season"] + LAGS].copy(); lag["season"] += 1
lag.columns = ["player_id", "season"] + [c + "_l1" for c in LAGS]
lag2 = sp[["player_id", "season"] + LAGS].copy(); lag2["season"] += 2
lag2.columns = ["player_id", "season"] + [c + "_l2" for c in LAGS]
P = sp.merge(lag, on=["player_id", "season"], how="left").merge(lag2, on=["player_id", "season"], how="left")
nn = sp[["player_id", "season", "ppg", "games", "fpts"]].copy(); nn["season"] -= 1
nn.columns = ["player_id", "season", "y_ppg", "y_games", "y_fpts"]
P = P.merge(nn, on=["player_id", "season"], how="left")
P = P[(P.games >= 4) & (P.season >= 2009)]

COMMON = ["ppg", "xfp_pg", "td_luck_pg", "games", "age", "exp", "fpts",
          "ppg_l1", "xfp_pg_l1", "games_l1", "fpts_l1", "td_pg_l1", "ppg_l2", "xfp_pg_l2", "games_l2"]
POSF = {
    "QB": ["pass_att_pg", "pass_yd_pg", "epa_pass", "cpoe", "car_pg", "rushyd_pg", "td_pg", "car_pg_l1"],
    "RB": ["car_pg", "touch_pg", "tgt_pg", "rec_pg", "rushyd_pg", "ryd_pg", "fd_pg", "expl_pg",
           "td_rate", "ypc", "target_share", "epa_rush", "yac_pg", "car_pg_l1", "touch_pg_l1", "tgt_pg_l1"],
    "WR": ["tgt_pg", "rec_pg", "ryd_pg", "ayd_pg", "target_share", "air_yards_share", "wopr", "adot",
           "catch_rate", "ypt", "td_rate", "fd_pg", "expl_pg", "yac_pg", "epa_rec", "racr",
           "tgt_pg_l1", "target_share_l1", "ryd_pg_l1"],
    "TE": ["tgt_pg", "rec_pg", "ryd_pg", "ayd_pg", "target_share", "air_yards_share", "wopr", "adot",
           "catch_rate", "td_rate", "fd_pg", "expl_pg", "yac_pg", "epa_rec", "tgt_pg_l1", "target_share_l1"],
}


def hgb(depth=4, it=400):
    return HistGradientBoostingRegressor(max_depth=depth, learning_rate=0.05, max_iter=it,
                                         min_samples_leaf=20, l2_regularization=1.0, random_state=0)


def board_for(season):
    """Preseason projection for `season`, trained only on data that predates it."""
    out = []
    for pos in ["QB", "RB", "WR", "TE"]:
        f = [c for c in COMMON + POSF[pos] if c in P.columns]
        tr = P[(P.position == pos) & (P.season < season - 1) & P.y_fpts.notna()]
        te = P[(P.position == pos) & (P.season == season - 1)]
        if len(tr) < 80 or len(te) == 0:
            continue
        mp = hgb().fit(tr[f], tr.y_ppg)
        mg = hgb(3, 250).fit(tr[f], tr.y_games)
        proj_ppg = mp.predict(te[f])
        proj_g = np.clip(mg.predict(te[f]), 0, 17)
        model_total = proj_ppg * proj_g
        naive_total = te.fpts.values
        # the blend that won the bake-off: mostly model, anchored by last year's real total
        out.append(pd.DataFrame(dict(player_id=te.player_id.values, position=pos,
                                     proj_blend=0.75 * model_total + 0.25 * naive_total,
                                     proj_ppg=proj_ppg, proj_g=proj_g)))
    return pd.concat(out, ignore_index=True)


# ---------------------------------------------------------------- lineup + scoring
LINEUP = dict(QB=2, RB=2, WR=3, TE=1)
FLEX_N = 1
FLEX_POS = ("RB", "WR", "TE")
ROUNDS = 15
TEAMS = 10
CAP = dict(QB=4, RB=6, WR=7, TE=3)   # nobody rosters 8 QBs


def replacement_levels(board):
    """Replacement points per position for this lineup, from projections."""
    taken = {p: n * TEAMS for p, n in LINEUP.items()}
    pools = {p: np.sort(board[board.position == p]["proj_blend"].values)[::-1] for p in FLEX_POS}
    for _ in range(FLEX_N * TEAMS):
        best, bv = None, -1e9
        for p in FLEX_POS:
            i = taken[p]
            if i < len(pools[p]) and pools[p][i] > bv:
                best, bv = p, pools[p][i]
        if best:
            taken[best] += 1
    rep = {}
    for p in ["QB", "RB", "WR", "TE"]:
        v = np.sort(board[board.position == p]["proj_blend"].values)[::-1]
        rep[p] = float(v[taken[p]]) if taken[p] < len(v) else float(v[-1])
    return rep


def optimal_weekly(pos_arr, wk_mat):
    """wk_mat: players x 17 weekly points. Returns per-week optimal starting total."""
    total = np.zeros(wk_mat.shape[1])
    used = np.zeros(wk_mat.shape, dtype=bool)
    for p, n in LINEUP.items():
        idx = np.where(pos_arr == p)[0]
        if len(idx) == 0:
            continue
        sub = wk_mat[idx]
        k = min(n, len(idx))
        order = np.argsort(-sub, axis=0)[:k]
        for r in range(k):
            rows = idx[order[r]]
            total += wk_mat[rows, np.arange(wk_mat.shape[1])]
            used[rows, np.arange(wk_mat.shape[1])] = True
    flexable = np.isin(pos_arr, FLEX_POS)[:, None] & ~used
    cand = np.where(flexable, wk_mat, -1e9)
    for _ in range(FLEX_N):
        best = cand.max(axis=0)
        total += np.where(best > -1e8, best, 0)
        cand[cand.argmax(axis=0), np.arange(cand.shape[1])] = -1e9
    return total


# ---------------------------------------------------------------- strategies
# Each strategy is a function(round, roster_counts) -> dict of positional bonus
# applied to VORP when choosing. Bonus is in fantasy points.
def strat_vorp(rd, c):
    return {}


def strat_points(rd, c):
    return "RAW"          # rank by raw projected points, ignore replacement level


def strat_zero_rb(rd, c):
    return {"RB": -400 if rd <= 5 else 0}


def strat_hero_rb(rd, c):
    return {"RB": -400 if (rd <= 6 and c["RB"] >= 1) else 0}


def strat_rb_early(rd, c):
    return {"RB": 60 if rd <= 4 else 0}


def strat_qb_early(rd, c):
    return {"QB": 70 if (rd <= 3 and c["QB"] < 2) else 0}


def strat_qb_late(rd, c):
    return {"QB": -400 if rd <= 7 else 0}


def strat_te_early(rd, c):
    return {"TE": 60 if (rd <= 4 and c["TE"] < 1) else 0}


def strat_wr_heavy(rd, c):
    return {"WR": 45 if rd <= 6 else 0}


def strat_need(rd, c):
    """Fill every starting slot before touching the bench."""
    need = {p: max(0, LINEUP[p] - c[p]) for p in LINEUP}
    return {p: (80 if need[p] > 0 else -30) for p in LINEUP}


def strat_qb_monopoly(rd, c):
    """2QB special: hoard a third and fourth QB to starve the league."""
    b = {}
    if rd <= 3 and c["QB"] < 2:
        b["QB"] = 70
    elif 4 <= rd <= 8 and c["QB"] < 4:
        b["QB"] = 40
    return b


def strat_balanced_vorp(rd, c):
    """VORP but never let a starting slot go unfilled past round 9."""
    if rd >= 10:
        need = {p: max(0, LINEUP[p] - c[p]) for p in LINEUP}
        return {p: (250 if need[p] > 0 else 0) for p in LINEUP}
    return {}


STRATS = [
    ("VORP (pure)", strat_vorp),
    ("VORP + late need", strat_balanced_vorp),
    ("Raw projected points", strat_points),
    ("Zero-RB", strat_zero_rb),
    ("Hero-RB", strat_hero_rb),
    ("RB-early", strat_rb_early),
    ("Elite-QB early", strat_qb_early),
    ("Late-QB", strat_qb_late),
    ("QB monopoly (4 QBs)", strat_qb_monopoly),
    ("Elite-TE early", strat_te_early),
    ("WR-heavy", strat_wr_heavy),
    ("Starters-first need", strat_need),
]


def run_draft(board, rep, order, noise, rng):
    """order[i] = strategy index for draft slot i. Returns roster player_ids per slot."""
    ids = board.player_id.values
    pos = board.position.values
    proj = board.proj_blend.values
    vorp = proj - np.array([rep[p] for p in pos])
    avail = np.ones(len(ids), dtype=bool)
    rosters = [[] for _ in range(TEAMS)]
    counts = [dict(QB=0, RB=0, WR=0, TE=0) for _ in range(TEAMS)]
    for rd in range(1, ROUNDS + 1):
        slots = range(TEAMS) if rd % 2 == 1 else range(TEAMS - 1, -1, -1)
        for slot in slots:
            si = order[slot]
            name, fn = STRATS[si]
            bonus = fn(rd, counts[slot])
            base = proj.copy() if bonus == "RAW" else vorp.copy()
            if bonus == "RAW":
                bonus = {}
            score = base + noise[slot]
            for p, b in bonus.items():
                score = np.where(pos == p, score + b, score)
            for p, cap in CAP.items():
                if counts[slot][p] >= cap:
                    score = np.where(pos == p, -1e9, score)
            # every real drafter fills their starting lineup; force it when picks run out
            need = {p: max(0, LINEUP[p] - counts[slot][p]) for p in LINEUP}
            unfilled = sum(need.values())
            picks_left = ROUNDS - rd + 1
            if unfilled >= picks_left:
                forced = np.isin(pos, [p for p in LINEUP if need[p] > 0])
                score = np.where(forced, score, -1e9)
            score = np.where(avail, score, -1e9)
            pick = int(np.argmax(score))
            avail[pick] = False
            rosters[slot].append(pick)
            counts[slot][pos[pick]] += 1
    return rosters


print("\n" + "=" * 78)
print("J. DRAFT STRATEGY TOURNAMENT  —  12 strategies, same leagues, real outcomes")
print("=" * 78)

SEASONS = list(range(2014, 2026))
ROT, NOISE_SEEDS = 12, 10
agg = {name: dict(w=[], pts=[], champ=[]) for name, _ in STRATS}

for season in SEASONS:
    board = board_for(season)
    rep = replacement_levels(board)
    wk = WK[WK.season == season]
    wkp = wk.pivot_table(index="player_id", columns="week", values="pts", aggfunc="sum")
    wkp = wkp.reindex(columns=range(1, 18)).fillna(0.0)
    board = board[board.player_id.isin(wkp.index) | True].reset_index(drop=True)
    mat = wkp.reindex(board.player_id.values).fillna(0.0).values
    posv = board.position.values
    sd = board.groupby("position")["proj_blend"].transform("std").values
    season_w = {name: [] for name, _ in STRATS}
    season_pts = {name: [] for name, _ in STRATS}
    season_top = {name: [] for name, _ in STRATS}
    season_pl = {name: [] for name, _ in STRATS}
    season_shape = {name: [] for name, _ in STRATS}
    season_qb2 = {name: [] for name, _ in STRATS}
    for ns in range(NOISE_SEEDS):
        rng = np.random.default_rng(hash((season, ns)) % (2**31))
        noise = [rng.normal(0, 0.35 * sd) for _ in range(TEAMS)]
        for rot in range(ROT):
            order = [(t + rot) % len(STRATS) for t in range(TEAMS)]
            rosters = run_draft(board, rep, order, noise, rng)
            scores = np.zeros((TEAMS, 17))
            for t in range(TEAMS):
                idx = np.array(rosters[t])
                scores[t] = optimal_weekly(posv[idx], mat[idx])
            wk_use = scores[:, :17]
            # all-play record: every team vs every other team, every week
            wins = np.zeros(TEAMS)
            for w in range(17):
                col = wk_use[:, w]
                wins += (col[:, None] > col[None, :]).sum(axis=1)
            wins = wins / (17 * (TEAMS - 1))
            tot = wk_use.sum(axis=1)
            rank = (-tot).argsort().argsort()          # 0 = most points in league
            for t in range(TEAMS):
                nm = STRATS[order[t]][0]
                season_w[nm].append(wins[t]); season_pts[nm].append(tot[t])
                season_top[nm].append(1.0 if rank[t] == 0 else 0.0)
                season_pl[nm].append(1.0 if rank[t] < 6 else 0.0)
                cc = {}
                for pk in rosters[t]:
                    cc[posv[pk]] = cc.get(posv[pk], 0) + 1
                season_shape[nm].append([cc.get(x, 0) for x in ("QB", "RB", "WR", "TE")])
                # round in which each strategy took its 2nd QB
                qb_rounds = [i + 1 for i, pk in enumerate(rosters[t]) if posv[pk] == "QB"]
                season_qb2[nm].append(qb_rounds[1] if len(qb_rounds) > 1 else 16)
    for nm, _ in STRATS:
        agg[nm]["w"].append(np.mean(season_w[nm]))
        agg[nm]["pts"].append(np.mean(season_pts[nm]))
        agg[nm]["champ"].append(np.mean(season_top[nm]))
        agg[nm].setdefault("playoff", []).append(np.mean(season_pl[nm]))
        agg[nm].setdefault("shape", []).append(np.mean(np.array(season_shape[nm]), axis=0))
        agg[nm].setdefault("qb2", []).append(np.mean(season_qb2[nm]))
    print(f"  {season} done", flush=True)

rows = []
for nm, _ in STRATS:
    sh = np.mean(np.array(agg[nm]["shape"]), axis=0)
    rows.append(dict(strategy=nm, winpct=np.mean(agg[nm]["w"]), pts=np.mean(agg[nm]["pts"]),
                     top1=np.mean(agg[nm]["champ"]), playoff=np.mean(agg[nm]["playoff"]),
                     qb2_round=np.mean(agg[nm]["qb2"]),
                     shape=f"{sh[0]:.1f}QB/{sh[1]:.1f}RB/{sh[2]:.1f}WR/{sh[3]:.1f}TE",
                     best_season=max(agg[nm]["w"]), worst_season=min(agg[nm]["w"])))
res = pd.DataFrame(rows).sort_values("winpct", ascending=False)
res["win_pct"] = (res.winpct * 100).round(2)
res["season_pts"] = res.pts.round(0)
print("\n  Mean all-play win% across 2013-2025 (n = 13 seasons x 120 leagues each):\n")
res["top1_pct"] = (res.top1 * 100).round(1)
res["playoff_pct"] = (res.playoff * 100).round(1)
res["qb2_rd"] = res.qb2_round.round(1)
print(res[["strategy", "win_pct", "season_pts", "top1_pct", "playoff_pct", "qb2_rd", "shape"]].to_string(index=False))

json.dump({r["strategy"]: dict(winpct=round(float(r["winpct"]), 4), pts=round(float(r["pts"]), 1),
                               top1=round(float(r["top1"]), 4), playoff=round(float(r["playoff"]), 4),
                               qb2_round=round(float(r["qb2_round"]), 2), shape=r["shape"])
           for _, r in res.iterrows()}, open("out/research_sim.json", "w"), indent=1)
pickle.dump(dict(agg=agg, seasons=SEASONS), open("out/sim_raw.pkl", "wb"))
print("\nwrote out/research_sim.json")
