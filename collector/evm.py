"""Resolve the USDC leg of a trade on Arbitrum/Base via public RPC.

We read the tx receipt and decode ERC-20 Transfer logs. The Transfer whose
value matches the trade's usdc_amount tells us buyer (from) -> seller (to).
This auto-handles native vs bridged USDC since we match by amount, not by a
hardcoded token address.
"""
from __future__ import annotations

from common import get, cache_get, cache_put

# keccak256("Transfer(address,address,uint256)")
TRANSFER_TOPIC = ("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a"
                  "4df523b3ef")

RPCS = {
    "ARBITRUM": [
        "https://arb1.arbitrum.io/rpc",
        "https://arbitrum-one.publicnode.com",
        "https://arbitrum.llamarpc.com",
    ],
    "BASE": [
        "https://mainnet.base.org",
        "https://base.publicnode.com",
        "https://base.llamarpc.com",
    ],
}


def _topic_addr(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def _rpc(network: str, method: str, params: list):
    last = None
    for url in RPCS.get(network, []):
        try:
            r = get(url, kind="json",
                    json_body={"jsonrpc": "2.0", "id": 1,
                               "method": method, "params": params},
                    tries=3)
            if isinstance(r, dict) and r.get("result") is not None:
                return r["result"]
            last = RuntimeError(str(r)[:200])
        except Exception as e:  # noqa: BLE001 - try the next endpoint
            last = e
    if last:
        raise last
    return None


def resolve_usdc(tx_hash: str, network: str, usdc_amount, cache_dir: str):
    """Return {buyer_evm, seller_evm, value_usdc, block, token, tx_hash}
    or None when it can't be resolved."""
    if not tx_hash:
        return None
    key = f"{network}_{tx_hash}".lower()
    cached = cache_get(cache_dir, key)
    if cached is not None:
        return cached or None  # cached {} means "tried, unresolved"
    try:
        receipt = _rpc(network, "eth_getTransactionReceipt", [tx_hash])
    except Exception:  # noqa: BLE001 - RPCs all failed; retry next run
        return None
    if not receipt or not receipt.get("logs"):
        cache_put(cache_dir, key, {})
        return None

    want = None
    try:
        want = float(usdc_amount)
    except (TypeError, ValueError):
        pass

    transfers = []
    for lg in receipt["logs"]:
        topics = lg.get("topics") or []
        if len(topics) < 3 or topics[0].lower() != TRANSFER_TOPIC:
            continue
        try:
            val = int(lg["data"], 16) / 1e6  # USDC has 6 decimals
        except (ValueError, KeyError):
            continue
        transfers.append({
            "from": _topic_addr(topics[1]),
            "to": _topic_addr(topics[2]),
            "token": lg.get("address", "").lower(),
            "value": val,
        })
    if not transfers:
        cache_put(cache_dir, key, {})
        return None

    pick = transfers[0]
    if want is not None:
        pick = min(transfers, key=lambda t: abs(t["value"] - want))
        if abs(pick["value"] - want) > max(0.02 * max(want, 1), 0.01):
            # No transfer is close to the expected usdc_amount. Earlier
            # versions fell back to the largest Transfer and cached it as
            # if resolved, which polluted buyer_evm/seller_evm. Treat as
            # unresolved instead — cache {} so we don't keep retrying a
            # receipt that genuinely doesn't carry the matching payment.
            cache_put(cache_dir, key, {})
            return None

    try:
        block = int(receipt.get("blockNumber", "0x0"), 16)
    except (ValueError, TypeError):
        block = None
    out = {
        "buyer_evm": pick["from"],
        "seller_evm": pick["to"],
        "value_usdc": round(pick["value"], 6),
        "token": pick["token"],
        "block": block,
        "tx_hash": tx_hash,
        "network": network,
    }
    cache_put(cache_dir, key, out)
    return out


# ===== global amount+time matching (post-redesign: no tx hash available) =====

# USDC payment lands a few minutes before the settlement record time
# (calibrated from archive: ~5-18 min, median ~8.5 min). Search window:
_USDC_WIN_BACK = 1150   # seconds before record time (covers the tail)
_USDC_WIN_FWD = 60      # small forward margin
_USDC_EXPECT = 518      # median offset, used to disambiguate candidates

USDC_TOKENS = {
    "ARBITRUM": ["0xaf88d065e77c8cc2239327c5edb3a432268e5831",   # native USDC
                 "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"],  # bridged USDC.e
    "BASE": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",       # native USDC
             "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"],      # USDbC
}

_anchor = {}  # network -> (block, ts)


def _bn(network):
    return int(_rpc(network, "eth_blockNumber", []), 16)


def _bts(network, bn):
    b = _rpc(network, "eth_getBlockByNumber", [hex(int(bn)), False])
    return int(b["timestamp"], 16)


def block_at_time(network, ts):
    """Estimate the block number at a unix timestamp (rate-refined)."""
    a = _anchor.get(network)
    if not a:
        bn = _bn(network)
        a = (bn, _bts(network, bn))
        _anchor[network] = a
    bn, bts = a
    lo = max(1, bn - 200000)
    rate = (bts - _bts(network, lo)) / (bn - lo)  # sec/block
    est = int(bn - (bts - ts) / rate)
    for _ in range(6):
        est = max(1, min(bn, est))
        ets = _bts(network, est)
        diff = ts - ets
        if abs(diff) <= 4:
            break
        est = int(est + diff / rate)
    return max(1, min(bn, est))


