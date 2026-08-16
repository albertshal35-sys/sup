"""Stage 5d: two-arm confirmation of a positional tilt, reported season by season.

A sweep that peaks somewhere is easy to over-read. This runs just the neutral
formula against the candidate tilt in a half-and-half field and prints the
per-season split, so a real effect can be told apart from one good era.
"""
import pandas as pd, numpy as np, json, warnings, sys
warnings.filterwarnings("ignore")
exec(open("optimize.py").read().split("TUNE = list(range(2014, 2021))")[0])

POS = sys.argv[1] if len(sys.argv) > 1 else "WR"
LV = float(sys.argv[2]) if len(sys.argv) > 2 else 1.3
ALL = list(range(2014, 2026))

FIELD = ([Param("neutral", need=70, vona=0.5)] * 6 +
         [Param(f"{POS}x{LV}", need=70, vona=0.5, mult={POS: LV})] * 6)
NAMES = ["neutral", f"{POS}x{LV}"]

per = {n: {s: [] for s in ALL} for n in NAMES}
for season in ALL:
    board, rep = BOARDS[season]
    mat = WKP[season].reindex(board.player_id.values).fillna(0.0).values
    sd = board.groupby("position")["proj_blend"].transform("std").values
    for ns in range(10):
        rng = np.random.default_rng((season * 3301 + ns * 71) % (2**31))
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
            for t in range(TEAMS):
                per[FIELD[order[t]].name][season].append(wins[t])
    a = np.mean(per[NAMES[0]][season]) * 100
    b = np.mean(per[NAMES[1]][season]) * 100
    print(f"  {season}: neutral {a:5.2f}   {NAMES[1]} {b:5.2f}   diff {b-a:+5.2f}", flush=True)

rows = []
for n in NAMES:
    v = np.array([x for s in ALL for x in per[n][s]])
    rows.append((n, v.mean() * 100, v.std(ddof=1) / np.sqrt(len(v)) * 100))
print("\n  overall:")
for n, m, se in rows:
    print(f"    {n:12s} {m:.2f}% ± {se:.2f}")
diff = rows[1][1] - rows[0][1]
se = np.sqrt(rows[0][2] ** 2 + rows[1][2] ** 2)
print(f"    difference: {diff:+.2f} pp ({abs(diff)/se:.1f} SE)")
wins_by_season = sum(1 for s in ALL
                     if np.mean(per[NAMES[1]][s]) > np.mean(per[NAMES[0]][s]))
print(f"    tilt beat neutral in {wins_by_season}/{len(ALL)} seasons")
early = [s for s in ALL if s <= 2020]
late = [s for s in ALL if s > 2020]
for lab, ss in [("2014-2020", early), ("2021-2025", late)]:
    a = np.mean([x for s in ss for x in per[NAMES[0]][s]]) * 100
    b = np.mean([x for s in ss for x in per[NAMES[1]][s]]) * 100
    print(f"    {lab}: {b-a:+.2f} pp")
json.dump({n: {str(s): float(np.mean(per[n][s])) for s in ALL} for n in NAMES},
          open(f"out/research_confirm_{POS}.json", "w"), indent=1)
