"""prlscan helpers for the intelligence layer: address info, rich-list
holders, entity labels, and the SafeTrade exchange deposit/withdrawal feed.

Reuses the prlscan base + tx resolver from enrich.py.
"""
from __future__ import annotations

import json
import os
import time

from common import get, cache_get, cache_put
from enrich import PRLSCAN, GRAINS, _epoch, prl_tx

# prlscan labels this address "Safetrade" (label_kind system). It is the
# exchange hot wallet — 55k+ txs, fan-in deposits / batched withdrawals.
SAFETRADE = "prl1pekqva2snqm3upwdn7pazk85jyvd96czemayvc5u855dwunwsaaxs42hp6j"

_ADDR_FIELDS = ("label", "label_kind", "balance_grains", "received_grains",
                "sent_grains", "external_received_grains", "external_sent_grains",
                "mined_grains", "tx_count", "transfer_in_tx_count",
                "transfer_out_tx_count", "first_seen_at", "last_seen_at")


def address_info(addr):
    """GET /v1/addresses/{addr} — current balance/label/flow counters.
    Not disk-cached (balance is time-sensitive); ~tens of calls per run."""
    if not addr:
        return None
    try:
        d = get(f"{PRLSCAN}/v1/addresses/{addr}", kind="json", tries=4)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(d, dict):
        return None
    return {k: d.get(k) for k in _ADDR_FIELDS}


def label_of(addr, cache_dir):
    """Cached human label for an address ({} cached when none — labels are
    effectively static)."""
    if not addr:
        return None
    c = cache_get(cache_dir, addr)
    if c is not None:
        return c or None
    info = address_info(addr)
    rec = {}
    if info and info.get("label"):
        rec = {"label": info["label"], "kind": info.get("label_kind") or "system"}
    cache_put(cache_dir, addr, rec)
    return rec or None


def holders(top_n=300):
    """Rich list, balance-desc. Returns [{address, balance_grains,
    mined_grains, received_grains, external_sent_grains, tx_count, ...}].
    NOTE: holders does NOT carry labels — resolve those via label_of()."""
    out = []
    cursor = None
    while len(out) < top_n:
        url = f"{PRLSCAN}/v1/holders?limit=100"
        if cursor:
            url += "&cursor=" + cursor
        try:
            d = get(url, kind="json", tries=4)
        except Exception:  # noqa: BLE001
            break
        items = d.get("items", []) if isinstance(d, dict) else []
        if not items:
            break
        out.extend(items)
        cursor = d.get("next_cursor") if isinstance(d, dict) else None
        if not cursor:
            break
    return out[:top_n]


def build_entities(holder_list, label_cache, extra_addrs=()):
    """address -> {label, kind} for labeled addresses among the top holders
    (+ any extra known addresses). Cheap after first run (labels cached)."""
    ent = {}
    seen = set()
    for h in holder_list:
        a = h.get("address")
        if not a or a in seen:
            continue
        seen.add(a)
        rec = label_of(a, label_cache)
        if rec:
            ent[a] = rec
    for a in extra_addrs:
        if a and a not in ent:
            rec = label_of(a, label_cache)
            if rec:
                ent[a] = rec
    return ent


