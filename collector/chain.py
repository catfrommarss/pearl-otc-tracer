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
    Only large flows (>= big_grains) get their counterparty resolved."""
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
            cp = _counterparty(it.get("txid"), kind, prl_tx_cache)
            out.append({"time": ep, "kind": kind,
                        "prl": round(grains / GRAINS, 4),
                        "txid": it.get("txid"), "counterparty": cp})
        cursor = d.get("next_cursor") if isinstance(d, dict) else None
        if stop or not cursor:
            break
    return out, info


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
