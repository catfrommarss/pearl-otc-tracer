"""Whale / institutional-accumulation detection over OTC trades, enriched
with prlscan on-chain holdings.

Detectors (grounded in the real PRL distribution):
  accumulator  net buy >= 50k PRL and sells negligible (sell_ratio < 0.1)
  whale        net buy >= 200k PRL (tier A)
  silent       >= 5 buys and zero sells (patient DCA)
  absorb       took >= 25% of some ISO-week's total OTC buy volume
  fresh        bought >= 50k PRL within 48h of first OTC appearance
Chain flags (top candidates), at ENTITY level (own addr + co-spend
partners + detected cold wallets, see cluster.py):
  hodl         value never left the entity (no external sends, or the big
               sends all went to the entity's own cold wallets)
  off_otc      entity holdings >> OTC net-buy and mined == 0 (sourced
               off-desk, e.g. SafeTrade/P2P, and parked)
"""
from __future__ import annotations

import datetime
import re

from enrich import GRAINS, FEE_ADDR
from chain import address_info
from cluster import cluster_entity


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


# Analyst naming convention for sub-wallets of one entity: "<entity>-0x<hex>"
# (e.g. "FalconX集群-0x735", "FalconX集群-0x15a"). The board rolls these up
# into "<entity>"; the flow graph keeps them as separate labeled nodes.
_SUBWALLET = re.compile(r"^(.+?)-0x[0-9a-fA-F]{2,}$")


def _group(label):
    m = _SUBWALLET.match(label or "")
    return m.group(1) if m else label


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