def safetrade_flows(since_epoch, big_grains, prl_tx_cache, max_pages=200):
    """Recent SafeTrade deposits/withdrawals newer than since_epoch.

    deposit  = PRL into the exchange (delta > 0) — counterparty = sender,
               a forward indicator of potential sell pressure.
    withdraw = PRL out of the exchange (delta < 0) — counterparty =
               recipient, accumulation / claim.
    Only large flows (>= big_grains) get their counterparty resolved.

    Deposit counterparties are usually NOT the real user: the exchange
    (Peatio-style) gives each user a dedicated deposit address, and the
    hot-wallet tx we see is the COLLECTION sweep deposit_addr -> hot
    wallet. When the direct counterparty looks like such an intermediary
    (tiny pure-forwarder), we pierce one hop back to the address that
    funded it and report that as the counterparty, keeping the sweep
    address in "via"."""
    out = []
    cursor = None
    info = address_info(SAFETRADE) or {}
    for _ in range(max_pages):
        url = f"{PRLSCAN}/v1/addresses/{SAFETRADE}/txs?limit=50"
        if cursor:
            url += "&cursor=" + cursor
        try:
            d = get(url, kind="json", tries=4)
        except Exception:  # noqa: BLE001
            break
        items = d.get("items", []) if isinstance(d, dict) else []
        if not items:
            break
        stop = False
        for it in items:
            ep = _epoch(it.get("time"))
            if since_epoch and ep and ep < since_epoch:
                stop = True
                continue
            delta = it.get("delta_grains") or 0
            grains = abs(delta)
            if grains < big_grains:
                continue
            kind = "deposit" if delta > 0 else "withdraw"
            rec = {"time": ep, "kind": kind,
                   "prl": round(grains / GRAINS, 4),
                   "txid": it.get("txid"), "counterparty": None}
            if kind == "deposit":
                # A collection sweep often merges SEVERAL deposit addresses
                # into one tx. Group inputs by address and take the LARGEST
                # funder as the counterparty, piercing with ITS amount (not
                # the whole-tx delta) so one user is never blamed for the
                # pooled total of many.
                by_in = {}
                tx = prl_tx(it.get("txid"), prl_tx_cache)
                for i in (tx.get("inputs", []) if tx else []):
                    a = i.get("prev_address")
                    if a and a != SAFETRADE:
                        by_in[a] = by_in.get(a, 0) + (i.get("prev_value_grains") or 0)
                if by_in:
                    cp = max(by_in, key=by_in.get)
                    rec["counterparty"] = cp
                    if len(by_in) > 1:
                        rec["n_sources"] = len(by_in)
                        rec["cp_prl"] = round(by_in[cp] / GRAINS, 4)
                    try:
                        origin = _pierce_deposit_addr(cp, by_in[cp], ep,
                                                      prl_tx_cache)
                    except Exception:  # noqa: BLE001 - pierce is best-effort
                        origin = None
                    if origin and origin not in (cp, SAFETRADE):
                        rec["counterparty"] = origin
                        rec["via"] = cp
            else:
                rec["counterparty"] = _counterparty(it.get("txid"), kind,
                                                    prl_tx_cache)
            out.append(rec)
        cursor = d.get("next_cursor") if isinstance(d, dict) else None
        if stop or not cursor:
            break
    return out, info


# ===== SafeTrade v2: rotating-change-chain custody (since 2026-09-15) =====
#
# On 2026-09-15 SafeTrade stopped using the labeled hot wallet. Since then
# every exchange transaction has the same shape:
#   inputs  = hundreds..thousands of swept deposit-address UTXOs (user and
#             miner deposits, 80-300 PRL each) + the previous hot "change"
#   outputs = exactly two: ONE user withdrawal and ONE change output to a
#             brand-new address, which becomes the hot wallet for the next tx
# So the hot wallet is a chain of fresh one-shot addresses. We follow it by
# structure, not labels: any tx that spends a known chain address is an
# exchange tx; its non-chain inputs are DEPOSITS; of its two outputs, the one
# later spent by another exchange-signature tx (>= SWEEP_MIN inputs, or
# co-spent with a chain address) is the next hot change, the other one is a
# WITHDRAWAL. State (chain members, open tips, processed txs) persists in a
# cache file so hourly runs crawl incrementally.
SAFETRADE_V2_FROM = 1789430400          # 2026-09-15T00:00Z
SWEEP_MIN = 20                          # inputs that mark an exchange sweep
# A pure rotation hop is a 1-input / <=2-output tx (no sweep, no co-spend):
# the 09-15 migration moved 10M through dozens of these. We keep following
# such a hop only while the output is hot-float sized; a user who withdrew
# a smaller amount and forwards it is not mistaken for the exchange.
HOP_MIN_GRAINS = 100000 * 10 ** 8       # 100k PRL


