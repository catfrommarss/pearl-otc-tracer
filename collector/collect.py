"""Orchestrator: pull OTC data, resolve addresses, emit data/*.json.

Address resolution is cached on disk (data/cache/), so the heavy first
backfill happens once and every later run only resolves new trades.

  python collect.py                 # full list, resolve uncached (default)
  python collect.py --max-pages 1   # quick test: first ~200 trades
  python collect.py --backfill      # alias for full run (explicit in CI)
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import otc
import enrich
from evm import resolve_usdc, usdc_match
from correlate import correlate

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Published JSON lives under docs/ so GitHub Pages (served from /docs) can
# fetch it. The resolution cache stays outside docs/ so it is reused for
# incremental runs without bloating the published site.
DATA = os.path.join(ROOT, "docs", "data")
PEARL_CACHE = os.path.join(ROOT, "cache", "pearl")
EVM_CACHE = os.path.join(ROOT, "cache", "evm")
IDENTITIES_CACHE = os.path.join(ROOT, "cache", "identities.json")
PRL_TXS_CACHE = os.path.join(ROOT, "cache", "prl_txs")     # prlscan tx cache
EVM_MATCH_CACHE = os.path.join(ROOT, "cache", "evm_match")  # usdc amount+time


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


_ID_KEEP = ("username", "trust_tier", "trust_score", "trades_completed",
            "trades_cancelled", "total_usdc_volume_traded", "is_trusted",
            "last_active_at")


def build_identities(offers, addresses):
    """Map addresses -> pearl-otc usernames (+ reputation), add-only.

    The only public bridge from an address to a username is an active
    offer's seller_prl_refund_address (the user's main PRL address). We
    accumulate these across runs in cache/identities.json so coverage
    grows as offers rotate, refresh reputation for every known user, and
    emit docs/data/identities.json containing just the precise-match
    addresses that actually appear in our addresses.json.
    Returns (published_map, total_accumulated).
    """
    acc = {}
    if os.path.exists(IDENTITIES_CACHE):
        try:
            with open(IDENTITIES_CACHE, encoding="utf-8") as f:
                acc = json.load(f)
        except Exception:  # noqa: BLE001 - corrupt cache, rebuild
            acc = {}

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for o in (offers or []):
        addr = o.get("seller_prl_refund_address")
        uid = o.get("user_id")
        if not addr or uid is None:
            continue
        rec = acc.get(addr) or {}
        rec["user_id"] = uid
        rec.setdefault("first_seen", now)
        rec["seen_at"] = now
        acc[addr] = rec

    uids = sorted({r.get("user_id") for r in acc.values()
                   if r.get("user_id") is not None})
    rep = {}
    if uids:
        for u in otc.reputation_bulk(uids):
            if u.get("user_id") is not None:
                rep[u["user_id"]] = u
    for rec in acc.values():
        u = rep.get(rec.get("user_id"))
        if u:
            for k in _ID_KEEP:
                if u.get(k) is not None:
                    rec[k] = u[k]

    os.makedirs(os.path.dirname(IDENTITIES_CACHE), exist_ok=True)
    tmp = IDENTITIES_CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(acc, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, IDENTITIES_CACHE)

    our = {a["address"] for a in addresses}
    pub = {}
    for addr, rec in acc.items():
        if addr in our and rec.get("username"):
            pub[addr] = {k: rec[k] for k in (("user_id",) + _ID_KEEP)
                         if k in rec}
    return pub, len(acc)


ISO = "%Y-%m-%dT%H:%M:%SZ"


def _read_json(name, default):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001
            return default
    return default


def _iso_to_epoch(s):
    if not s:
        return None
    try:
        return int(datetime.datetime.fromisoformat(
            s.replace("Z", "+00:00")).timestamp())
    except Exception:  # noqa: BLE001
        return None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def live_to_row(s):
    """Shape a thin settlement-feed record into a trade-like row.

    The redesigned feed only carries time / maker(username) / prl / usdc /
    price — no id, status, side, network, addresses, or tx hashes. We mark
    it source:"live" and leave the untraceable fields null so the frontend
    renders it as an untraced settlement carrying just the maker name."""
    t = s.get("time")
    return {
        "id": "L" + (t or ""),
        "source": "live",
        "time": t,
        "status": "COMPLETED",
        "maker_username": s.get("maker"),
        "maker_side": None,
        "network": None,
        "prl_amount": s.get("prl"),
        "usdc_amount": s.get("usdc"),
        "price_per_prl_usdc": s.get("price"),
        "fee_prl": None,
        "seller_prl": None, "seller_evm": None,
        "buyer_prl": None, "buyer_evm": None,
        "escrow_prl": None,
        "deposit_txid": None, "release_txid": None,
        "refund_txid": None, "usdc_tx_hash": None,
    }


def enrich_live(live_rows):
    """Recover buyer/seller addresses for live rows (post-redesign).

    PRL leg (authoritative): match to the OTC fee-address funnel on prlscan
    by exact gross amount + nearest time → seller_prl / buyer_prl.
    USDC leg (heuristic): global amount+time match on Arbitrum, accepted
    only when the candidate is UNIQUE (round amounts collide, so a
    non-unique window would risk a wrong attribution). Everything attached
    here is flagged inferred:true so the UI can mark it as reconstructed
    rather than reported by the platform."""
    todo = [r for r in live_rows if not r.get("seller_prl")]
    if not todo:
        return
    os.makedirs(PRL_TXS_CACHE, exist_ok=True)
    os.makedirs(EVM_MATCH_CACHE, exist_ok=True)
    since = min(_iso_to_epoch(r["time"]) or 0 for r in todo) - 3600
    print(f"  enriching {len(todo)} live rows (PRL funnel since {since}) ...",
          flush=True)
    by_grains, _ = enrich.build_pearl_index(since, PRL_TXS_CACHE)

    prl_ok = evm_ok = 0
    for r in todo:
        ep = _iso_to_epoch(r.get("time"))
        # --- PRL leg: exact gross grains + nearest time within 30 min ---
        g = round(_num(r.get("prl_amount")) * enrich.GRAINS)
        best, bd = None, 10 ** 9
        for c in by_grains.get(g, []):
            if c.get("time") is None:
                continue
            d = abs(c["time"] - (ep or 0))
            if d < bd:
                bd, best = d, c
        if best and bd <= 1800 and best.get("seller_prl") and best.get("buyer_prl"):
            r["seller_prl"] = best["seller_prl"]
            r["buyer_prl"] = best["buyer_prl"]
            r["escrow_prl"] = best.get("escrow_prl")
            r["release_txid"] = best.get("release_txid")
            r["deposit_txid"] = best.get("deposit_txid")
            r["inferred"] = True
            prl_ok += 1
        # --- USDC leg: unique-candidate global match only ---
        try:
            m = usdc_match(r.get("network") or "ARBITRUM",
                           r.get("usdc_amount"), ep, EVM_MATCH_CACHE)
        except Exception:  # noqa: BLE001
            m = None
        if m and m.get("n_candidates") == 1:
            r["seller_evm"] = m["seller_evm"]
            r["buyer_evm"] = m["buyer_evm"]
            r["usdc_token"] = m.get("token")
            r["inferred"] = True
            evm_ok += 1
    print(f"  enriched PRL {prl_ok}/{len(todo)} · USDC(unique) {evm_ok}/{len(todo)}",
          flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-pages", type=int, default=None, help="(unused)")
    ap.add_argument("--backfill", action="store_true", help="(unused)")
    ap.add_argument("--workers", type=int, default=6, help="(unused)")
    ap.parse_args()

    t0 = time.time()

    # The rich api.pearl-otc.com backend is retired (502). We freeze the
    # historical address-traced rows already in trades.json and only
    # ingest the new thin settlement feed going forward.
    existing = _read_json("trades.json", [])
    for r in existing:
        r.setdefault("source", "archive")
    archive = [r for r in existing if r.get("source") != "live"]
    prev_live = [r for r in existing if r.get("source") == "live"]
    since = max((r["time"] for r in existing if r.get("time")), default=None)
    print(f"archive={len(archive)} prev_live={len(prev_live)} since={since}",
          flush=True)

    print("fetching live settlements ...", flush=True)
    try:
        fresh = otc.live_settlements(since_iso=since)
    except Exception as e:  # noqa: BLE001 - keep last good data on failure
        print(f"  WARN live feed failed: {e}", flush=True)
        fresh = []
    print(f"  {len(fresh)} new settlements", flush=True)

    # Content key at second precision (the archive stored microseconds, the
    # live feed milliseconds, so the boundary settlement would otherwise
    # appear twice). Used to keep live rows from duplicating archive ones.
    def ckey(r):
        return (_iso_to_epoch(r.get("time")),
                round(_num(r.get("prl_amount")), 2),
                round(_num(r.get("usdc_amount")), 2))
    arch_keys = {ckey(r) for r in archive if r.get("time")}

    # Merge live rows (previous + fresh), dedupe within live and vs archive.
    live_by_key = {}
    for r in prev_live:
        if ckey(r) not in arch_keys:
            live_by_key[ckey(r)] = r
    for s in fresh:
        row = live_to_row(s)
        k = ckey(row)
        if k not in arch_keys:
            live_by_key[k] = row
    live_rows = list(live_by_key.values())

    # Recover addresses for live rows the redesign stripped of tx hashes.
    # Best-effort + cached: a prlscan / RPC outage must not crash refresh.
    try:
        enrich_live(live_rows)
    except Exception as e:  # noqa: BLE001
        print(f"  WARN enrichment failed: {e}", flush=True)

    rows = archive + live_rows
    rows.sort(key=lambda r: (r.get("time") or ""), reverse=True)

    # Addresses come only from archive rows (live rows have none), so this
    # rebuild reproduces the frozen archive aggregation.
    addresses = build_addresses(rows)
    # Identities depended on the now-dead offers/reputation endpoints —
    # preserve the committed mapping as-is.
    identities = _read_json("identities.json", {})

    completed = [r for r in rows if r.get("status") == "COMPLETED"]
    latest_ep = max((_iso_to_epoch(r.get("time")) or 0 for r in rows),
                    default=0)
    cut24 = latest_ep - 86400
    otc_stats = {
        "total_volume_prl": round(sum(_num(r.get("prl_amount")) for r in completed), 2),
        "total_volume_usdc": round(sum(_num(r.get("usdc_amount")) for r in completed), 2),
        "total_trades_completed": len(completed),
        "volume_24h_prl": round(sum(_num(r.get("prl_amount")) for r in completed
                                    if (_iso_to_epoch(r.get("time")) or 0) >= cut24), 2),
        "trades_24h": sum(1 for r in completed
                          if (_iso_to_epoch(r.get("time")) or 0) >= cut24),
    }

    # Extend the price series from new live settlements (old /public-prices
    # is dead, but every live settlement carries a price).
    prices = _read_json("prices.json", [])
    seen_t = {p.get("t") for p in prices}
    for r in live_rows:
        ep = _iso_to_epoch(r.get("time"))
        pr = _num(r.get("price_per_prl_usdc"))
        if ep and pr and ep not in seen_t:
            prices.append({"t": ep, "p": pr})
            seen_t.add(ep)
    prices.sort(key=lambda x: x.get("t") or 0)

    res = {
        "fully_traced": sum(1 for r in rows
                            if r.get("seller_prl") and r.get("seller_evm")
                            and r.get("buyer_prl") and r.get("buyer_evm")),
    }
    meta = {
        "generated_at": time.strftime(ISO, time.gmtime()),
        "trades": len(rows),
        "archive_rows": len(archive),
        "live_rows": len(live_rows),
        "unique_addresses": len(addresses),
        "named_addresses": len(identities),
        "resolution": res,
        "otc_stats": otc_stats,
        "data_source": {
            "archive_until": max((r["time"] for r in archive if r.get("time")),
                                 default=None),
            "live_from": min((r["time"] for r in live_rows if r.get("time")),
                             default=None),
            "note": ("OTC 改版(2026-06)后公开接口移除了交易哈希："
                     "archive 为平台直接提供哈希的历史存档；live 为改版后新成交，"
                     "其地址由本工具链上反查恢复（PRL 经 prlscan 费用漏斗、"
                     "USDC 按金额+时间唯一匹配），标记为 inferred。"),
        },
        "elapsed_s": round(time.time() - t0, 1),
    }

    _write("trades.json", rows)
    _write("addresses.json", addresses)
    _write("identities.json", identities)
    _write("prices.json", prices)
    _write("meta.json", meta)

    print(json.dumps(meta, indent=1, ensure_ascii=False), flush=True)
    print(f"done in {time.time()-t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
