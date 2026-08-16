"""Stage 5c: does a positional tilt on top of the formula actually help?

The held-out run hinted that multiplying WR value beat the neutral formula. That
could be a real property of a 3WR + flex PPR league, or an artifact of the field
it was drafting against. This isolates it: one position's multiplier is swept
across a balanced field over every season 2014-2025.
"""
import pandas as pd, numpy as np, json, warnings, sys
warnings.filterwarnings("ignore")
exec(open("optimize.py").read().split("TUNE = list(range(2014, 2021))")[0])

ALL = list(range(2014, 2026))
WHICH = sys.argv[1] if len(sys.argv) > 1 else "WR"
LEVELS = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5]

FIELD = []
for lv in LEVELS:
    FIELD.append(Param(f"{WHICH}x{lv:.1f}", need=70, vona=0.5,
                       mult=({} if lv == 1.0 else {WHICH: lv})))
FIELD = FIELD * 2          # 12 teams: each level appears twice per league

print(f"sweeping {WHICH} multiplier over {len(ALL)} seasons, field of {len(FIELD)}")
obs = {p.name: [] for p in FIELD}
champ = {p.name: [] for p in FIELD}
for season in ALL:
    board, rep = BOARDS[season]
    mat = WKP[season].reindex(board.player_id.values).fillna(0.0).values
    sd = board.groupby("position")["proj_blend"].transform("std").values
    for ns in range(8):
        rng = np.random.default_rng((season * 6151 + ns * 47) % (2**31))
        noise = [rng.normal(0, 0.35 * sd) for _ in range(TEAMS)]
        for rot in range(12):
            order = [(t + rot) % len(FIELD) for t in range(TEAMS)]
            rosters, posv = run_league(board, rep, FIELD, order, noise, rng)
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
for nm in dict.fromkeys(p.name for p in FIELD):
    v = np.array(obs[nm])
    rows.append(dict(mult=nm, win=v.mean() * 100, se=v.std(ddof=1) / np.sqrt(len(v)) * 100,
                     top1=np.mean(champ[nm]) * 100, n=len(v)))
r = pd.DataFrame(rows)
r["win_pct"] = r.win.round(2); r["se_pp"] = r.se.round(2); r["top1_pct"] = r.top1.round(1)
print("\n", r[["mult", "win_pct", "se_pp", "top1_pct", "n"]].to_string(index=False))
base = r[r.mult == f"{WHICH}x1.0"].win.iloc[0]
r["vs_neutral"] = (r.win - base).round(2)
print(f"\n  vs neutral ({WHICH}x1.0):")
for _, x in r.iterrows():
    sig = abs(x.vs_neutral) / np.sqrt(x.se ** 2 + r[r.mult == f"{WHICH}x1.0"].se.iloc[0] ** 2)
    print(f"    {x['mult']}: {x.vs_neutral:+.2f} pp  ({sig:.1f} SE)")
json.dump(r.to_dict("records"), open(f"out/research_tilt_{WHICH}.json", "w"), indent=1, default=str)
