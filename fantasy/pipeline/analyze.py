"""Stage 2: the actual research. Every question answered against 1999-2025."""
import pandas as pd, numpy as np, json
from scipy.stats import spearmanr

pd.set_option("display.width", 200)
sp = pd.read_parquet("out/player_seasons.parquet")
dst = pd.read_parquet("out/dst_seasons.parquet")
R = {}

# ============================================================ A. REPLACEMENT LEVEL
# League: 12 teams, 2QB 2RB 3WR 1TE 1FLEX(RB/WR/TE) + DST + K
LINEUP = dict(QB=2, RB=2, WR=3, TE=1)
FLEX = 1
FLEX_POS = ["RB", "WR", "TE"]


def replacement_table(df, teams=12, lineup=LINEUP, flex=FLEX):
    """Allocate every starting slot in the league, then read off the first man out."""
    out = {}
    base = {p: n * teams for p, n in lineup.items()}
    pool = {}
    for p in FLEX_POS:
        d = df[df.position == p].sort_values("fpts", ascending=False)
        pool[p] = d["fpts"].values
    taken = dict(base)
    for _ in range(flex * teams):
        best, bestv = None, -1e9
        for p in FLEX_POS:
            i = taken[p]
            if i < len(pool[p]) and pool[p][i] > bestv:
                best, bestv = p, pool[p][i]
        if best is None:
            break
        taken[best] += 1
    for p in ["QB", "RB", "WR", "TE"]:
        d = df[df.position == p].sort_values("fpts", ascending=False)["fpts"].values
        idx = taken[p]  # 0-based index of first non-starter
        out[p] = dict(starters=int(taken[p]), repl=float(d[idx]) if idx < len(d) else float(d[-1]))
    return out


rows = []
for y in range(1999, 2026):
    d = sp[sp.season == y]
    if len(d) == 0:
        continue
    rep12 = replacement_table(d, 12)
    rep1qb = replacement_table(d, 12, dict(QB=1, RB=2, WR=3, TE=1), 1)
    for p in ["QB", "RB", "WR", "TE"]:
        top = d[d.position == p].sort_values("fpts", ascending=False)
        rows.append(dict(season=y, pos=p, starters=rep12[p]["starters"], repl=rep12[p]["repl"],
                         repl_1qb=rep1qb[p]["repl"],
                         p1=top.fpts.iloc[0], p3=top.fpts.iloc[2], p5=top.fpts.iloc[4],
                         p12=top.fpts.iloc[11] if len(top) > 11 else np.nan,
                         vorp1=top.fpts.iloc[0] - rep12[p]["repl"],
                         vorp1_1qb=top.fpts.iloc[0] - rep1qb[p]["repl"],
                         vorp3=top.fpts.iloc[2] - rep12[p]["repl"],
                         vorp5=top.fpts.iloc[4] - rep12[p]["repl"],
                         vorp12=(top.fpts.iloc[11] - rep12[p]["repl"]) if len(top) > 11 else np.nan))
rep = pd.DataFrame(rows)
print("=" * 78)
print("A. REPLACEMENT LEVEL & VORP  —  2QB/2RB/3WR/1TE/1FLEX, 12 teams (mean 2015-2025)")
print("=" * 78)
mod = rep[rep.season >= 2015]
agg = mod.groupby("pos").agg(starters=("starters", "mean"), repl=("repl", "mean"),
                             repl_1qb=("repl_1qb", "mean"),
                             top1_vorp=("vorp1", "mean"), top3_vorp=("vorp3", "mean"),
                             top5_vorp=("vorp5", "mean"), top12_vorp=("vorp12", "mean"),
                             top1_vorp_1qb=("vorp1_1qb", "mean"))
print(agg.round(1))
R["replacement"] = agg.round(2).to_dict("index")

# how much does the 2QB rule move QB value?
qb = agg.loc["QB"]
print(f"\n  QB VORP in this 2QB league: {qb.top1_vorp:.0f}   in a 1QB league: {qb.top1_vorp_1qb:.0f}"
      f"   -> +{qb.top1_vorp - qb.top1_vorp_1qb:.0f} pts of edge created by the 2QB rule")