def _logs_chunked(network, token, lo, hi, want_int):
    """Returns (matches, complete). complete=False means at least one block
    range failed even at the smallest step (rate limit / flaky RPC) and was
    skipped — the match list may be MISSING candidates, so callers must not
    treat a single survivor as a unique match nor cache "no candidates"."""
    matches, step, b, complete = [], 900, lo, True
    while b <= hi:
        end = min(b + step - 1, hi)
        try:
            logs = _rpc(network, "eth_getLogs", [{
                "address": token, "topics": [TRANSFER_TOPIC],
                "fromBlock": hex(b), "toBlock": hex(end)}])
        except Exception:  # noqa: BLE001 - range/size error → shrink
            if step > 120:
                step //= 2
                continue
            complete = False         # skipping a window we could not read
            b = end + 1
            continue
        for lg in (logs or []):
            try:
                if int(lg["data"], 16) == want_int and len(lg["topics"]) >= 3:
                    matches.append({"from": _topic_addr(lg["topics"][1]),
                                    "to": _topic_addr(lg["topics"][2]),
                                    "block": int(lg["blockNumber"], 16),
                                    "token": token})
            except (ValueError, KeyError):
                pass
        b = end + 1
    return matches, complete


def _known_unique(cands, known, consumed=None):
    """The known-participant prior: when several transfers match amount+time,
    accept iff EXACTLY ONE involves an address we've already seen in resolved
    trades. Transfers already attributed to ANOTHER settlement this run
    (consumed: {(token, block)}) are excluded first — two same-amount
    settlements minutes apart share a candidate set, and without this a
    single on-chain transfer could be assigned to both rows."""
    if not cands or not known:
        return None
    pool = [c for c in cands
            if not (consumed and (c.get("token"), c.get("block")) in consumed)]
    hit = [c for c in pool
           if c["from"] in known or c["to"] in known]
    return hit[0] if len(hit) == 1 else None


def usdc_match(network, usdc_amount, t_epoch, cache_dir,
               known=None, consumed=None):
    """Find the USDC transfer for a settlement by exact amount + time window
    (no tx hash). Returns {buyer_evm, seller_evm, n_candidates, block,
    inferred, [known_unique]} or None. Result cached by (network, amount,
    time).

    Ambiguous results are cached WITH their candidate list ("cands") so the
    known-participant prior can be re-applied on later runs at zero RPC cost.
    Cached known_unique entries are RE-validated against the current `known`
    each run — `known` only grows, and an entry accepted when known was small
    may no longer be unique; stale acceptances get demoted back to ambiguous.
    """
    network = network or "ARBITRUM"
    try:
        want = int(round(float(usdc_amount) * 1e6))
    except (TypeError, ValueError):
        return None
    if not t_epoch or want <= 0:
        return None
    key = f"m_{network}_{want}_{t_epoch}".lower()
    cached = cache_get(cache_dir, key)
    if cached is not None:
        if not cached:
            return None
        if cached.get("n_candidates") == 1:
            return cached
        cands = cached.get("cands")
        if cached.get("known_unique"):
            if not cands:
                return cached            # legacy entry without cands — keep
            ku = _known_unique(cands, known, consumed)
            if ku:
                return {**cached, "buyer_evm": ku["from"],
                        "seller_evm": ku["to"], "token": ku["token"],
                        "block": ku.get("block")}
            demoted = {"n_candidates": cached.get("n_candidates", len(cands)),
                       "cands": cands, "inferred": True}
            cache_put(cache_dir, key, demoted)
            return demoted
        if cands:
            ku = _known_unique(cands, known, consumed)
            if ku:
                out = {"buyer_evm": ku["from"], "seller_evm": ku["to"],
                       "token": ku["token"], "block": ku.get("block"),
                       "n_candidates": len(cands),
                       "known_unique": True, "cands": cands,
                       "inferred": True}
                cache_put(cache_dir, key, out)
                return out
            return cached  # still ambiguous
        # pre-"cands" ambiguous entry: fall through and re-query once so the
        # candidate list gets persisted for future prior passes

    try:
        lo = block_at_time(network, t_epoch - _USDC_WIN_BACK)
        hi = block_at_time(network, t_epoch + _USDC_WIN_FWD)
    except Exception:  # noqa: BLE001
        return None
    cand, complete = [], True
    for tok in USDC_TOKENS.get(network, []):
        m, ok = _logs_chunked(network, tok, lo, hi, want)
        cand += m
        complete = complete and ok
    if not complete:
        # The scan is missing windows (RPC trouble): a lone survivor may not
        # be unique and an empty result may be a false negative. Do not cache
        # anything — keep whatever the cache already held and retry next run.
        return None
    if not cand:
        # A legacy ambiguous entry being re-queried found candidates once —
        # an empty complete scan now is contradictory (logs don't vanish), so
        # keep the old entry rather than downgrading it to "no candidates".
        if not cached:
            cache_put(cache_dir, key, {})
        return None
    if len(cand) > 1:
        try:
            tb = block_at_time(network, t_epoch - _USDC_EXPECT)
        except Exception:  # noqa: BLE001
            tb = (lo + hi) // 2
        cand.sort(key=lambda c: abs(c["block"] - tb))
    keep = [{"from": c["from"], "to": c["to"], "token": c["token"],
             "block": c["block"]} for c in cand[:8]]
    ku = _known_unique(keep, known, consumed) if len(cand) > 1 else None
    c = ku or cand[0]
    out = {"buyer_evm": c["from"], "seller_evm": c["to"],
           "token": c["token"], "block": c.get("block"),
           "n_candidates": len(cand), "inferred": True}
    if len(cand) > 1:
        out["cands"] = keep
        if ku:
            out["known_unique"] = True
    cache_put(cache_dir, key, out)
    return out
