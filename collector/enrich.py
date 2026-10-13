"""Recover buyer/seller addresses for post-redesign LIVE settlements.

The redesigned OTC API stripped tx hashes, but the chains still hold the
truth and prlscan.com exposes a clean JSON API for the Pearl side:

  PRL leg (authoritative): every OTC release pays a fee to the constant
    address prl1ppf959… (prlscan labels it "Pearl OTC fees"). Its receive
    history is therefore the complete funnel of settlements. For each
    release tx we read the buyer output + the escrow input, and follow the
    escrow's funding (deposit) tx to the seller — same structure as the
    archive era, via api.prlscan.com/v1/txs/{txid}.

  USDC leg: matched separately on Arbitrum by amount+time (see evm side).

This module resolves the PRL leg by walking the fee funnel and matching
each release to an OTC feed row by exact gross amount (escrow input grains
== prl * 1e8) within a time window.
"""
from __future__ import annotations

from common import get, cache_get, cache_put

PRLSCAN = "https://api.prlscan.com"
FEE_ADDR = "prl1ppf959pzmduxmxf2t7hnlhm4gyzfve4pzs3s840lzh0stvanfs8qskqlngq"
# OTC v2 (from 2026-10-08 ~08:00Z): escrows moved to prl1z… addresses and a
# release pays the buyer 98% plus exactly 1% to each of two fixed addresses
# (the v1 address above stopped receiving). FEE_ADDR_V2 only ever receives
# those 1% cuts, so its history is the v2 release funnel. FEE_ADDR_V2B also
# gets 1% per release but is an older, active wallet (it has bought on the
# OTC itself), so it is excluded from outputs but never used as a funnel.
FEE_ADDR_V2 = "prl1pu6x5e5z7svtu03xtazz3d9xrwm4qgfphatv94fd9t3wy79ds8qrq8x6km9"
FEE_ADDR_V2B = "prl1pq3mn238ug5cj32c6tf8hy9u5582pg8a0t2geh9qj74ktlfqp8alsddygmv"
FEE_ADDRS = (FEE_ADDR, FEE_ADDR_V2, FEE_ADDR_V2B)
# v2 deposits also pay 0.01 PRL here; never the seller's change
DEPOSIT_MARKER = "prl1pt8e88h9m5j26u04vw7dgv4zxp2y68fy5wx82g78465lfsvprsmss2962e4"
GRAINS = 100_000_000  # 1 PRL = 1e8 grains (verified vs archive ground truth)


def _epoch(t):
    """prlscan times are ISO ('2026-06-01T17:23:34Z') or unix ints."""
    if t is None:
        return None
    if isinstance(t, (int, float)):
        return int(t)
    try:
        import datetime
        return int(datetime.datetime.fromisoformat(
            str(t).replace("Z", "+00:00")).timestamp())
    except Exception:  # noqa: BLE001
        return None


def prl_tx(txid, cache_dir):
    """Fetch + cache a Pearl tx: {inputs:[…], outputs:[…]}."""
    if not txid:
        return None
    c = cache_get(cache_dir, txid)
    if c is not None:
        return c or None
    try:
        d = get(f"{PRLSCAN}/v1/txs/{txid}", kind="json", tries=4)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(d, dict) or "outputs" not in d:
        return None
    out = {
        "inputs": [{"prev_txid": i.get("prev_txid"),
                    "prev_address": i.get("prev_address"),
                    "prev_value_grains": i.get("prev_value_grains")}
                   for i in d.get("inputs", [])],
        "outputs": [{"vout": o.get("vout"), "address": o.get("address"),
                     "value_grains": o.get("value_grains")}
                    for o in d.get("outputs", [])],
    }
    cache_put(cache_dir, txid, out)
    return out


def fee_funnel(since_epoch=None, max_pages=400):
    """All OTC release txs (newest→oldest) from the fee address histories
    (v1 address until 2026-10-08, v2 address after).

    Returns [{txid, time, fee_grains}] for releases with time >= since."""
    out, seen = [], set()
    for funnel_addr in (FEE_ADDR, FEE_ADDR_V2):
        cursor = None
        for _ in range(max_pages):
            url = f"{PRLSCAN}/v1/addresses/{funnel_addr}/txs?limit=50"
            if cursor:
                url += "&cursor=" + cursor
            d = get(url, kind="json", tries=4)
            items = d.get("items", []) if isinstance(d, dict) else []
            if not items:
                break
            stop = False
            for it in items:
                ep = _epoch(it.get("time"))
                if since_epoch and ep and ep < since_epoch:
                    stop = True
                    continue
                # only incoming fee receipts (releases), not the rare outflows
                if (it.get("received_grains") or 0) <= 0:
                    continue
                if it.get("txid") in seen:
                    continue
                seen.add(it.get("txid"))
                out.append({"txid": it.get("txid"), "time": ep,
                            "fee_grains": it.get("received_grains")})
            cursor = d.get("next_cursor") if isinstance(d, dict) else None
            if stop or not cursor:
                break
    return out


def resolve_release(release_txid, cache_dir):
    """release tx -> {buyer_prl, seller_prl, escrow_prl, gross_prl,
    deposit_txid}. Mirrors the archive correlation, via prlscan."""
    rel = prl_tx(release_txid, cache_dir)
    if not rel or not rel["inputs"] or not rel["outputs"]:
        return None
    esc_in = rel["inputs"][0]
    escrow = esc_in.get("prev_address")
    gross_grains = esc_in.get("prev_value_grains")
    deposit_txid = esc_in.get("prev_txid")
    # buyer = largest release output not going to a fee address. Which fee
    # addresses apply depends on the release version: excluding the v2 pair
    # from v1 releases would hide a buyer that happens to be FEE_ADDR_V2B.
    outs = {o.get("address") for o in rel["outputs"]}
    fees = {FEE_ADDR_V2, FEE_ADDR_V2B} if FEE_ADDR_V2 in outs else {FEE_ADDR}
    buyer = None
    best = -1
    for o in rel["outputs"]:
        if o.get("address") in fees:
            continue
        v = o.get("value_grains") or 0
        if v > best:
            best, buyer = v, o.get("address")
    # seller = deposit change output (the output that is NOT the escrow)
    seller = None
    dep = prl_tx(deposit_txid, cache_dir) if deposit_txid else None
    if dep:
        change = [o for o in dep["outputs"]
                  if o.get("address") not in (escrow, DEPOSIT_MARKER)]
        change.sort(key=lambda o: o.get("value_grains") or 0, reverse=True)
        if change:
            seller = change[0].get("address")
        elif dep["inputs"]:
            seller = dep["inputs"][0].get("prev_address")
    return {
        "buyer_prl": buyer,
        "seller_prl": seller,
        "escrow_prl": escrow,
        "gross_prl": (gross_grains / GRAINS) if gross_grains else None,
        "gross_grains": gross_grains,
        "deposit_txid": deposit_txid,
        "release_txid": release_txid,
    }


def build_pearl_index(since_epoch, cache_dir):
    """Map exact gross grains -> list of resolved releases, for matching
    OTC feed rows by amount. Returns (by_grains, resolved_list)."""
    funnel = fee_funnel(since_epoch=since_epoch)
    by_grains = {}
    resolved = []
    for f in funnel:
        r = resolve_release(f["txid"], cache_dir)
        if not r or not r.get("gross_grains"):
            continue
        r["time"] = f["time"]
        resolved.append(r)
        by_grains.setdefault(r["gross_grains"], []).append(r)
    return by_grains, resolved
