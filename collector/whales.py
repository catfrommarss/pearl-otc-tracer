"""Whale / institutional-accumulation detection over OTC trades, enriched
with prlscan on-chain holdings.

Detectors (grounded in the real PRL distribution):
  accumulator  net buy >= 50k PRL and sells negligible (sell_ratio < 0.1)
  whale        net buy >= 200k PRL (tier A)
  silent       >= 5 buys and zero sells (patient DCA)
  absorb       took >= 25% of some ISO-week's total OTC buy volume
  fresh        bought >= 50k PRL within 48h of first OTC appearance
Chain flags (top candidates):
  hodl         external_sent_grains == 0 (never sent value out; cold stack)
  off_otc      on-chain balance >> OTC net-buy and mined == 0 (sourced
               off-desk, e.g. SafeTrade/P2P, and parked)
"""
from __future__ import annotations

import datetime

from enrich import GRAINS
from chain import address_info


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _ep(t):
    if not t:
        return None
    try:
        return int(datetime.datetime.fromisoformat(
            str(t).replace("Z", "+00:00")).timestamp())
    except Exception:  # noqa: BLE001
        return None


def _isoweek(t):
    ep = _ep(t)
    if ep is None:
        return None
    d = datetime.datetime.utcfromtimestamp(ep).isocalendar()
    return f"{d[0]}-W{d[1]:02d}"


def build_whales(rows, identities, enrich_top=50, out_top=150):
    completed = [r for r in rows if r.get("status") == "COMPLETED"]

    agg = {}

    def slot(a):
        return agg.setdefault(a, {
            "address": a, "bought": 0.0, "sold": 0.0, "n_buy": 0, "n_sell": 0,
            "first": None, "last": None, "buys": [], "weeks": {}})

    def touch(s, t):
        if not t:
            return
        if s["first"] is None or t < s["first"]:
            s["first"] = t
        if s["last"] is None or t > s["last"]:
            s["last"] = t

    week_total = {}
    for r in completed:
        prl = _num(r.get("prl_amount"))
        t = r.get("time")
        bp, sp = r.get("buyer_prl"), r.get("seller_prl")
        if bp:
            s = slot(bp)
            s["bought"] += prl
            s["n_buy"] += 1
            s["buys"].append((_ep(t), prl))
            w = _isoweek(t)
            if w:
                s["weeks"][w] = s["weeks"].get(w, 0) + prl
                week_total[w] = week_total.get(w, 0) + prl
            touch(s, t)
        if sp:
            s = slot(sp)
            s["sold"] += prl
            s["n_sell"] += 1
            touch(s, t)

    # market-wide buy concentration
    buys_desc = sorted((s["bought"] for s in agg.values() if s["bought"] > 0),
                       reverse=True)
    total_buy = sum(buys_desc)
    concentration = {
        "total_buy_prl": round(total_buy, 2),
        "n_buyers": len(buys_desc),
        "n_net_buyers": sum(1 for s in agg.values() if s["bought"] - s["sold"] > 0),
        "top5_pct": round(sum(buys_desc[:5]) / total_buy * 100, 1) if total_buy else 0,
        "top10_pct": round(sum(buys_desc[:10]) / total_buy * 100, 1) if total_buy else 0,
    }

    res = []
    for s in agg.values():
        net = s["bought"] - s["sold"]
        if net <= 0:
            continue
        sr = (s["sold"] / s["bought"]) if s["bought"] else 1.0
        flags = []
        if net >= 50000 and sr < 0.1:
            flags.append("accumulator")
        if net >= 200000 and sr < 0.1:
            flags.append("whale")
        if s["n_buy"] >= 5 and s["sold"] == 0:
            flags.append("silent")
        for w, v in s["weeks"].items():
            if week_total.get(w, 0) > 0 and v / week_total[w] >= 0.25:
                flags.append("absorb")
                break
        # fresh whale: >=50k bought within 48h of first buy
        evs = sorted([b for b in s["buys"] if b[0] is not None])
        if evs:
            t0 = evs[0][0]
            within = sum(p for (e, p) in evs if e <= t0 + 48 * 3600)
            if within >= 50000:
                flags.append("fresh")
        res.append({
            "address": s["address"],
            "username": (identities.get(s["address"]) or {}).get("username"),
            "net_prl": round(net, 2),
            "bought_prl": round(s["bought"], 2),
            "sold_prl": round(s["sold"], 2),
            "n_buy": s["n_buy"], "n_sell": s["n_sell"],
            "sell_ratio": round(sr, 3),
            "first": (s["first"] or "")[:10], "last": (s["last"] or "")[:10],
            "flags": flags,
        })

    res.sort(key=lambda x: -x["net_prl"])

    # chain-enrich the top candidates
    for a in res[:enrich_top]:
        info = address_info(a["address"])
        if not info:
            continue
        bal = _num(info.get("balance_grains")) / GRAINS
        ext_sent = _num(info.get("external_sent_grains"))
        mined = _num(info.get("mined_grains"))
        a["chain"] = {
            "balance_prl": round(bal, 2),
            "hodl": ext_sent == 0,
            "off_otc": bal > a["net_prl"] * 1.5 and mined == 0 and bal > 50000,
            "label": info.get("label"),
            "is_miner": mined > 0,
        }
        if a["chain"]["hodl"]:
            a["flags"].append("hodl")
        if a["chain"]["off_otc"]:
            a["flags"].append("off_otc")

    return {"buyers": res[:out_top], "concentration": concentration}