# positional VORP curve: what is the Nth best player at each position worth?
print("\n  VORP by positional rank (mean 2015-2025), this lineup:")
curve = {}
for p in ["QB", "RB", "WR", "TE"]:
    vals = []
    for y in range(2015, 2026):
        d = sp[(sp.season == y)]
        rr = replacement_table(d, 12)[p]["repl"]
        top = d[d.position == p].sort_values("fpts", ascending=False)["fpts"].values
        vals.append([(top[i] - rr) if i < len(top) else np.nan for i in range(60)])
    m = np.nanmean(np.array(vals), axis=0)
    curve[p] = [round(float(x), 1) for x in m]
    print(f"   {p}: " + "  ".join(f"{i+1}:{m[i]:.0f}" for i in [0, 1, 2, 4, 7, 11, 17, 23, 29, 35]))
R["vorp_curve"] = curve

# ============================================================ B. STAT STICKINESS
print("\n" + "=" * 78)
print("B. WHAT ACTUALLY CARRIES OVER  —  year N metric vs year N+1 fantasy PPG")
print("=" * 78)
METRICS = ["ppg", "tgt_pg", "car_pg", "touch_pg", "rec_pg", "ryd_pg", "rushyd_pg", "ayd_pg",
           "target_share", "air_yards_share", "wopr", "td_pg", "td_rate", "ypc", "ypt",
           "catch_rate", "adot", "epa_rush", "epa_rec", "expl_pg", "fd_pg", "yac_pg",
           "pass_att_pg", "pass_yd_pg", "rush_att_qb_pg", "epa_pass", "cpoe", "games"]

nxt = sp[["player_id", "season", "ppg", "fpts", "games"]].copy()
nxt["season"] = nxt["season"] - 1
nxt.columns = ["player_id", "season", "ppg_next", "fpts_next", "games_next"]
panel = sp.merge(nxt, on=["player_id", "season"], how="inner")
panel = panel[(panel.games >= 8) & (panel.season >= 2009)]
print(f"  player-season pairs with a following season: {len(panel)}")

stick = {}
for p in ["QB", "RB", "WR", "TE"]:
    d = panel[panel.position == p]
    res = []
    for m in METRICS:
        if m not in d.columns:
            continue
        x = d[m].replace([np.inf, -np.inf], np.nan)
        ok = x.notna() & d["ppg_next"].notna()
        if ok.sum() < 60:
            continue
        r_self = spearmanr(x[ok], d.loc[ok, m].shift(0))[0]
        r_next = spearmanr(x[ok], d.loc[ok, "ppg_next"])[0]
        res.append((m, r_next, ok.sum()))
    res.sort(key=lambda t: -abs(t[1]))
    stick[p] = [(m, round(float(r), 3), int(n)) for m, r, n in res]
    print(f"\n  {p}  (rho vs NEXT season PPG, n pairs)")
    for m, r, n in res[:12]:
        print(f"     {m:16s} {r:+.3f}   n={n}")
R["stickiness"] = stick

# self-correlation: is the metric itself repeatable?
selfc = {}
for p in ["QB", "RB", "WR", "TE"]:
    d = sp[(sp.position == p) & (sp.season >= 2009)][["player_id", "season"] + [m for m in METRICS if m in sp.columns]]
    d2 = d.copy(); d2["season"] -= 1
    j = d.merge(d2, on=["player_id", "season"], suffixes=("", "_n"))
    out = {}
    for m in METRICS:
        if m + "_n" not in j.columns:
            continue
        a, b = j[m], j[m + "_n"]
        ok = a.notna() & b.notna() & np.isfinite(a) & np.isfinite(b)
        if ok.sum() > 60:
            out[m] = round(float(spearmanr(a[ok], b[ok])[0]), 3)
    selfc[p] = out
print("\n  Self-repeatability (year N -> year N+1, same metric):")
for p in ["QB", "RB", "WR", "TE"]:
    s = sorted(selfc[p].items(), key=lambda kv: -kv[1])
    print(f"   {p}: sticky " + ", ".join(f"{k}={v}" for k, v in s[:4]) +
          "  ||  noise " + ", ".join(f"{k}={v}" for k, v in s[-4:]))
R["self_corr"] = selfc

# ============================================================ C. AGE CURVES
print("\n" + "=" * 78)
print("C. AGE CURVES  —  mean PPG by age, and P(next season is a decline)")
print("=" * 78)
age_out = {}
for p in ["QB", "RB", "WR", "TE"]:
    d = sp[(sp.position == p) & sp.age.notna() & (sp.games >= 8)].copy()
    d["age_i"] = d.age.round().astype(int)
    g = d.groupby("age_i").agg(ppg=("ppg", "mean"), n=("ppg", "size"))
    g = g[g.n >= 25]
    age_out[p] = {int(k): round(float(v), 2) for k, v in g.ppg.items()}
    peak = g.ppg.idxmax()
    print(f"  {p}: peak age {peak} ({g.ppg.max():.1f} ppg) | " +
          " ".join(f"{a}:{v:.1f}" for a, v in g.ppg.items() if 21 <= a <= 34))
