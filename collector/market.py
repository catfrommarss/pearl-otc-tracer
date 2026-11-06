"""SafeTrade (CEX) PRL price + OTC/CEX spread.

safe.trade runs the Openware/Peatio stack, fully public/no-auth:
  ticker:  /api/v2/peatio/public/markets/pearlusdt/tickers
  k-line:  /api/v2/trade/public/markets/pearlusdt/k-line?period=1440 (daily)
SafeTrade renamed prlusdt -> pearlusdt on 2026-10-18 (prlusdt now 404s).
PRL trades as pearlusdt (USDT); OTC is USDC — treated ~1:1 for the spread.
"""
from __future__ import annotations

import datetime
import time

from common import get

SAFE = "https://safe.trade"
MARKET = "pearlusdt"


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
    now_dt = datetime.datetime.now(datetime.timezone.utc)
    out = {"generated_at": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")}
    try:
        t = get(f"{SAFE}/api/v2/peatio/public/markets/{MARKET}/tickers",
                kind="json", tries=4)
        tk = t.get("ticker", t) if isinstance(t, dict) else {}
        # Peatio puts base-asset (PEARL) 24h volume in `amount` and quote (USDT)
        # turnover in `volume`; fall back to `volume` only if `amount` is absent.
        base_vol = tk.get("amount") if tk.get("amount") is not None else tk.get("volume")
        out["cex"] = {
            "source": "SafeTrade", "pair": "PEARL/USDT",
            "last": _num(tk.get("last")),
            "bid": _num(tk.get("buy")), "ask": _num(tk.get("sell")),
            "high": _num(tk.get("high")), "low": _num(tk.get("low")),
            "vol_24h_prl": _num(base_vol),
            "change_pct": tk.get("price_change_percent"),
        }
    except Exception as e:  # noqa: BLE001
        out["cex"] = None
        out["cex_error"] = str(e)[:120]

    try:
        now_ep = int(time.time())
        k = get(f"{SAFE}/api/v2/trade/public/markets/{MARKET}/k-line"
                f"?period=1440&time_from={now_ep - 120 * 86400}&time_to={now_ep}"
                f"&limit=125", kind="json", tries=3)
        # [[ts,o,h,l,c,v], ...]
        out["cex_daily"] = [[int(c[0]), _num(c[1]), _num(c[2]), _num(c[3]),
                             _num(c[4]), _num(c[5])] for c in k if len(c) >= 6][-120:]
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
