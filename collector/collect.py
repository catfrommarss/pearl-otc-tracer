"""Orchestrator: pull OTC data, resolve addresses, emit data/*.json.

Address resolution is cached on disk (data/cache/), so the heavy first
backfill happens once and every later run only resolves new trades.

  python collect.py                 # full list, resolve uncached (default)
  python collect.py --max-pages 1   # quick test: first ~200 trades
  python collect.py --backfill      # alias for full run (explicit in CI)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import otc
from evm import resolve_usdc
from correlate import correlate

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Published JSON lives under docs/ so GitHub Pages (served from /docs) can
# fetch it. The resolution cache stays outside docs/ so it is reused for
# incremental runs without bloating the published site.
DATA = os.path.join(ROOT, "docs", "data")
PEARL_CACHE = os.path.join(ROOT, "cache", "pearl")
EVM_CACHE = os.path.join(ROOT, "cache", "evm")


def _write(name, obj):
    os.makedirs(DATA, exist_ok=True)
    p = os.path.join(DATA, name)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, p)


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def build_addresses(rows: list[dict]) -> list[dict]:
    """Aggregate per-address buy/sell totals across both legs."""
    agg: dict[str, dict] = {}

    def slot(addr, chain, network=None):
        a = agg.get(addr)
        if a is None:
            a = agg[addr] = {
                "address": addr, "chain": chain, "network": network,
                "sold_prl": 0.0, "bought_prl": 0.0,
                "recv_usdc": 0.0, "paid_usdc": 0.0,
                "n_sell": 0, "n_buy": 0, "trades": [],
                "counterparties": {}, "linked": {},
                "first_seen": None, "last_seen": None,
            }
        return a

    def touch(a, t):
        if t:
            if a["first_seen"] is None or t < a["first_seen"]:
                a["first_seen"] = t
            if a["last_seen"] is None or t > a["last_seen"]:
                a["last_seen"] = t

    for r in rows:
        prl = _num(r.get("prl_amount"))
        usdc = _num(r.get("usdc_amount"))
        t = r.get("time")
        tid = r.get("id")
        sp, se = r.get("seller_prl"), r.get("seller_evm")
        bp, be = r.get("buyer_prl"), r.get("buyer_evm")

        sellers = [(sp, "pearl"), (se, "evm")]
        buyers = [(bp, "pearl"), (be, "evm")]

        for addr, chain in sellers:
            if not addr:
                continue
            a = slot(addr, chain, r.get("network") if chain == "evm" else None)
            a["sold_prl"] += prl
            a["recv_usdc"] += usdc
            a["n_sell"] += 1
            if tid not in a["trades"]:
                a["trades"].append(tid)
            touch(a, t)
            for c, _ in buyers:
                if c:
                    a["counterparties"][c] = a["counterparties"].get(c, 0) + 1
            for c, _ in sellers:
                if c and c != addr:
                    a["linked"][c] = a["linked"].get(c, 0) + 1

        for addr, chain in buyers:
            if not addr:
                continue
            a = slot(addr, chain, r.get("network") if chain == "evm" else None)
            a["bought_prl"] += prl
            a["paid_usdc"] += usdc
            a["n_buy"] += 1
            if tid not in a["trades"]:
                a["trades"].append(tid)
            touch(a, t)
            for c, _ in sellers:
                if c:
                    a["counterparties"][c] = a["counterparties"].get(c, 0) + 1
            for c, _ in buyers:
                if c and c != addr:
                    a["linked"][c] = a["linked"].get(c, 0) + 1

    out = []
    for a in agg.values():
        cps = sorted(a["counterparties"].items(), key=lambda kv: -kv[1])
        a["counterparties"] = [{"address": k, "trades": v} for k, v in cps[:50]]
        a["linked"] = [{"address": k, "trades": v}
                       for k, v in sorted(a["linked"].items(),
                                          key=lambda kv: -kv[1])[:10]]
        a["n_trades"] = len(a["trades"])
        if len(a["trades"]) > 500:
            a["trades"] = a["trades"][:500]
        for k in ("sold_prl", "bought_prl", "recv_usdc", "paid_usdc"):
            a[k] = round(a[k], 6)
        a["volume_prl"] = round(a["sold_prl"] + a["bought_prl"], 6)
        out.append(a)
    out.sort(key=lambda x: -x["volume_prl"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-pages", type=int, default=None,
                    help="limit OTC pages (200 trades each) for testing")
    ap.add_argument("--backfill", action="store_true",
                    help="explicit full run (same as no --max-pages)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    t0 = time.time()
    print("fetching OTC trades ...", flush=True)
    trades = otc.settled_trades(max_pages=args.max_pages)
    print(f"  {len(trades)} trades", flush=True)

    aux = {}
    for name, fn in (("prices", otc.public_prices), ("stats", otc.stats),
                     ("public_stats", lambda: otc.public_stats(30)),
                     ("offers", otc.offers), ("health", otc.health)):
        try:
            aux[name] = fn()
        except Exception as e:  # noqa: BLE001 - aux data is best-effort
            print(f"  WARN {name}: {e}", flush=True)
            aux[name] = None

    os.makedirs(PEARL_CACHE, exist_ok=True)
    os.makedirs(EVM_CACHE, exist_ok=True)

    def resolver(h, net, amt):
        return resolve_usdc(h, net, amt, EVM_CACHE)

    def work(tr):
        return correlate(tr, PEARL_CACHE, resolver)

    rows = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for row in ex.map(work, trades):
            rows.append(row)
            done += 1
            if done % 100 == 0:
                print(f"  resolved {done}/{len(trades)} "
                      f"({time.time()-t0:.0f}s)", flush=True)

    rows.sort(key=lambda r: (r.get("id") or 0), reverse=True)
    addresses = build_addresses(rows)

    res = {"deposit": 0, "release": 0, "refund": 0, "evm": 0,
           "both_sides": 0}
    for r in rows:
        for k in ("deposit", "release", "refund", "evm"):
            if r["resolved"].get(k):
                res[k] += 1
        if (r.get("seller_prl") or r.get("seller_evm")) and \
           (r.get("buyer_prl") or r.get("buyer_evm")):
            res["both_sides"] += 1

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trades": len(rows),
        "unique_addresses": len(addresses),
        "resolution": res,
        "elapsed_s": round(time.time() - t0, 1),
        "otc_stats": aux.get("stats"),
        "public_stats": aux.get("public_stats"),
        "health": aux.get("health"),
        "active_offers": len(aux["offers"]) if aux.get("offers") else 0,
    }

    _write("trades.json", rows)
    _write("addresses.json", addresses)
    _write("prices.json", aux.get("prices") or [])
    _write("offers.json", aux.get("offers") or [])
    _write("stats.json", aux.get("stats") or {})
    _write("meta.json", meta)

    print(json.dumps(meta, indent=1), flush=True)
    print(f"done in {time.time()-t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
