"""CI gate: print minutes since the last data refresh (generated_at in
docs/data/meta.json), or 9999 when unknown.

The refresh workflow fires every 15 min because GitHub drops most scheduled
triggers on busy public repos; the workflow uses this to skip any scheduled
run that lands within 50 min of the previous refresh."""
import datetime as dt
import json
import os

META = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "docs", "data", "meta.json")

try:
    with open(META, encoding="utf-8") as f:
        g = json.load(f)["generated_at"]
    t = dt.datetime.fromisoformat(g.replace("Z", "+00:00"))
    print(int((dt.datetime.now(dt.timezone.utc) - t).total_seconds() // 60))
except Exception:  # noqa: BLE001 - unknown age → let the run proceed
    print(9999)
