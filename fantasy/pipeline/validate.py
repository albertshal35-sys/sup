"""Stage 5b: validate the tuned formula on seasons never used for tuning (2021-2025)."""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings("ignore")
exec(open("optimize.py").read().split("TUNE = list(range(2014, 2021))")[0])

VALID = list(range(2021, 2026))
FIELD = [
    Param("MONEYBALL (VORP+need+VONA)", need=70, vona=0.5),
    Param("VORP only", need=0, vona=0.0),
    Param("Raw projected points", need=0, vona=0.0, mult={"QB": 1.0}),   # replaced below
    Param("Starters-first (crude need)", need=250, vona=0.0),
    Param("Late-QB", need=70, vona=0.5, mult={"QB": 0.2}),
    Param("RB-heavy", need=70, vona=0.5, mult={"RB": 1.35}),
    Param("WR-heavy", need=70, vona=0.5, mult={"WR": 1.35}),
    Param("QB-hoard", need=70, vona=0.5, mult={"QB": 1.4}),
    Param("MONEYBALL no-VONA", need=70, vona=0.0),
    Param("MONEYBALL no-need", need=0, vona=0.5),
    Param("MONEYBALL heavy-need", need=140, vona=0.5),
    Param("MONEYBALL +TE tilt", need=70, vona=0.5, mult={"TE": 1.12}),
]
# make the "raw points" entry genuinely ignore replacement level
RAW = "Raw projected points"


def run_league_raw(board, rep, params, order, noise, rng):
    """Same engine, but the RAW strategy ranks on projected points, not VORP."""
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
            base = (proj if P_.name == RAW else vorp) * np.array([P_.multv(p) for p in pos])
            score = base + noise[slot]
            for p in LINEUP:
                if counts[slot][p] < LINEUP[p]:
                    score = np.where(pos == p, score + P_.need, score)
                else:
                    score = np.where(pos == p, score - P_.surplus, score)
            if P_.vona > 0:
                picks_until = 2 * (TEAMS - 1 - oi) + 1 if rd < ROUNDS else 0
                ob = np.where(avail, vorp, -1e18)
                fut = avail.copy()
                if picks_until > 0:
                    fut[np.argsort(-ob)[:picks_until]] = False
                for p in ("QB", "RB", "WR", "TE"):
                    ix = pos_idx[p]
                    now, later = vorp[ix][avail[ix]], vorp[ix][fut[ix]]
                    gain = (now.max() if len(now) else 0) - (later.max() if len(later) else 0)
                    score = np.where(pos == p, score + P_.vona * gain, score)
            for p, cap in CAP.items():
                lim = P_.max_qb if p == "QB" else cap
                if counts[slot][p] >= lim:
                    score = np.where(pos == p, -1e9, score)
            need = {p: max(0, LINEUP[p] - counts[slot][p]) for p in LINEUP}
            if sum(need.values()) >= ROUNDS - rd + 1:
                score = np.where(np.isin(pos, [p for p in LINEUP if need[p] > 0]), score, -1e9)
            score = np.where(avail, score, -1e9)
            pick = int(np.argmax(score))
            avail[pick] = False
            rosters[slot].append(pick)
            counts[slot][pos[pick]] += 1
    return rosters, pos


print("\n" + "=" * 78)
print("L. OUT-OF-SAMPLE VALIDATION  —  2021-2025, never used for tuning")
print("=" * 78)
obs = {p.name: [] for p in FIELD}
champ = {p.name: [] for p in FIELD}
for season in VALID:
    board, rep = BOARDS[season]
    mat = WKP[season].reindex(board.player_id.values).fillna(0.0).values
    sd = board.groupby("position")["proj_blend"].transform("std").values
    for ns in range(14):
        rng = np.random.default_rng((season * 7919 + ns * 31) % (2**31))
        noise = [rng.normal(0, 0.35 * sd) for _ in range(TEAMS)]
        for rot in range(12):
            order = [(t + rot) % len(FIELD) for t in range(TEAMS)]
            rosters, posv = run_league_raw(board, rep, FIELD, order, noise, rng)
            sc = np.zeros((TEAMS, 17))
            for t in range(TEAMS):
                ix = np.array(rosters[t])
                sc[t] = optimal_weekly(posv[ix], mat[ix])
            wins = np.zeros(TEAMS)
            for w in range(17):
                c = sc[:, w]
                wins += (c[:, None] > c[None, :]).sum(axis=1)
            wins /= 17 * (TEAMS - 1)
            rank = (-sc.sum(axis=1)).argsort().argsort()
            for t in range(TEAMS):
                nm = FIELD[order[t]].name
                obs[nm].append(wins[t]); champ[nm].append(1.0 if rank[t] == 0 else 0.0)
    print("  ", season, "done", flush=True)

rows = []
for p in FIELD:
    v = np.array(obs[p.name])
    rows.append(dict(strategy=p.name, win=v.mean() * 100, se=v.std(ddof=1) / np.sqrt(len(v)) * 100,
                     top1=np.mean(champ[p.name]) * 100, n=len(v)))
r = pd.DataFrame(rows).sort_values("win", ascending=False)
r["win_pct"] = r.win.round(2); r["se_pp"] = r.se.round(2); r["top1_pct"] = r.top1.round(1)
print("\n", r[["strategy", "win_pct", "se_pp", "top1_pct", "n"]].to_string(index=False))
base = r[r.strategy == "Raw projected points"].win.iloc[0]
mb = r[r.strategy == "MONEYBALL (VORP+need+VONA)"].win.iloc[0]
print(f"\n  Moneyball formula vs raw-projected-points drafting: {mb - base:+.2f} win% "
      f"(~{(mb-base)/100*14:+.2f} wins over a 14-game season)")
json.dump(r.to_dict("records"), open("out/research_valid.json", "w"), indent=1, default=str)
print("wrote out/research_valid.json")
