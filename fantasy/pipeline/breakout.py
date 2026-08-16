"""Stage 15: who is set up to beat his price.

The board prices a player on what he did. This asks the separate question of what
changed around him — because the things that produce a leap are mostly situational,
and they are visible in data before they show up in a stat line:

  VACATED    targets and carries that left his team, and are now up for grabs
  CLIMB      where he sits on today's depth chart against where he sat last year
  NEWTEAM    he changed teams, into more or less opportunity
  COACH      his team changed head coach
  TREND      his usage over the back half of last season versus the front half
  TDLUCK     he scored below what his volume deserved, and that mostly rebounds
  LEAP       second and third year players, where the age curve is steepest
  SOS        what his 2026 opponents did to his position in 2025

Nothing here is taken on faith. Every signal is computed for every historical
season too, and the whole set is scored against what players actually did the
following year, out of sample, before any of it reaches the board.
"""
import pandas as pd, numpy as np, json, warnings, glob, re
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
SEASONS = list(range(2021, 2026))
POS = ("QB", "RB", "WR", "TE")

sp = pd.read_parquet("out/player_seasons.parquet")
games = pd.read_csv("data/games.csv", low_memory=False)

# ---------------------------------------------------------------- weekly points
S = dict(pass_yd=0.04, pass_td=4.0, itc=-2.0, rush_yd=0.10, rush_td=6.0,
         rec=1.0, rec_yd=0.10, rec_td=6.0, fum=-2.0, two=2.0)


def weekly(y):
    d = pd.read_csv(f"data/wk_{y}.csv", low_memory=False)
    d = d[(d.season_type == "REG") & d.position.isin(POS)].copy()
    g = lambda c: pd.to_numeric(d.get(c), errors="coerce").fillna(0.0)
    d["pts"] = (g("passing_yards") * S["pass_yd"] + g("passing_tds") * S["pass_td"]
                + g("passing_interceptions") * S["itc"] + g("rushing_yards") * S["rush_yd"]
                + g("rushing_tds") * S["rush_td"] + g("receptions") * S["rec"]
                + g("receiving_yards") * S["rec_yd"] + g("receiving_tds") * S["rec_td"]
                + (g("sack_fumbles_lost") + g("rushing_fumbles_lost")
                   + g("receiving_fumbles_lost")) * S["fum"])
    d["opp"] = d.get("opponent_team")
    d["tgt"] = g("targets"); d["car"] = g("carries")
    return d[["player_id", "season", "week", "position", "team", "opp", "pts", "tgt", "car"]]


WK = pd.concat([weekly(y) for y in range(2012, 2026)], ignore_index=True)

# ---------------------------------------------------------------- 1. usage trend
# Second half versus first half. A player finishing the season with the ball in
# his hands more often than he started it is the cheapest breakout tell there is.
tr = WK[WK.season >= 2012].copy()
tr["half"] = np.where(tr.week <= 9, "h1", "h2")
use = tr.groupby(["player_id", "season", "half"]).agg(
    tch=("tgt", "sum"), car=("car", "sum"), g=("week", "nunique"), pts=("pts", "sum")).reset_index()
use["opp_pg"] = (use.tch + use.car) / use.g.clip(lower=1)
piv = use.pivot_table(index=["player_id", "season"], columns="half", values="opp_pg").reset_index()
piv.columns.name = None
piv = piv.rename(columns={"h1": "opp_h1", "h2": "opp_h2"})
piv["trend"] = piv.opp_h2 - piv.opp_h1

# ---------------------------------------------------------------- 2. vacated work
# nflverse writes Arizona as ARI in the stat files and AZ in the roster file
TEAM_FIX = {"AZ": "ARI", "LAR": "LA", "LVR": "LV", "WSH": "WAS", "CLV": "CLE",
            "BLT": "BAL", "HST": "HOU", "SL": "LA", "SD": "LAC", "OAK": "LV"}


def fix_team(s):
    return s.replace(TEAM_FIX)


ROS26 = pd.read_csv("data/rost_2026.csv", low_memory=False)
ROS26["team"] = fix_team(ROS26["team"])
ROS26 = ROS26[ROS26.status.isin(["ACT", "RES", "E14"])][["gsis_id", "team"]].dropna()
ROS26 = ROS26.drop_duplicates("gsis_id").rename(columns={"gsis_id": "player_id", "team": "team_now"})


