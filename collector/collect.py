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
    """Per-address rollups, chain-aware.

    PRL flows are only meaningful on Pearl addresses, USDC flows only on
    EVM addresses — a single trade contributes the SAME prl_amount once to
    a Pearl-side address (sold_prl OR bought_prl) and the SAME usdc_amount
    once to an EVM-side address. Adding both to both legs (an earlier bug)
    doubled every aggregate and gave EVM addresses a meaningless PRL
    balance (and vice versa).
    """
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
            if chain == "pearl":
                a["sold_prl"] += prl              # PRL only on Pearl side
            else:
                a["recv_usdc"] += usdc            # USDC only on EVM side
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
            if chain == "pearl":
                a["bought_prl"] += prl
            else:
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
        # counterparties capped at 25 (frontend renders top 20 — was 50
        # which doubled file size for unused tail). linked capped at 50
        # (was 10, but high-frequency addresses can legitimately have
        # 40+ funding wallets, especially big EVM market makers paired
        # against one-shot PRL escrow change addresses).
        cps = sorted(a["counterparties"].items(), key=lambda kv: -kv[1])
        a["counterparties"] = [{"address": k, "trades": v} for k, v in cps[:25]]
        a["linked"] = [{"address": k, "trades": v}
                       for k, v in sorted(a["linked"].items(),
                                          key=lambda kv: -kv[1])[:50]]
        a["n_trades"] = len(a["trades"])
        if len(a["trades"]) > 500:
            a["trades"] = a["trades"][:500]
        for k in ("sold_prl", "bought_prl", "recv_usdc", "paid_usdc"):
            a[k] = round(a[k], 6)
        # chain-appropriate volume: PRL for pearl addresses, USDC for EVM.
        a["volume_prl"] = round(a["sold_prl"] + a["bought_prl"], 6)
        a["volume_usdc"] = round(a["recv_usdc"] + a["paid_usdc"], 6)
        out.append(a)
    # sort by chain-relevant volume so each chain's biggest float to top
    out.sort(key=lambda x: -(x["volume_prl"] if x["chain"] == "pearl"
                              else x["volume_usdc"]))
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

    # Derive resolution metrics straight from output fields (the old per-
    # row `resolved` dict and `flags` array were dropped for size).
    res = {
        "pearl_resolved": sum(1 for r in rows
                              if r.get("seller_prl") or r.get("escrow_prl")),
        "evm_resolved":   sum(1 for r in rows if r.get("buyer_evm")),
        "both_sides":     sum(1 for r in rows
                              if (r.get("seller_prl") or r.get("seller_evm"))
                              and (r.get("buyer_prl") or r.get("buyer_evm"))),
        # all four legs present — the honest "fully traced" rate
        "fully_traced":   sum(1 for r in rows
                              if r.get("seller_prl") and r.get("seller_evm")
                              and r.get("buyer_prl") and r.get("buyer_evm")),
    }

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
    # offers.json / stats.json removed: frontend never read them; offers
    # count lives in meta.active_offers and stats lives in meta.otc_stats.
    _write("meta.json", meta)

    print(json.dumps(meta, indent=1), flush=True)
    print(f"done in {time.time()-t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
