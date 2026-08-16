"""Build every season's projection board once and cache it so the strategy
experiments reuse the work instead of refitting 96 models apiece."""
import pickle, warnings, pandas as pd, numpy as np
warnings.filterwarnings("ignore")
exec(open("optimize.py").read().split("class Param")[0])
pickle.dump({"BOARDS": BOARDS, "WKP": WKP}, open("out/boards_cache.pkl", "wb"))
print("cached", len(BOARDS), "boards")
