"""UTXO entity clustering for whale addresses (precision over recall).

Two standard heuristics, applied conservatively:

  co-spend      every input of a tx is signed by the same key holder ->
                addresses appearing together as inputs of the whale's
                outbound txs belong to the whale's entity.
  cold wallet   a large outbound recipient that is a pure sink (never sent
                value out), is not an OTC participant / labeled entity /
                named user, is funded mostly by the whale, AND carries
                ownership evidence (repeated funding over time, or has sat
                untouched for days) -> the whale's own cold storage.

Why the extra ownership evidence: "big one-shot payment to a fresh sink"
equally describes a P2P buyer's new wallet, a not-yet-swept exchange
deposit address, or an in-flight escrow. Mislabeling those as the whale's
cold storage would not just inflate holdings — it would flip a SELL into
"hodl" on the leaderboard. So a candidate must additionally show either
  (a) >= 2 fundings from the whale spread over > 24h (one-shot payments
      to strangers don't repeat), or
  (b) no on-chain activity for >= IDLE_DAYS days (deposit addresses get
      swept and escrows get released within hours-days; cold storage
      just sits). New consolidations therefore appear on the board only
      after they have proven idle.

Why outputs are attributed by the whale's INPUT SHARE: in a co-spent tx,
crediting full output values to the whale would overstate what *it* sent
(and could push out_to_cluster above its own external_sent, breaking the
entity-hodl comparison in whales.py).

Only OUTBOUND txs are walked, and every guard errs toward NOT merging.
"""
from __future__ import annotations

import time

from common import get
from enrich import PRLSCAN, GRAINS, prl_tx, _epoch
from chain import address_info

IDLE_DAYS = 3          # min quiet period before a one-shot sink counts as cold


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def outbound_items(addr, max_pages=6):
    """[(txid, time_epoch)] where addr spent (delta < 0), via the cheap
    list endpoint (no tx bodies)."""
    out, cursor = [], None
    for _ in range(max_pages):
        url = f"{PRLSCAN}/v1/addresses/{addr}/txs?limit=100"
        if cursor:
            url += "&cursor=" + cursor
        try:
            d = get(url, kind="json", tries=4)
        except Exception:  # noqa: BLE001
            break
        items = d.get("items", []) if isinstance(d, dict) else []
        for it in items:
            if (it.get("delta_grains") or 0) < 0:
                out.append((it.get("txid"), _epoch(it.get("time"))))
        cursor = d.get("next_cursor") if isinstance(d, dict) else None
        if not cursor or not items:
            break
    return out


def cluster_entity(addr, own_info, *, tx_cache, exclude, names,
                   min_cold_prl=50000, max_members=6):
    """Cluster one whale address. Returns None when nothing merges.

    exclude: addresses that must never be merged into the entity
             (other OTC participants, escrows, fee addr, labeled entities,
             and members already claimed by a higher-ranked whale).
    names:   addr -> username map; a named address is someone else.
    """
    txids = outbound_items(addr)
    if not txids:
        return None

    partners = {}       # co-spend co-input addr -> grains it contributed
    recipients = {}     # output addr -> {grains (whale-share), times []}
    for txid, t in txids:
        tx = prl_tx(txid, tx_cache)
        if not tx:
            continue
        ins = tx.get("inputs", [])
        # co-spend only counts when OUR address is among the inputs
        own_in = sum(_num(i.get("prev_value_grains")) for i in ins
                     if i.get("prev_address") == addr)
        if own_in <= 0:
            continue
        total_in = sum(_num(i.get("prev_value_grains")) for i in ins) or own_in
        share = own_in / total_in        # whale's funding share of this tx
        for i in ins:
            a = i.get("prev_address")
            if a and a != addr and a not in exclude and a not in names:
                partners[a] = partners.get(a, 0) + _num(i.get("prev_value_grains"))
        for o in tx.get("outputs", []):
            a = o.get("address")
            if a and a != addr:
                r = recipients.setdefault(a, {"grains": 0.0, "times": []})
                r["grains"] += _num(o.get("value_grains")) * share
                if t:
                    r["times"].append(t)

    # ---- cold-wallet test on the big recipients ----
    now = time.time()
    cold = []
    big = sorted(recipients.items(), key=lambda kv: -kv[1]["grains"])[:max_members]
    for a, rec in big:
        grains = rec["grains"]
        if grains < min_cold_prl * GRAINS:
            continue
        if a in exclude or a in names or a in partners:
            continue
        info = address_info(a)
        if not info:
            continue
        if info.get("label"):                       # known entity — not ours
            continue
        if _num(info.get("mined_grains")) > 0:      # a miner is its own actor
            continue
        ext_recv = _num(info.get("external_received_grains"))
        ext_sent = _num(info.get("external_sent_grains"))
        # sink test with dust tolerance: a 0.5-PRL test send must not
        # disqualify a wallet holding 1.85M (seen in the wild on the #1
        # whale's cold storage). Anything beyond dust = it spends = skip.
        if ext_sent > max(10 * GRAINS, 0.001 * ext_recv):
            continue                                # spends — not a sink
        if ext_recv <= 0 or grains < 0.5 * ext_recv:
            continue                                # mostly funded by others
        # ---- ownership evidence (see module docstring) ----
        times = sorted(rec["times"])
        repeated = len(times) >= 2 and (times[-1] - times[0]) > 86400
        last_seen = _epoch(info.get("last_seen_at"))
        idle = last_seen is not None and (now - last_seen) >= IDLE_DAYS * 86400
        if not (repeated or idle):
            continue                                # could be payee/deposit/escrow
        cold.append({
            "address": a,
            "balance_prl": round(_num(info.get("balance_grains")) / GRAINS, 2),
            "from_prl": round(grains / GRAINS, 2),
        })

    # ---- co-spend partner balances ----
    members = []
    for a in sorted(partners, key=lambda x: -partners[x])[:max_members]:
        info = address_info(a)
        if info and info.get("label"):              # never merge labeled
            continue
        members.append({
            "address": a,
            "balance_prl": round(_num((info or {}).get("balance_grains"))
                                 / GRAINS, 2),
        })

    if not cold and not members:
        return None

    own_bal = _num((own_info or {}).get("balance_grains")) / GRAINS
    holdings = own_bal + sum(m["balance_prl"] for m in members) \
        + sum(c["balance_prl"] for c in cold)
    out_to_cluster = sum(c["from_prl"] for c in cold)
    return {
        "addrs": [m["address"] for m in members],
        "cold": cold,
        "holdings_prl": round(holdings, 2),
        "out_to_cluster_prl": round(out_to_cluster, 2),
    }
