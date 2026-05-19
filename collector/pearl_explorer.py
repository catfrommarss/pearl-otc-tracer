"""Resolve Pearl-chain txids to addresses via explorer.pearlresearch.ai.

The explorer is a Next.js app with no public API. Each /tx/{txid} page
embeds the transaction as JSON inside the RSC (Flight) stream. Pearl is a
UTXO chain: vin entries only reference previous outputs ({txid, vout,
amount}); vout entries carry {addresses, amount}. We bracket-match the
vin/vout arrays out of the page and json.loads them.
"""
from __future__ import annotations

import json
import re

from common import get, cache_get, cache_put

BASE = "https://explorer.pearlresearch.ai"


def _match_array(text: str, start_bracket: int) -> str:
    """Return the substring of a JSON array starting at index
    start_bracket (which must point at '['), respecting strings."""
    depth = 0
    in_str = False
    esc = False
    for i in range(start_bracket, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return text[start_bracket:i + 1]
    raise ValueError("unbalanced array")


def _extract_array(unescaped: str, key: str):
    m = re.search(r'"%s"\s*:\s*\[' % re.escape(key), unescaped)
    if not m:
        return None
    return json.loads(_match_array(unescaped, m.end() - 1))


def parse_tx_html(html: str) -> dict:
    """Parse a /tx page into {txid, block_height, time, vin, vout}.

    vin: [{txid, vout, amount}]  vout: [{addresses:[...], amount, n}]
    """
    # The RSC payload escapes quotes as \" inside a JS string literal.
    # Unescaping the whole document is harmless for our regex/bracket scan.
    u = html.replace('\\"', '"').replace("\\\\", "\\").replace("\\/", "/")
    vin = _extract_array(u, "vin") or []
    vout = _extract_array(u, "vout") or []
    txid = None
    mt = re.search(r'"txid"\s*:\s*"([0-9a-fA-F]{64})"', u)
    if mt:
        txid = mt.group(1)
    # block_height/time in the RSC stream are not reliably labelled; the OTC
    # API already carries authoritative per-trade timestamps, so we don't
    # depend on these and leave them null.
    bh = None
    ts = None
    # Normalise vout: keep index, addresses, amount.
    nv = []
    for i, o in enumerate(vout):
        nv.append({
            "n": o.get("n", o.get("index", i)),
            "addresses": o.get("addresses") or [],
            "amount": o.get("amount"),
        })
    nvin = [{
        "txid": v.get("txid"),
        "vout": v.get("vout"),
        "amount": v.get("amount"),
        "coinbase": bool(v.get("coinbase")),
    } for v in vin]
    return {"txid": txid, "block_height": bh, "time": ts,
            "vin": nvin, "vout": nv}


def get_tx(txid: str, cache_dir: str) -> dict | None:
    """Fetch + parse a Pearl tx, with on-disk cache. None on hard failure."""
    if not txid:
        return None
    cached = cache_get(cache_dir, txid)
    if cached is not None:
        return cached
    try:
        html = get(f"{BASE}/tx/{txid}?network=mainnet", kind="text")
        tx = parse_tx_html(html)
        if not tx["vout"] and not tx["vin"]:
            return None  # don't cache an empty/failed parse
        cache_put(cache_dir, txid, tx)
        return tx
    except Exception:  # noqa: BLE001 - explorer flaky, treat as unresolved
        return None


def vout_addr(tx: dict, n: int):
    """Addresses of output index n of a parsed tx (for input resolution)."""
    if not tx:
        return []
    for o in tx["vout"]:
        if o["n"] == n:
            return o["addresses"]
    if 0 <= n < len(tx["vout"]):
        return tx["vout"][n]["addresses"]
    return []