def _ex_tx(txid, st_cache):
    """Slim summary of an exchange tx (a 1600-input body is ~200KB; we keep
    per-address input sums + the two outputs). Cached on disk."""
    c = cache_get(st_cache, txid)
    if c is not None:
        return c or None
    try:
        d = get(f"{PRLSCAN}/v1/txs/{txid}", kind="json", tries=4)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(d, dict) or "outputs" not in d:
        cache_put(st_cache, txid, {})
        return None
    by_addr = {}
    for i in d.get("inputs", []):
        a = i.get("prev_address")
        if a:
            by_addr[a] = by_addr.get(a, 0) + (i.get("prev_value_grains") or 0)
    # keep individual inputs >= 1k PRL (deposit candidates, hot shards);
    # the thousands of 80-300 PRL miner payouts only matter in aggregate
    big = {a: g for a, g in by_addr.items() if g >= 1000 * GRAINS}
    small = [g for a, g in by_addr.items() if g < 1000 * GRAINS]
    s = {
        "time": _epoch(d.get("time") or d.get("block_time")),
        "n_in": len(d.get("inputs", [])),
        "in": dict(sorted(big.items(), key=lambda kv: -kv[1])),
        "small_n": len(small), "small_sum": sum(small),
        "outs": [[o.get("address"), o.get("value_grains") or 0]
                 for o in d.get("outputs", []) if o.get("address")],
    }
    cache_put(st_cache, txid, s)
    return s


def _spends(addr, since_epoch=None, max_pages=1):
    """[(txid, epoch)] where addr is spent (delta < 0), newest first."""
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
        stop = False
        for it in items:
            ep = _epoch(it.get("time"))
            if since_epoch and ep and ep < since_epoch:
                stop = True
                break
            if (it.get("delta_grains") or 0) < 0:
                out.append((it.get("txid"), ep))
        cursor = d.get("next_cursor") if isinstance(d, dict) else None
        if stop or not cursor or not items:
            break
    return out


def _load_state(path):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001
            pass
    return {"members": {SAFETRADE: SAFETRADE_V2_FROM}, "queue": [SAFETRADE],
            "pending": {}, "txs": {}}


def _save_state(path, st):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, separators=(",", ":"))
    os.replace(tmp, path)


