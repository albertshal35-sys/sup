"""Stage 18: RUNWAY — one number for how much room a player has to take off.

A breakout is not "a good player". The board already prices good players. A
breakout is a player whose ROLE is about to grow, and role growth needs two
things at once:

  1. He did more with the ball than the men he shares the position with.
     Coaches do not hand out work for its own sake — they take it from the guy
     doing less with it. This is measured against his OWN teammates, not the
     league, so it survives being on a bad offence.

  2. There is work sitting there unclaimed. Either it walked out of the building
     in the off-season, or he simply has not been given a full share yet.

Neither half predicts anything alone. A hyper-efficient player with no room stays
where he is; an empty depth chart in front of a player who cannot play does not
help him. RUNWAY is deliberately a PRODUCT, so both have to be true.

    EARNED   his non-touchdown points per opportunity, over his teammates' rate
             at the same position, on the same team

    ROOM     the share of his position's work on that team that is unclaimed:
             what left in the off-season, plus the distance between his own
             share and a normal lead man's share

    RUNWAY = EARNED x ROOM

Touchdowns are stripped out of EARNED on purpose. Touchdown rate is the least
repeatable thing in football, and a stat meant to find next year's breakout must
not be measuring last year's luck.
"""
import pandas as pd, numpy as np, json, warnings
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
PANEL = pd.read_parquet("out/breakout_panel.parquet")

POS = ("QB", "RB", "WR", "TE")
# a normal lead man's share of his position group's work on his own team
LEAD_SHARE = {"RB": 0.55, "WR": 0.30, "TE": 0.55, "QB": 0.85}
GROUP = {"RB": "RB", "WR": "PASSCATCH", "TE": "PASSCATCH", "QB": "QB"}

TEAM_FIX = {"AZ": "ARI", "LAR": "LA", "LVR": "LV", "WSH": "WAS", "CLV": "CLE",
            "BLT": "BAL", "HST": "HOU", "SL": "LA", "SD": "LAC", "OAK": "LV"}


def build_runway(season):
    """RUNWAY for every player heading into `season`, from season-1 production."""
    d = sp[(sp.season == season - 1) & sp.position.isin(POS)].copy()
    d["team"] = d.recent_team.replace(TEAM_FIX)
    d["grp"] = d.position.map(GROUP)

    # opportunities and non-touchdown points
    d["opp"] = np.where(d.position == "QB", d.attempts + d.carries, d.targets + d.carries)
    ntd = (d.passing_yards * 0.04 + d.passing_interceptions * -2
           + d.rushing_yards * 0.10 + d.receptions * 1.0 + d.receiving_yards * 0.10
           + d.fum_lost * -2)
    d["ntd_pts"] = ntd
    d = d[d.opp >= 20]                       # below this, rate stats are noise

    # ---- EARNED: his rate over his own teammates' rate in the same group
    tm = d.groupby(["team", "grp"]).agg(t_opp=("opp", "sum"), t_pts=("ntd_pts", "sum")).reset_index()
    d = d.merge(tm, on=["team", "grp"], how="left")
    other_opp = (d.t_opp - d.opp).clip(lower=1)
    other_pts = d.t_pts - d.ntd_pts
    d["rate"] = d.ntd_pts / d.opp.clip(lower=1)
    d["team_rate"] = (other_pts / other_opp).replace([np.inf, -np.inf], np.nan)
    d["earned"] = d.rate / d.team_rate.replace(0, np.nan)
    d["earned"] = d.earned.clip(0.4, 2.5).fillna(1.0)

    # ---- ROOM: unclaimed work at his position group on his 2026 team
    nxt_team = PANEL[PANEL.season == season][["player_id", "team"]].rename(
        columns={"team": "team_next"})
    d = d.merge(nxt_team, on="player_id", how="left")
    d["team_next"] = d.team_next.fillna(d.team)

    # what walked out of each building, by group
    if (sp.season == season).any():
        cur = sp[sp.season == season][["player_id", "recent_team"]].copy()
        cur["recent_team"] = cur.recent_team.replace(TEAM_FIX)
        cur.columns = ["player_id", "where_now"]
    else:
        r = pd.read_csv("data/rost_2026.csv", low_memory=False)
        r["team"] = r["team"].replace(TEAM_FIX)
        cur = r[r.status.isin(["ACT", "RES", "E14"])][["gsis_id", "team"]].dropna()
        cur = cur.drop_duplicates("gsis_id")
        cur.columns = ["player_id", "where_now"]
    g = d[["player_id", "team", "grp", "opp"]].merge(cur, on="player_id", how="left")
    g["gone"] = (g.where_now.isna()) | (g.where_now != g.team)
    vac = g[g.gone].groupby(["team", "grp"]).opp.sum().rename("vac_opp").reset_index()
    tot = g.groupby(["team", "grp"]).opp.sum().rename("grp_opp").reset_index()
    vac = tot.merge(vac, on=["team", "grp"], how="left").fillna({"vac_opp": 0})
    vac["vac_share"] = vac.vac_opp / vac.grp_opp.clip(lower=1)

    # a player's own share, and the gap to a normal lead man
    d["share"] = d.opp / d.t_opp.clip(lower=1)
    d["lead_gap"] = d.position.map(LEAD_SHARE) - d.share

    # unclaimed work he could plausibly inherit, on the team he is on NOW
    v_next = vac.rename(columns={"team": "team_next"})
    d = d.merge(v_next[["team_next", "grp", "vac_share"]], on=["team_next", "grp"], how="left")
    d["vac_share"] = d.vac_share.fillna(0)
    d["room"] = (d.vac_share + d.lead_gap.clip(lower=0)).clip(0, 1.0)

    d["RUNWAY"] = d.earned * d.room
    d["season"] = season
    return d[["player_id", "player_display_name", "position", "season", "team_next",
              "earned", "room", "share", "vac_share", "lead_gap", "opp", "RUNWAY"]]