def vacated_for(season):
    """Opportunity on each roster that belonged to somebody who is now gone.

    For a season already played, "where is he now" comes from that season's
    stats. For the upcoming one it has to come from the roster file, since
    nobody has taken a snap yet."""
    prev = sp[sp.season == season - 1][["player_id", "recent_team", "targets", "carries"]].copy()
    prev.columns = ["player_id", "team", "tgt", "car"]
    if (sp.season == season).any():
        cur = sp[sp.season == season][["player_id", "recent_team"]].copy()
        cur.columns = ["player_id", "team_now"]
    else:
        cur = ROS26.copy()
    j = prev.merge(cur, on="player_id", how="left")
    gone = j[(j.team_now.isna()) | (j.team_now != j.team)]
    v = gone.groupby("team").agg(vac_tgt=("tgt", "sum"), vac_car=("car", "sum")).reset_index()
    tot = prev.groupby("team").agg(tm_tgt=("tgt", "sum"), tm_car=("car", "sum")).reset_index()
    v = tot.merge(v, on="team", how="left").fillna(0)
    v["vac_tgt_share"] = v.vac_tgt / v.tm_tgt.clip(lower=1)
    v["vac_car_share"] = v.vac_car / v.tm_car.clip(lower=1)
    v["season"] = season
    return v[["season", "team", "vac_tgt", "vac_car", "vac_tgt_share", "vac_car_share"]]


VAC = pd.concat([vacated_for(y) for y in range(2013, 2027)], ignore_index=True)

# ---------------------------------------------------------------- 3. coaching change
gg = games[games.game_type == "REG"]
coach = pd.concat([
    gg[["season", "home_team", "home_coach"]].rename(columns={"home_team": "team", "home_coach": "coach"}),
    gg[["season", "away_team", "away_coach"]].rename(columns={"away_team": "team", "away_coach": "coach"}),
]).dropna().drop_duplicates(subset=["season", "team"])
c_prev = coach.copy(); c_prev["season"] += 1
c_prev = c_prev.rename(columns={"coach": "coach_prev"})
COACH = coach.merge(c_prev, on=["season", "team"], how="left")
COACH["coach_change"] = (COACH.coach != COACH.coach_prev) & COACH.coach_prev.notna()

# ---------------------------------------------------------------- 4. defence faced
def def_allowed(season):
    """Fantasy points each defence gave up per game, by position."""
    d = WK[WK.season == season]
    a = d.groupby(["opp", "position"]).agg(pts=("pts", "sum")).reset_index()
    gp = d.groupby("opp").week.nunique().rename("gp").reset_index()
    a = a.merge(gp, on="opp")
    a["allowed_pg"] = a.pts / a.gp
    a["z"] = a.groupby("position").allowed_pg.transform(lambda s: (s - s.mean()) / s.std())
    return a.rename(columns={"opp": "team"})[["team", "position", "allowed_pg", "z"]]


def sos_for(season):
    """Average defence a team faces, by position, using the prior year's numbers."""
    d = def_allowed(season - 1)
    sched = games[(games.season == season) & (games.game_type == "REG")]
    rows = []
    for _, g in sched.iterrows():
        rows.append((g.home_team, g.away_team, int(g.week)))
        rows.append((g.away_team, g.home_team, int(g.week)))
    s = pd.DataFrame(rows, columns=["team", "opp", "week"])
    m = s.merge(d.rename(columns={"team": "opp"}), on="opp", how="left")
    full = m.groupby(["team", "position"]).z.mean().reset_index().rename(columns={"z": "sos"})
    post = m[m.week.between(15, 17)].groupby(["team", "position"]).z.mean().reset_index() \
             .rename(columns={"z": "sos_playoff"})
    out = full.merge(post, on=["team", "position"], how="left")
    out["season"] = season
    return out


SOS = pd.concat([sos_for(y) for y in range(2013, 2027)], ignore_index=True)