def safetrade_flows_v2(since_epoch, big_grains, prl_tx_cache, st_cache,
                       state_path, max_new_txs=600):
    """Crawl the rotating-change chain forward from its open tips and emit
    deposits/withdrawals newer than since_epoch, in the same record shape as
    safetrade_flows(). Returns (flows, info)."""
    st = _load_state(state_path)
    members = st["members"]                 # addr -> first-seen epoch
    txs = st["txs"]                         # txid -> {t, dep:[...], w:[...]}
    pending = st.get("pending", {})         # addr -> {t, g, txid}: unresolved outputs
    queue = list(dict.fromkeys(st.get("queue", [])))
    n_new = 0
    now = time.time()

    def resolve_output(oa, g, t, txid):
        """Decide whether an exchange-tx output is the next hot change
        (→ chain member, crawl on) or a user withdrawal. Unspent outputs
        stay pending: a hot UTXO is spent within ~a day, a withdrawn balance
        may sit — so an unspent output older than 2 days is a withdrawal."""
        # exchange change always lands on a brand-new address; an output to
        # an address with prior history (a user's wallet, e.g. Amber's) is a
        # withdrawal no matter its size
        ai = address_info(oa) or {}
        if (ai.get("transfer_in_tx_count") or 0) > 1 or (ai.get("tx_count") or 0) > 2:
            if txid in txs:
                txs[txid]["w"].append([oa, g])
            pending.pop(oa, None)
            return
        osp = _spends(oa, max_pages=1)
        if osp:
            s2 = _ex_tx(osp[0][0], st_cache)
            is_hot = bool(s2) and (
                s2["n_in"] >= SWEEP_MIN                                  # deposit sweep
                or any(x in members for x in s2["in"] if x != oa)        # co-spent with chain
                or (g >= HOP_MIN_GRAINS and s2["n_in"] < SWEEP_MIN       # hot-float sized hop /
                    and len(s2["outs"]) <= 4))                           # shard merge or split
            if is_hot:
                members[oa] = t
                queue.append(oa)
            elif txid in txs:
                txs[txid]["w"].append([oa, g])
            pending.pop(oa, None)
        elif now - t > 2 * 86400:
            if txid in txs:
                txs[txid]["w"].append([oa, g])
            pending.pop(oa, None)
        else:
            pending[oa] = {"t": t, "g": g, "txid": txid}

    # 0) repair pass: hot-float-sized "withdrawals" decided under earlier
    #    (narrower) rules are re-judged. A 5-7M payout to a one-shot address
    #    is a shard hop, not a user; once promoted, its downstream hops get
    #    crawled so the shard's re-entry is no longer counted as a deposit.
    judged = set(st.get("judged", []))      # re-judged once under the current rules
    for txid, rec in list(txs.items()):
        big = [(oa, g) for oa, g in rec["w"]
               if g >= HOP_MIN_GRAINS and oa not in members and oa not in judged]
        if not big:
            continue
        rec["w"] = [[oa, g] for oa, g in rec["w"]
                    if not (g >= HOP_MIN_GRAINS and oa not in members and oa not in judged)]
        for oa, g in big:
            judged.add(oa)
            resolve_output(oa, g, rec["t"], txid)   # re-appends if still a withdrawal
    st["judged"] = sorted(judged)[-2000:]

    # 1) outputs left unresolved by earlier runs (incl. the current hot tip)
    for oa, p in list(pending.items()):
        resolve_output(oa, p["g"], p["t"], p["txid"])

    # 2) crawl forward from every chain address whose spend is unprocessed
    while queue and n_new < max_new_txs:
        a = queue.pop(0)
        # the legacy hot wallet has ~7k pre-switch withdrawals: skip those
        since = SAFETRADE_V2_FROM if a == SAFETRADE else None
        spends = _spends(a, since_epoch=since, max_pages=3 if a == SAFETRADE else 1)
        for txid, ep in spends:
            if txid in txs:
                continue
            s = _ex_tx(txid, st_cache)
            if not s:
                continue
            n_new += 1
            t = s.get("time") or ep or 0
            rec = {"t": t, "dep": [], "w": [],
                   "dep_sum": s.get("small_sum", 0), "n_dep": s.get("small_n", 0)}
            txs[txid] = rec
            # inputs that are not chain members = deposits being swept.
            # dep_sum counts EVERY swept input (miner payouts are 80-300 PRL
            # each and only matter in aggregate); dep lists the big ones.
            for ia, g in s["in"].items():
                if ia in members:
                    continue
                rec["dep_sum"] += g
                rec["n_dep"] += 1
                if g >= big_grains:
                    rec["dep"].append([ia, g])
            for oa, g in s["outs"]:
                if oa not in members and oa not in pending:
                    resolve_output(oa, g, t, txid)

    # prune: a shard spent long ago can never be an input again, and the
    # radar only looks 21 days back — keeps the hourly-rewritten state small
    st["queue"] = list(dict.fromkeys(queue))
    st["pending"] = pending
    st["members"] = {a: t for a, t in members.items()
                     if a == SAFETRADE or (t or 0) >= since_epoch - 35 * 86400}
    st["txs"] = {k: v for k, v in txs.items()
                 if (v.get("t") or 0) >= since_epoch - 25 * 86400}
    _save_state(state_path, st)

    # ---- internal shard moves masquerading as flows ----
    # A hot-wallet shard that was mis-read as a withdrawal (crawl order, or
    # a merge shape we had not seen) shows up again as a DEPOSIT of the same
    # amount from the same one-shot address when the exchange sweeps it. Pair
    # those up (amount within 1% = fee), drop both sides, and promote the
    # address to chain member so the pattern never recurs.
    dep_by_addr = {}
    for rec in txs.values():
        for ia, g in rec["dep"]:
            dep_by_addr.setdefault(ia, []).append(g)
    internal = set()
    for rec in txs.values():
        for oa, g in rec["w"]:
            for g2 in dep_by_addr.get(oa, []):
                if abs(g2 - g) <= 0.01 * g:
                    internal.add(oa)
                    break
    for oa in internal:
        members.setdefault(oa, int(now))
    if internal:
        _save_state(state_path, st)

    # ---- emit flows in the window ----
    # A tx may have been processed before one of its inputs/outputs was
    # recognised as a chain member (crawl order), so re-filter against the
    # final member set here.
    flows = []
    dep_total = wd_total = 0
    for txid, rec in txs.items():
        t = rec.get("t") or 0
        if t < since_epoch:
            continue
        dep_total += rec.get("dep_sum", 0) - sum(g for ia, g in rec["dep"] if ia in members)
        wd_total += sum(g for oa, g in rec["w"] if oa not in members)
        for ia, g in rec["dep"]:
            if ia in members:
                continue
            f = {"time": t, "kind": "deposit", "prl": round(g / GRAINS, 4),
                 "txid": txid, "counterparty": ia}
            try:
                origin = _pierce_deposit_addr(ia, g, t, prl_tx_cache)
            except Exception:  # noqa: BLE001
                origin = None
            if origin and origin not in (ia, SAFETRADE):
                f["counterparty"] = origin
                f["via"] = ia
            flows.append(f)
        for oa, g in rec["w"]:
            if g >= big_grains and oa not in members:
                flows.append({"time": t, "kind": "withdraw",
                              "prl": round(g / GRAINS, 4), "txid": txid,
                              "counterparty": oa})
    # hot float = the unspent pending change outputs (the current tips);
    # count the output amounts themselves, not whole-address balances
    hot = sum(p.get("g") or 0 for p in pending.values())
    info = {"balance_grains": hot, "mode": "rotating-chain",
            "chain_members": len(members), "tips": len(pending),
            "txs_in_window": sum(1 for r in txs.values() if (r.get("t") or 0) >= since_epoch),
            "external_received_grains": dep_total,     # all swept deposits in window
            "external_sent_grains": wd_total}          # all withdrawals in window
    return flows, info


