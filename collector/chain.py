"""prlscan helpers for the intelligence layer: address info, rich-list
holders, entity labels, and the SafeTrade exchange deposit/withdrawal feed.

Reuses the prlscan base + tx resolver from enrich.py.
"""
from __future__ import annotations

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
