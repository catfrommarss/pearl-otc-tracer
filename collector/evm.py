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
            # No transfer close to the expected amount: still record the
            # largest movement but flag it as approximate.
            pick = max(transfers, key=lambda t: t["value"])

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