def build_whales(rows, identities, enrich_top=50, out_top=150,
                 entities=None, tx_cache=None, cluster_top=25, labels=None):
    """labels: addr -> analyst label (docs/data/labels.json). Addresses that
    share a label are ONE entity on the board: a trade's buyer is keyed by
    the label of its Pearl OR EVM address, so a cluster's sub-wallets (e.g.
    five FalconX deposit wallets, each with its own PRL receive address)
    roll up into a single row with pooled net-buy and pooled holdings."""
    completed = [r for r in rows if r.get("status") == "COMPLETED"]
    labels = labels or {}

    agg = {}

    def ekey(prl, evm):
        lab = labels.get(prl) or labels.get(evm)
        if lab:
            return "lbl:" + _group(lab)
        return prl        # unlabeled: keyed by Pearl address (None = skip)

    def slot(k):
        s = agg.get(k)
        if s is None:
            s = agg[k] = {
                "address": k if not k.startswith("lbl:") else None,
                "label": k[4:] if k.startswith("lbl:") else None,
                "members": {},        # addr -> trade count (label entities)
                "bought": 0.0, "sold": 0.0, "n_buy": 0, "n_sell": 0,
                "first": None, "last": None, "buys": [], "weeks": {}}
        return s

    def member(s, *addrs):
        if s["label"] is None:
            return
        for a in addrs:
            if a:
                s["members"][a] = s["members"].get(a, 0) + 1

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
        bp, be = r.get("buyer_prl"), r.get("buyer_evm")
        sp, se = r.get("seller_prl"), r.get("seller_evm")
        bk, sk = ekey(bp, be), ekey(sp, se)
        if bk:
            s = slot(bk)
            member(s, bp, be)
            s["bought"] += prl
            s["n_buy"] += 1
            s["buys"].append((_ep(t), prl))
            w = _isoweek(t)
            if w:
                s["weeks"][w] = s["weeks"].get(w, 0) + prl
                week_total[w] = week_total.get(w, 0) + prl
            touch(s, t)
        if sk:
            s = slot(sk)
            member(s, sp, se)
            s["sold"] += prl
            s["n_sell"] += 1
            touch(s, t)

    # label entities: the primary address (for linking / chain enrichment)
    # is the busiest Pearl member, else the busiest member of any chain
    for s in agg.values():
        if s["label"] is not None:
            ms = sorted(s["members"].items(), key=lambda kv: -kv[1])
            prl_ms = [a for a, _ in ms if a.startswith("prl1")]
            s["address"] = prl_ms[0] if prl_ms else (ms[0][0] if ms else None)

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
        if not s["address"]:
            continue
        uname = (identities.get(s["address"]) or {}).get("username")
        if not uname and s["label"] is not None:
            for m in s["members"]:
                uname = (identities.get(m) or {}).get("username")
                if uname:
                    break
        res.append({
            "address": s["address"],
            "username": uname,
            "label": s["label"],
            "members": [a for a, _ in sorted(s["members"].items(),
                                             key=lambda kv: -kv[1])[:20]]
                       if s["label"] is not None else None,
            "n_members": len(s["members"]) if s["label"] is not None else None,
            "net_prl": round(net, 2),
            "bought_prl": round(s["bought"], 2),
            "sold_prl": round(s["sold"], 2),
            "n_buy": s["n_buy"], "n_sell": s["n_sell"],
            "sell_ratio": round(sr, 3),
            "first": (s["first"] or "")[:10], "last": (s["last"] or "")[:10],
            "flags": flags,
        })

    res.sort(key=lambda x: -x["net_prl"])

    # addresses that clustering must never merge into a whale's entity:
    # every OTC participant/escrow, the fee funnel, and labeled entities.
    no_merge = {FEE_ADDR}
    for r in rows:
        for k in ("seller_prl", "buyer_prl", "escrow_prl"):
            if r.get(k):
                no_merge.add(r[k])
    for e in (entities or {}):
        no_merge.add(e)
    names = {a for a, rec in (identities or {}).items() if rec.get("username")}
    claimed = set()

    # chain-enrich the top candidates
    for rank, a in enumerate(res[:enrich_top]):
        if not a["address"].startswith("prl1"):
            continue                      # EVM-only entity: no Pearl balance
        info = address_info(a["address"])
        if not info:
            continue
        bal = _num(info.get("balance_grains")) / GRAINS
        ext_sent = _num(info.get("external_sent_grains"))
        mined = _num(info.get("mined_grains"))
        # label entity: pool every Pearl member's balance / external sends
        pooled_bal, pooled_sent, n_pooled = bal, ext_sent, 1
        if a.get("label"):
            for m in (a.get("members") or []):
                if m == a["address"] or not m.startswith("prl1"):
                    continue
                if n_pooled >= 8:
                    break
                mi = address_info(m)
                if mi:
                    pooled_bal += _num(mi.get("balance_grains")) / GRAINS
                    pooled_sent += _num(mi.get("external_sent_grains"))
                    n_pooled += 1
            ext_sent = pooled_sent
        a["chain"] = {
            "balance_prl": round(bal, 2),
            "hodl": ext_sent == 0,
            "off_otc": pooled_bal > a["net_prl"] * 1.5 and mined == 0 and pooled_bal > 50000,
            "label": info.get("label"),
            "is_miner": mined > 0,
        }
        if a.get("label"):
            a["chain"]["entity_balance_prl"] = round(pooled_bal, 2)
            a["chain"]["n_pooled"] = n_pooled

        # ---- entity clustering (top slice only; precision-first) ----
        # claimed: members already attributed to a higher-ranked whale —
        # first come, first served (res is net_prl-desc), so one address is
        # never counted into two entities' holdings.
        if tx_cache and rank < cluster_top and a["net_prl"] >= 50000:
            try:
                cl = cluster_entity(
                    a["address"], info, tx_cache=tx_cache,
                    exclude=(no_merge | claimed) - {a["address"]}, names=names)
            except Exception:  # noqa: BLE001 - clustering is best-effort
                cl = None
            if cl:
                a["cluster"] = cl
                claimed.update(cl["addrs"])
                claimed.update(c["address"] for c in cl["cold"])
                # cluster holdings already include the primary's own balance;
                # for a label entity add only the extras on top of the pool
                a["chain"]["entity_balance_prl"] = round(
                    cl["holdings_prl"] + (pooled_bal - bal), 2)
                # entity-level hodl: external sends are (nearly) fully
                # explained by transfers into the entity's own cold wallets
                sent_prl = ext_sent / GRAINS
                if sent_prl > 0 and cl["out_to_cluster_prl"] >= 0.9 * sent_prl:
                    a["chain"]["hodl"] = True
                # off_otc keyed on entity holdings, not the single address
                a["chain"]["off_otc"] = (
                    cl["holdings_prl"] > a["net_prl"] * 1.5
                    and mined == 0 and cl["holdings_prl"] > 50000)

        if a["chain"]["hodl"]:
            a["flags"].append("hodl")
        if a["chain"]["off_otc"]:
            a["flags"].append("off_otc")

    return {"buyers": res[:out_top], "concentration": concentration}
