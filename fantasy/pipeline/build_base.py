"""Stage 1: load every nflverse season (1999-2025), apply league scoring, build the
player-season and team-season fantasy tables everything else is derived from."""
import pandas as pd, numpy as np, glob, os, json

DATA = "data"
SEASONS = list(range(1999, 2026))

# ---------------------------------------------------------------- league rules
# PPR. 2QB / 2RB / 3WR / 1TE / 1FLEX(RB,WR,TE) / DST / K, 6 bench.
SCORING = dict(
    pass_yd=0.04, pass_td=4.0, interception=-2.0, pass_2pt=2.0,
    rush_yd=0.10, rush_td=6.0, rush_2pt=2.0,
    rec=1.0, rec_yd=0.10, rec_td=6.0, rec_2pt=2.0,
    fumble_lost=-2.0,
    fg_0_39=3.0, fg_40_49=4.0, fg_50p=5.0, fg_miss=-1.0, pat=1.0, pat_miss=-1.0,
    dst_sack=1.0, dst_int=2.0, dst_fum_rec=2.0, dst_td=6.0, dst_safety=2.0,
)
PA_TIERS = [(0, 10), (6, 7), (13, 4), (20, 1), (27, 0), (34, -1), (999, -4)]


def pa_points(pa):
    for cap, pts in PA_TIERS:
        if pa <= cap:
            return pts
    return -4


def num(df, col):
    return pd.to_numeric(df.get(col), errors="coerce").fillna(0.0) if col in df.columns else pd.Series(0.0, index=df.index)


# ---------------------------------------------------------------- player seasons
frames = []
for y in SEASONS:
    f = f"{DATA}/sp_{y}.csv"
    if not os.path.exists(f):
        continue
    d = pd.read_csv(f, low_memory=False)
    d["season"] = y
    frames.append(d)
sp = pd.concat(frames, ignore_index=True)
print("raw player-seasons:", len(sp))

S = SCORING
sp["fum_lost"] = num(sp, "sack_fumbles_lost") + num(sp, "rushing_fumbles_lost") + num(sp, "receiving_fumbles_lost")
sp["pts_pass"] = num(sp, "passing_yards") * S["pass_yd"] + num(sp, "passing_tds") * S["pass_td"] \
    + num(sp, "passing_interceptions") * S["interception"] + num(sp, "passing_2pt_conversions") * S["pass_2pt"]
sp["pts_rush"] = num(sp, "rushing_yards") * S["rush_yd"] + num(sp, "rushing_tds") * S["rush_td"] \
    + num(sp, "rushing_2pt_conversions") * S["rush_2pt"]
sp["pts_rec"] = num(sp, "receptions") * S["rec"] + num(sp, "receiving_yards") * S["rec_yd"] \
    + num(sp, "receiving_tds") * S["rec_td"] + num(sp, "receiving_2pt_conversions") * S["rec_2pt"]
fg_short = num(sp, "fg_made_0_19") + num(sp, "fg_made_20_29") + num(sp, "fg_made_30_39")
fg_mid = num(sp, "fg_made_40_49")
fg_long = num(sp, "fg_made_50_59") + num(sp, "fg_made_60_")
fg_missed = num(sp, "fg_missed")
sp["pts_k"] = fg_short * S["fg_0_39"] + fg_mid * S["fg_40_49"] + fg_long * S["fg_50p"] \
    + fg_missed * S["fg_miss"] + num(sp, "pat_made") * S["pat"] + num(sp, "pat_missed") * S["pat_miss"]
sp["pts_st"] = num(sp, "special_teams_tds") * 6.0

off = sp["pts_pass"] + sp["pts_rush"] + sp["pts_rec"] + sp["fum_lost"] * S["fumble_lost"] + sp["pts_st"]
sp["fpts"] = np.where(sp["position"] == "K", sp["pts_k"], off)

POS = ["QB", "RB", "WR", "TE", "K"]
sp = sp[sp["position"].isin(POS)].copy()
sp["games"] = pd.to_numeric(sp["games"], errors="coerce").fillna(0)
sp = sp[sp["games"] > 0].copy()
sp["ppg"] = sp["fpts"] / sp["games"]

# usage / efficiency features used by every downstream model
sp["targets"] = num(sp, "targets"); sp["carries"] = num(sp, "carries")
sp["touches"] = sp["targets"] + sp["carries"]
sp["tgt_pg"] = sp["targets"] / sp["games"]
sp["car_pg"] = sp["carries"] / sp["games"]
sp["touch_pg"] = sp["touches"] / sp["games"]
sp["rec_pg"] = num(sp, "receptions") / sp["games"]
sp["ryd_pg"] = num(sp, "receiving_yards") / sp["games"]
sp["rushyd_pg"] = num(sp, "rushing_yards") / sp["games"]
sp["ayd_pg"] = num(sp, "receiving_air_yards") / sp["games"]
sp["td_total"] = num(sp, "rushing_tds") + num(sp, "receiving_tds") + num(sp, "passing_tds")
sp["td_pg"] = sp["td_total"] / sp["games"]
sp["yac_pg"] = num(sp, "receiving_yards_after_catch") / sp["games"]
sp["fd_pg"] = (num(sp, "receiving_first_downs") + num(sp, "rushing_first_downs")) / sp["games"]
sp["expl_pg"] = (num(sp, "receiving_20") + num(sp, "rushing_20")) / sp["games"]
sp["target_share"] = num(sp, "target_share")
sp["air_yards_share"] = num(sp, "air_yards_share")
sp["wopr"] = num(sp, "wopr")
sp["racr"] = num(sp, "racr")
sp["epa_rush"] = num(sp, "rushing_epa"); sp["epa_rec"] = num(sp, "receiving_epa")
sp["epa_pass"] = num(sp, "passing_epa"); sp["cpoe"] = num(sp, "passing_cpoe")
sp["pass_att_pg"] = num(sp, "attempts") / sp["games"]
sp["pass_yd_pg"] = num(sp, "passing_yards") / sp["games"]
sp["rush_att_qb_pg"] = np.where(sp["position"] == "QB", sp["car_pg"], 0.0)
sp["ypt"] = np.where(sp["targets"] > 0, num(sp, "receiving_yards") / sp["targets"], 0)
sp["ypc"] = np.where(sp["carries"] > 0, num(sp, "rushing_yards") / sp["carries"], 0)
sp["td_rate"] = np.where(sp["touches"] > 0, (num(sp, "rushing_tds") + num(sp, "receiving_tds")) / sp["touches"], 0)
sp["catch_rate"] = np.where(sp["targets"] > 0, num(sp, "receptions") / sp["targets"], 0)
sp["adot"] = np.where(sp["targets"] > 0, num(sp, "receiving_air_yards") / sp["targets"], 0)