R = pd.concat([build_runway(y) for y in range(2014, 2027)], ignore_index=True)
R.to_parquet("out/runway.parquet")
print(f"RUNWAY computed for {len(R)} player-seasons, {R.season.min()}-{R.season.max()}")
print(f"  median EARNED {R.earned.median():.2f}  median ROOM {R.room.median():.2f}  "
      f"median RUNWAY {R.RUNWAY.median():.3f}")

# ---------------------------------------------------------------- does it work?
import pickle
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
rows = []
for s in sorted(set(R.season) & set(BOARDS)):
    b, _ = BOARDS[s]
    nx = sp[sp.season == s][["player_id", "fpts"]].rename(columns={"fpts": "y_fpts"})
    d = R[R.season == s].merge(b[["player_id", "proj_blend"]], on="player_id", how="inner")
    d = d.merge(nx, on="player_id", how="inner")
    rows.append(d)
D = pd.concat(rows, ignore_index=True)
D["resid"] = D.y_fpts - D.proj_blend
print(f"\ntestable player-seasons: {len(D)} across {D.season.nunique()} seasons")

print("\n" + "=" * 74)
print("X. DOES RUNWAY FIND WHAT THE PRICE SHEET MISSED?")
print("=" * 74)
print(f"  {'metric':<26}{'rho vs residual':>18}")
for col, lab in [("RUNWAY", "RUNWAY"), ("earned", "  EARNED alone"),
                 ("room", "  ROOM alone"), ("vac_share", "  vacated share alone"),
                 ("share", "  his usage share"), ("opp", "  raw opportunities")]:
    ok = D[col].notna()
    print(f"  {lab:<26}{spearmanr(D.loc[ok, col], D.loc[ok, 'resid'])[0]:>+18.3f}")

print("\n  by season (RUNWAY only):")
for s, d in D.groupby("season"):
    if len(d) < 40:
        continue
    print(f"    {s}: {spearmanr(d.RUNWAY, d.resid)[0]:+.3f}   n={len(d)}")

print("\n  mean points above projection, by RUNWAY quintile:")
D["q"] = pd.qcut(D.RUNWAY, 5, labels=["bottom", "2nd", "middle", "4th", "top"])
for q, d in D.groupby("q", observed=True):
    print(f"    {str(q):<8} {d.resid.mean():+7.1f} pts   (n={len(d)})")
hi, lo = D[D.q == "top"], D[D.q == "bottom"]
spread = hi.resid.mean() - lo.resid.mean()
se = np.sqrt(hi.resid.var() / len(hi) + lo.resid.var() / len(lo))
print(f"\n  top fifth minus bottom fifth: {spread:+.1f} pts  ({abs(spread)/se:.1f} SE)")

# the product has to beat its own parts, or it is not a stat, just decoration
print("\n  does the product beat its halves? (both must be true for RUNWAY to earn its name)")
for lab, col in [("EARNED", "earned"), ("ROOM", "room")]:
    d2 = D.copy()
    d2["qq"] = pd.qcut(d2[col].rank(method="first"), 5, labels=False)
    s2 = d2[d2.qq == 4].resid.mean() - d2[d2.qq == 0].resid.mean()
    print(f"    {lab:<8} top-vs-bottom fifth: {s2:+6.1f} pts")
print(f"    {'RUNWAY':<8} top-vs-bottom fifth: {spread:+6.1f} pts")

json.dump(dict(rho=round(float(spearmanr(D.RUNWAY, D.resid)[0]), 3),
               spread=round(float(spread), 1), se=round(float(se), 1), n=int(len(D)),
               seasons=[int(x) for x in sorted(D.season.unique())],
               parts={c: round(float(spearmanr(D[c], D.resid)[0]), 3)
                      for c in ("earned", "room", "vac_share", "share")}),
          open("out/research_runway.json", "w"), indent=1)
print("\nwrote out/research_runway.json")
