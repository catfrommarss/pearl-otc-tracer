"""Turn a raw OTC trade + resolved txids into a normalized buyer/seller row.

Pearl OTC flow (mechanically identical regardless of `side`):
  - the PRL seller funds a per-trade 2-of-2 escrow (deposit_txid:
    seller inputs -> [escrow output, change back to seller])
  - the PRL buyer pays USDC on Arbitrum/Base (usdc_tx_hash:
    buyer_evm -> seller_evm)
  - on success PRL is released from escrow (release_txid:
    escrow -> [buyer, platform fee])
  - on failure PRL is refunded (refund_txid: escrow -> seller)

`side` (SELL_PRL / BUY_PRL) only tells us which party posted the offer
(the maker); economic roles are derived from tx direction, not `side`.
"""
from __future__ import annotations

from pearl_explorer import get_tx, vout_addr


def _f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def _escrow_index(deposit_txid, spender_tx):
    """Index of the deposit output that the release/refund tx spends."""
    if not spender_tx:
        return None
    for vin in spender_tx["vin"]:
        if vin.get("txid") == deposit_txid:
            return vin.get("vout")
    # Single-input spender is unambiguous even if the txid string differs.
    if len(spender_tx["vin"]) == 1:
        return spender_tx["vin"][0].get("vout")
    return None


def correlate(trade: dict, pearl_cache: str, evm_resolver) -> dict:
    dep = trade.get("deposit_txid")
    rel = trade.get("release_txid")
    ref = trade.get("refund_txid")
    prl_amount = _f(trade.get("prl_amount"))
    fee_prl = _f(trade.get("fee_prl"))

    D = get_tx(dep, pearl_cache) if dep else None
    R = get_tx(rel, pearl_cache) if rel else None
    F = get_tx(ref, pearl_cache) if ref else None

    seller_prl, buyer_prl, escrow_prl, fee_prl_addr = [], [], [], []
    flags = []

    if D:
        esc_n = _escrow_index(dep, R) if R else _escrow_index(dep, F)
        esc_set = set()
        if esc_n is not None:
            esc_set = set(vout_addr(D, esc_n))
            escrow_prl = sorted(esc_set)
        # seller change = deposit outputs that are not the escrow
        change = [o for o in D["vout"]
                  if not (set(o["addresses"]) & esc_set)]
        if change:
            change.sort(key=lambda o: _f(o["amount"]), reverse=True)
            for o in change:
                for a in o["addresses"]:
                    if a not in seller_prl:
                        seller_prl.append(a)
        else:
            # No change output: fall back to resolving a funding input.
            for vin in D["vin"]:
                pv = get_tx(vin.get("txid"), pearl_cache)
                for a in vout_addr(pv, vin.get("vout")):
                    if a not in seller_prl:
                        seller_prl.append(a)
                if seller_prl:
                    break
            flags.append("seller_prl_from_vin")
        if esc_n is None:
            flags.append("escrow_unresolved")

    # A refund output is escrow -> seller by definition, so for refunded
    # trades it is the authoritative seller address (it overrides the
    # deposit-change heuristic; a user's change and refund addresses can
    # legitimately differ, so that is not flagged as an error).
    if F:
        ref_out = sorted(F["vout"], key=lambda o: _f(o["amount"]),
                         reverse=True)
        ra = [a for o in ref_out for a in o["addresses"]]
        if ra:
            seller_prl = ra

    # Release tx: largest output = buyer; small ~fee output = platform fee.
    if R:
        outs = sorted(R["vout"], key=lambda o: _f(o["amount"]), reverse=True)
        for o in outs:
            amt = _f(o["amount"])
            is_fee = fee_prl > 0 and abs(amt - fee_prl) <= max(
                0.02 * fee_prl, 0.001)
            target = (not buyer_prl and not is_fee)
            for a in o["addresses"]:
                if target and a not in buyer_prl:
                    buyer_prl.append(a)
                elif is_fee and a not in fee_prl_addr:
                    fee_prl_addr.append(a)

    ev = None
    if trade.get("usdc_tx_hash"):
        ev = evm_resolver(trade["usdc_tx_hash"], trade.get("network"),
                          trade.get("usdc_amount"))

    when = (trade.get("completed_at") or trade.get("cancelled_at")
            or trade.get("deposited_at") or trade.get("created_at"))

    return {
        "id": trade.get("id"),
        "status": trade.get("status"),
        "maker_side": trade.get("side"),
        "network": trade.get("network"),
        "prl_amount": trade.get("prl_amount"),
        "usdc_amount": trade.get("usdc_amount"),
        "price_per_prl_usdc": trade.get("price_per_prl_usdc"),
        "fee_prl": trade.get("fee_prl"),
        "created_at": trade.get("created_at"),
        "deposited_at": trade.get("deposited_at"),
        "usdc_tx_verified_at": trade.get("usdc_tx_verified_at"),
        "completed_at": trade.get("completed_at"),
        "cancelled_at": trade.get("cancelled_at"),
        "time": when,
        # PRL seller = funds escrow, receives USDC.
        "seller_prl": seller_prl[0] if seller_prl else None,
        "seller_prl_all": seller_prl,
        "seller_evm": ev["seller_evm"] if ev else None,
        # PRL buyer = pays USDC, receives PRL.
        "buyer_prl": buyer_prl[0] if buyer_prl else None,
        "buyer_prl_all": buyer_prl,
        "buyer_evm": ev["buyer_evm"] if ev else None,
        "escrow_prl": escrow_prl[0] if escrow_prl else None,
        "fee_prl_addr": fee_prl_addr[0] if fee_prl_addr else None,
        "usdc_value": ev["value_usdc"] if ev else None,
        "usdc_token": ev["token"] if ev else None,
        "deposit_txid": dep,
        "release_txid": rel,
        "refund_txid": ref,
        "usdc_tx_hash": trade.get("usdc_tx_hash"),
        "resolved": {
            "deposit": bool(D), "release": bool(R), "refund": bool(F),
            "evm": bool(ev),
        },
        "flags": flags,
    }