# nflverse did not populate targets / air yards for 2003-2008. Blank them out so
# models see "missing" instead of a fake zero.
TGT_DEAD = set(range(2003, 2009))
TGT_COLS = ["targets", "tgt_pg", "touch_pg", "touches", "target_share", "air_yards_share",
            "wopr", "racr", "ayd_pg", "adot", "catch_rate", "ypt", "td_rate"]
dead = sp["season"].isin(TGT_DEAD)
for c in TGT_COLS:
    if c in sp.columns:
        sp.loc[dead, c] = np.nan
# air yards only exist from 2009 on
sp.loc[sp["season"] < 2009, ["ayd_pg", "adot", "air_yards_share", "wopr", "racr"]] = np.nan

# ---------------------------------------------------------------- age
pl = pd.read_csv(f"{DATA}/players.csv", low_memory=False)
idcol = "gsis_id" if "gsis_id" in pl.columns else "player_id"
bd = pl[[idcol, "birth_date"]].dropna().drop_duplicates(subset=[idcol])
bd.columns = ["player_id", "birth_date"]
bd["birth_date"] = pd.to_datetime(bd["birth_date"], errors="coerce")
sp = sp.merge(bd, on="player_id", how="left")
sp["age"] = (pd.to_datetime(sp["season"].astype(str) + "-09-01") - sp["birth_date"]).dt.days / 365.25

# rookie year / experience from draft data
dp = pd.read_csv(f"{DATA}/draft_picks.csv", low_memory=False)
dcols = {c.lower(): c for c in dp.columns}
gid = dcols.get("gsis_id")
dsub = dp[[gid, "season", "round", "pick"]].dropna(subset=[gid]).drop_duplicates(subset=[gid])
dsub.columns = ["player_id", "draft_year", "draft_round", "draft_pick"]
sp = sp.merge(dsub, on="player_id", how="left")
sp["exp"] = sp["season"] - sp["draft_year"]

# ---------------------------------------------------------------- team DST seasons
tframes = []
for y in SEASONS:
    f = f"{DATA}/st_{y}.csv"
    if not os.path.exists(f):
        continue
    d = pd.read_csv(f, low_memory=False)
    d["season"] = y
    tframes.append(d)
st = pd.concat(tframes, ignore_index=True)

games = pd.read_csv(f"{DATA}/games.csv", low_memory=False)
g = games[games["game_type"] == "REG"].copy()
a = g[["season", "away_team", "home_score"]].rename(columns={"away_team": "team", "home_score": "pa"})
h = g[["season", "home_team", "away_score"]].rename(columns={"home_team": "team", "away_score": "pa"})
pa = pd.concat([a, h], ignore_index=True).dropna()
pa["pa_pts"] = pa["pa"].apply(pa_points)
pa_agg = pa.groupby(["season", "team"]).agg(pa_total=("pa", "sum"), pa_pts=("pa_pts", "sum"),
                                            gp=("pa", "size")).reset_index()

st["dst_raw"] = num(st, "def_sacks") * S["dst_sack"] + num(st, "def_interceptions") * S["dst_int"] \
    + num(st, "fumble_recovery_opp") * S["dst_fum_rec"] + num(st, "def_tds") * S["dst_td"] \
    + num(st, "def_safeties") * S["dst_safety"] + num(st, "special_teams_tds") * 6.0
dst = st[["season", "team", "dst_raw", "def_sacks", "def_interceptions", "def_tds"]].merge(
    pa_agg, on=["season", "team"], how="inner")
dst["fpts"] = dst["dst_raw"] + dst["pa_pts"]
dst["ppg"] = dst["fpts"] / dst["gp"]
dst["position"] = "DST"

os.makedirs("out", exist_ok=True)
sp.to_parquet("out/player_seasons.parquet")
dst.to_parquet("out/dst_seasons.parquet")

print("scored player-seasons:", len(sp), "| seasons:", sp.season.min(), "-", sp.season.max())
print(sp.groupby("position").size().to_dict())
print("\nTop 2025 by position (sanity check):")
for p in ["QB", "RB", "WR", "TE", "K"]:
    t = sp[(sp.season == 2025) & (sp.position == p)].nlargest(3, "fpts")
    for _, r in t.iterrows():
        print(f"  {p} {r.player_display_name:24s} {r.fpts:6.1f} pts  {r.games:2.0f}g  {r.ppg:5.2f} ppg")
t = dst[dst.season == 2025].nlargest(3, "fpts")
print("  DST:", [(r.team, round(r.fpts, 1)) for _, r in t.iterrows()])
