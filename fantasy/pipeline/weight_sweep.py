"""Stage 5e: retune the formula's two weights.

A multiplier on ANY single position beat the neutral formula by about the same
amount, which rules out a receiver-specific effect and points at the real cause:
scaling VORP up shrinks the fixed need bonus in relative terms. Multiplying every
position's VORP by m is identical to dividing both weights by m, so the honest fix
is to sweep the weights themselves.

    score = VORP + need_bonus * (starting slot still open) + vona_w * (drop by next turn)
"""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings("ignore")
import sim_env
sim_env.load(globals())

ALL = list(range(2014, 2026))
GRID = [(0, 0.0), (30, 0.3), (30, 0.5), (45, 0.3), (45, 0.5), (54, 0.39),
        (70, 0.5), (70, 0.3), (90, 0.5), (110, 0.5), (45, 0.7), (70, 0.7)]
FIELD = [Param(f"need{n}/vona{v}", need=n, vona=v) for n, v in GRID]

per = {p.name: {s: [] for s in ALL} for p in FIELD}
top1 = {p.name: [] for p in FIELD}
for season in ALL:
    board, rep = BOARDS[season]
    mat = WKP[season].reindex(board.player_id.values).fillna(0.0).values
    sd = board.groupby("position")["proj_blend"].transform("std").values
    for ns in range(10):
        rng = np.random.default_rng((season * 4451 + ns * 89) % (2**31))
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
                per[nm][season].append(wins[t]); top1[nm].append(1.0 if rank[t] == 0 else 0.0)
    print("  ", season, "done", flush=True)

rows = []
for p in FIELD:
    v = np.array([x for s in ALL for x in per[p.name][s]])
    early = np.mean([x for s in ALL if s <= 2020 for x in per[p.name][s]]) * 100
    late = np.mean([x for s in ALL if s > 2020 for x in per[p.name][s]]) * 100
    rows.append(dict(weights=p.name, need=p.need, vona=p.vona, win=v.mean() * 100,
                     se=v.std(ddof=1) / np.sqrt(len(v)) * 100, top1=np.mean(top1[p.name]) * 100,
                     early=early, late=late))
r = pd.DataFrame(rows).sort_values("win", ascending=False)
print("\n", r.round(2)[["weights", "win", "se", "top1", "early", "late"]].to_string(index=False))
best = r.iloc[0]
print(f"\n  best: need={best.need} vona={best.vona} -> {best.win:.2f}% "
      f"(2014-20 {best.early:.2f}, 2021-25 {best.late:.2f})")
cur = r[r.weights == "need70/vona0.5"].iloc[0]
print(f"  currently shipping need=70 vona=0.5 -> {cur.win:.2f}%  (delta {best.win - cur.win:+.2f} pp)")
json.dump(r.to_dict("records"), open("out/research_weights.json", "w"), indent=1, default=str)