def _pierce_deposit_addr(cp, flow_grains, flow_time, tx_cache):
    """If cp is an exchange deposit intermediary (small pure forwarder),
    return the address that funded it (the real depositor), else None."""
    info = address_info(cp)
    if not info or info.get("label"):
        return None
    ext_recv = info.get("external_received_grains") or 0
    ext_sent = info.get("external_sent_grains") or 0
    bal = info.get("balance_grains") or 0
    if (info.get("tx_count") or 0) > 40 or ext_recv <= 0:
        return None
    if ext_sent < 0.9 * ext_recv or bal > 0.02 * ext_recv:
        return None      # keeps funds / doesn't forward — a real wallet

    # its inbound txs = user deposits; find the one this sweep collected
    try:
        d = get(f"{PRLSCAN}/v1/addresses/{cp}/txs?limit=50", kind="json",
                tries=4)
    except Exception:  # noqa: BLE001
        return None
    items = (d.get("items", []) if isinstance(d, dict) else [])
    inbound = [(it.get("txid"), _epoch(it.get("time")),
                it.get("delta_grains") or 0)
               for it in items if (it.get("delta_grains") or 0) > 0]
    if not inbound:
        return None
    # Only deposits at-or-before the sweep can be what it collected — a
    # later same-amount deposit must not steal the attribution (round
    # amounts repeat; the hourly job revisits old sweeps for 21 days).
    if flow_time:
        inbound = [x for x in inbound if x[1] is None or x[1] <= flow_time + 300]
    # prefer amount match (sweep ≈ deposit), nearest-before-sweep first;
    # else fall back to the nearest deposit before the sweep
    match = sorted([x for x in inbound
                    if abs(x[2] - flow_grains) <= 0.01 * flow_grains],
                   key=lambda x: -(x[1] or 0))
    if not match:
        match = sorted(inbound, key=lambda x: -(x[1] or 0))[:1]
    if not match:
        return None
    tx = prl_tx(match[0][0], tx_cache)
    if not tx:
        return None
    best, ba = -1, None
    for i in tx.get("inputs", []):
        a = i.get("prev_address")
        v = i.get("prev_value_grains") or 0
        if a and a not in (cp, SAFETRADE) and v > best:
            best, ba = v, a
    return ba


def _counterparty(txid, kind, cache_dir):
    """For a deposit, the sender (a non-SafeTrade input); for a withdrawal,
    the recipient (a non-SafeTrade output)."""
    tx = prl_tx(txid, cache_dir)
    if not tx:
        return None
    if kind == "deposit":
        for i in tx.get("inputs", []):
            a = i.get("prev_address")
            if a and a != SAFETRADE:
                return a
    else:
        best, ba = -1, None
        for o in tx.get("outputs", []):
            a = o.get("address")
            if a and a != SAFETRADE and (o.get("value_grains") or 0) > best:
                best, ba = o.get("value_grains") or 0, a
        return ba
    return None
