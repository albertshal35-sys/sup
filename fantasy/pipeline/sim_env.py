"""Shared setup for the strategy experiments: engine + cached projection boards."""
import pickle, os, warnings
warnings.filterwarnings("ignore")

_src = open("optimize.py").read()


def load(ns):
    """Populate `ns` with the draft engine, Param, run_league, and the boards."""
    head = _src.split("BOARDS = {}")[0]
    tail = _src.split("class Param")[1].split("TUNE = list(range(2014, 2021))")[0]
    exec(head, ns)
    if os.path.exists("out/boards_cache.pkl"):
        c = pickle.load(open("out/boards_cache.pkl", "rb"))
        ns["BOARDS"], ns["WKP"] = c["BOARDS"], c["WKP"]
        print(f"loaded {len(ns['BOARDS'])} cached boards", flush=True)
    else:
        raise SystemExit("run cache_boards.py first")
    exec("class Param" + tail, ns)
    return ns
