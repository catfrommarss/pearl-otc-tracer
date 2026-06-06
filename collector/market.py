"""SafeTrade (CEX) PRL price + OTC/CEX spread.

safe.trade runs the Openware/Peatio stack, fully public/no-auth:
  ticker:  /api/v2/peatio/public/markets/prlusdt/tickers
  k-line:  /api/v2/trade/public/markets/prlusdt/k-line?period=1440 (daily)
PRL trades as prlusdt (USDT); OTC is USDC — treated ~1:1 for the spread.
"""
from __future__ import annotations

import datetime

from common import get

SAFE = "https://safe.trade"
MARKET = "prlusdt"


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _otc_recent_price(rows, n=25):
    """Median price of the most recent completed OTC trades."""
    ps = []
    for r in sorted(rows, key=lambda r: r.get("time") or "", reverse=True):
        if r.get("status") == "COMPLETED" and r.get("price_per_prl_usdc"):
            ps.append(_num(r["price_per_prl_usdc"]))
        if len(ps) >= n:
            break
    if not ps:
        return None
    ps.sort()
    return ps[len(ps) // 2]


def build_market(rows):
    out = {"generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")}
    try:
        t = get(f"{SAFE}/api/v2/peatio/public/markets/{MARKET}/tickers",
                kind="json", tries=4)
        tk = t.get("ticker", t) if isinstance(t, dict) else {}
        out["cex"] = {
            "source": "SafeTrade", "pair": "PRL/USDT",
            "last": _num(tk.get("last")),
            "bid": _num(tk.get("buy")), "ask": _num(tk.get("sell")),
            "high": _num(tk.get("high")), "low": _num(tk.get("low")),
            "vol_24h_prl": _num(tk.get("volume")),
            "change_pct": tk.get("price_change_percent"),
        }
    except Exception as e:  # noqa: BLE001
        out["cex"] = None
        out["cex_error"] = str(e)[:120]

    try:
        k = get(f"{SAFE}/api/v2/trade/public/markets/{MARKET}/k-line"
                f"?period=1440&limit=120", kind="json", tries=3)
        # [[ts,o,h,l,c,v], ...]
        out["cex_daily"] = [[int(c[0]), _num(c[1]), _num(c[2]), _num(c[3]),
                             _num(c[4]), _num(c[5])] for c in k if len(c) >= 6]
    except Exception:  # noqa: BLE001
        out["cex_daily"] = []

    otc = _otc_recent_price(rows)
    out["otc_recent_price"] = round(otc, 4) if otc else None
    cex_last = (out.get("cex") or {}).get("last")
    if otc and cex_last:
        out["spread_pct"] = round((otc - cex_last) / cex_last * 100, 2)
    else:
        out["spread_pct"] = None
    return out