# ---------------------------------------------------------------- 5. depth charts
def depth_snapshot(year):
    """nflverse changed depth-chart format mid-decade; read either shape and
    return the same three columns: who, where, and how high on the chart."""
    try:
        d = pd.read_csv(f"data/depth_{year}.csv", low_memory=False)
    except Exception:
        return None
    if "gsis_id" not in d.columns:
        return None
    if "pos_abb" in d.columns:                       # 2025+ : one row per snapshot
        d = d[d.pos_abb.isin(["QB", "RB", "WR", "TE"])].copy()
        d["dt"] = pd.to_datetime(d.get("dt"), errors="coerce")
        # For a season already played, the only honest snapshot is the earliest
        # one — a week-18 chart knows how the year went. For the season ahead
        # there is only the preseason chart, which is the whole point.
        d = d.sort_values("dt").groupby("gsis_id", as_index=False).head(1)
        d = d.rename(columns={"pos_rank": "depth", "team": "depth_team"})
        d["depth_team"] = fix_team(d["depth_team"])
    else:                                            # 2021-2024 : one row per week
        d = d[d.position.isin(["QB", "RB", "WR", "TE"])].copy()
        if "week" in d.columns:
            d = d[d.week <= 1] if (d.week <= 1).any() else d
            d = d.sort_values("week").groupby("gsis_id", as_index=False).head(1)
        d = d.rename(columns={"depth_team": "depth", "club_code": "depth_team"})
        d["depth_team"] = fix_team(d["depth_team"])
    d = d.dropna(subset=["gsis_id"])
    d["depth"] = pd.to_numeric(d["depth"], errors="coerce")
    d = d.dropna(subset=["depth"]).sort_values("depth").groupby("gsis_id", as_index=False).head(1)
    return d[["gsis_id", "depth_team", "depth"]].rename(
        columns={"gsis_id": "player_id"}).assign(season=year)


DEPTH = pd.concat([x for x in (depth_snapshot(y) for y in range(2021, 2027)) if x is not None],
                  ignore_index=True)
print(f"depth chart rows: {len(DEPTH)} across {DEPTH.season.nunique()} seasons")

# ---------------------------------------------------------------- assemble
def build(season):
    """Every situational signal for players heading into `season`."""
    prev = sp[sp.season == season - 1].copy()
    prev = prev[prev.position.isin(POS)]
    f = prev[["player_id", "player_display_name", "position", "recent_team", "age", "exp",
              "fpts", "ppg", "games", "tgt_pg", "car_pg", "target_share", "td_luck_pg"]].copy()
    f = f.rename(columns={"recent_team": "team_prev"})
    f["season"] = season

    f = f.merge(piv[["player_id", "season", "trend"]].assign(season=lambda d: d.season + 1),
                on=["player_id", "season"], how="left")

    now = DEPTH[DEPTH.season == season][["player_id", "depth_team", "depth"]]
    was = DEPTH[DEPTH.season == season - 1][["player_id", "depth"]].rename(columns={"depth": "depth_prev"})
    f = f.merge(now, on="player_id", how="left").merge(was, on="player_id", how="left")
    f["climb"] = f.depth_prev - f.depth                       # positive = moved up
    f = f.merge(ROS26.rename(columns={"team_now": "roster_team"}), on="player_id", how="left")
    f["team"] = f.depth_team.fillna(f.roster_team).fillna(f.team_prev)
    f["new_team"] = (f.team != f.team_prev).astype(int)

    f = f.merge(VAC[VAC.season == season][["team", "vac_tgt_share", "vac_car_share", "vac_tgt", "vac_car"]],
                on="team", how="left")
    f = f.merge(COACH[COACH.season == season][["team", "coach_change", "coach"]], on="team", how="left")
    f["coach_change"] = f.coach_change.fillna(False).astype(int)

    s = SOS[SOS.season == season][["team", "position", "sos", "sos_playoff"]]
    f = f.merge(s, on=["team", "position"], how="left")

    nxt = sp[sp.season == season][["player_id", "fpts", "ppg", "games"]]
    nxt.columns = ["player_id", "y_fpts", "y_ppg", "y_games"]
    f = f.merge(nxt, on="player_id", how="left")
    return f


PANEL = pd.concat([build(y) for y in range(2022, 2027)], ignore_index=True)
PANEL.to_parquet("out/breakout_panel.parquet")
print("panel:", len(PANEL), "| 2026 rows:", (PANEL.season == 2026).sum())

print("\n2026 situational changes detected:")
c = PANEL[PANEL.season == 2026]
print(f"  players who changed team: {int(c.new_team.sum())}")
print(f"  teams with a new head coach: {sorted(c[c.coach_change == 1].team.dropna().unique())}")
top_vac = c.dropna(subset=["vac_tgt_share"]).drop_duplicates("team").nlargest(6, "vac_tgt_share")
print("  most vacated target share:", [(r.team, f"{r.vac_tgt_share:.0%}") for _, r in top_vac.iterrows()])