R["age_curve"] = age_out

# age-based decline rate among established starters
print("\n  Year-over-year PPG change for players who scored >=12 ppg, by age bucket:")
decl = {}
for p in ["QB", "RB", "WR", "TE"]:
    d = panel[(panel.position == p) & (panel.ppg >= 12) & panel.age.notna()]
    for lo, hi in [(0, 24), (25, 26), (27, 28), (29, 30), (31, 99)]:
        s = d[(d.age >= lo) & (d.age <= hi)]
        if len(s) < 20:
            continue
        ch = (s.ppg_next - s.ppg).mean()
        keep = (s.ppg_next >= s.ppg * 0.9).mean()
        decl.setdefault(p, {})[f"{lo}-{hi}"] = dict(n=int(len(s)), dppg=round(float(ch), 2),
                                                    hold=round(float(keep), 3))
    print(f"   {p}: " + "  ".join(f"{k}:{v['dppg']:+.1f}({v['n']})" for k, v in decl.get(p, {}).items()))
R["age_decline"] = decl

# ============================================================ D. DST / K
print("\n" + "=" * 78)
print("D. DST & K  —  is there any signal to draft?")
print("=" * 78)
d2 = dst.copy(); d2["season"] -= 1
j = dst.merge(d2[["season", "team", "fpts"]], on=["season", "team"], suffixes=("", "_next"))
print(f"  DST year-over-year fpts correlation: rho={spearmanr(j.fpts, j.fpts_next)[0]:+.3f} (n={len(j)})")
top5 = j[j.groupby("season").fpts.rank(ascending=False) <= 5]
print(f"  Top-5 DST one year -> mean rank next year: {j[j.groupby('season').fpts.rank(ascending=False)<=5].groupby('season').fpts_next.mean().mean():.1f} pts"
      f"  vs league mean {j.fpts_next.mean():.1f}")
k = sp[sp.position == "K"]
k2 = k[["player_id", "season", "fpts", "ppg"]].copy(); k2["season"] -= 1
kj = k.merge(k2, on=["player_id", "season"], suffixes=("", "_next"))
print(f"  K year-over-year ppg correlation:    rho={spearmanr(kj.ppg, kj.ppg_next)[0]:+.3f} (n={len(kj)})")
# spread between elite and replacement
for y in [2023, 2024, 2025]:
    kk = sp[(sp.season == y) & (sp.position == "K")].nlargest(24, "fpts")
    dd = dst[dst.season == y].nlargest(24, "fpts")
    print(f"   {y}: K1={kk.fpts.iloc[0]:.0f} K12={kk.fpts.iloc[11]:.0f} (gap {kk.fpts.iloc[0]-kk.fpts.iloc[11]:.0f}) | "
          f"DST1={dd.fpts.iloc[0]:.0f} DST12={dd.fpts.iloc[11]:.0f} (gap {dd.fpts.iloc[0]-dd.fpts.iloc[11]:.0f})")
R["dst_k"] = dict(dst_yoy=round(float(spearmanr(j.fpts, j.fpts_next)[0]), 3),
                  k_yoy=round(float(spearmanr(kj.ppg, kj.ppg_next)[0]), 3))

# ============================================================ E. DURABILITY
print("\n" + "=" * 78)
print("E. AVAILABILITY  —  games played is a skill you can partly predict")
print("=" * 78)
gm = {}
for p in ["QB", "RB", "WR", "TE"]:
    d = panel[panel.position == p]
    r = spearmanr(d.games, d.games_next)[0]
    full = sp[(sp.position == p) & (sp.season >= 2021)]
    gm[p] = dict(yoy=round(float(r), 3), mean_games=round(float(full.games.mean()), 1))
    print(f"  {p}: games yoy rho={r:+.3f} | mean games (2021-25, players w/ any usage)={full.games.mean():.1f}")
# among fantasy starters only
print("\n  Among top-36 finishers at each position, share who played >=15 games:")
for p in ["QB", "RB", "WR", "TE"]:
    s = sp[(sp.season >= 2015) & (sp.position == p)]
    s = s[s.groupby("season").fpts.rank(ascending=False) <= 36]
    print(f"   {p}: {(s.games>=15).mean():.1%}  (mean {s.games.mean():.1f} games)")
R["durability"] = gm

json.dump(R, open("out/research_a.json", "w"), indent=1, default=str)
print("\nwrote out/research_a.json")
