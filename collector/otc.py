"""Client for the public pearl-otc.com endpoints (no auth required).

NOTE (2026-06): the site redesign retired the rich api.pearl-otc.com
backend (it now 502s). The only surviving public data feed is
`pearl-otc.com/api/stats/settlements` — a thin, cursor-paginated
settlement stream with NO transaction hashes or addresses (just time,
maker username, prl, usdc, price). Address tracing is therefore only
possible for the frozen historical archive; new settlements carry the
maker username and amounts but cannot be traced on-chain. The old
endpoint helpers below are kept for reference/backfill but are dead.
"""
from __future__ import annotations

from common import get

BASE = "https://api.pearl-otc.com"          # legacy, now 502 (retired)
NEW_BASE = "https://pearl-otc.com"          # redesigned site
PAGE = 200  # server-enforced max for limit


def live_settlements(since_iso: str | None = None,
                     max_pages: int = 400) -> list[dict]:
    """Thin settlement feed via the redesigned endpoint.

    GET /api/stats/settlements?limit=200[&before=<cursor>] →
        {"settlements": [{time, maker, prl, usdc, price}], "next_cursor": <iso>}

    Cursor pagination walks newest→oldest; `before` is an exclusive upper
    bound. We page back until we cross `since_iso` (the newest timestamp we
    already have) so incremental runs only fetch genuinely new rows.
    """
    out: list[dict] = []
    before = None
    for _ in range(max_pages):
        url = f"{NEW_BASE}/api/stats/settlements?limit={PAGE}"
        if before:
            url += "&before=" + before
        data = get(url, kind="json")
        rows = data.get("settlements", []) if isinstance(data, dict) else (data or [])
        if not rows:
            break
        stop = False
        for r in rows:
            t = r.get("time")
            if since_iso and t and t <= since_iso:
                stop = True
                continue
            out.append(r)
        before = data.get("next_cursor") if isinstance(data, dict) else None
        if stop or not before:
            break
    return out


def settled_trades(max_pages: int | None = None) -> list[dict]:
    """Best-available trade history, newest id first.

    API constraints (verified):
      - /trades/public/all : offset paginates, but COMPLETED only (~1052).
      - /trades/public     : every status, but offset is IGNORED (only the
                             newest ~200 are ever returned).
    So we take the full completed history and union the recent all-status
    window; older REFUNDED/CANCELLED trades are not individually exposed
    by the API (only aggregate counts via /trades/public/stats)."""
    by_id: dict = {}

    # Recent window: all statuses (newest ~200), offset not supported.
    try:
        recent = get(f"{BASE}/trades/public?limit={PAGE}", kind="json")
        for r in (recent or []):
            by_id[r.get("id")] = r
    except Exception:  # noqa: BLE001 - completed history below is the core
        pass

    # Full completed history via working offset pagination.
    offset = 0
    page = 0
    while True:
        if max_pages is not None and page >= max_pages:
            break
        data = get(f"{BASE}/trades/public/all?limit={PAGE}&offset={offset}",
                   kind="json")
        rows = data.get("trades", data) if isinstance(data, dict) else data
        if not rows:
            break
        for r in rows:
            by_id.setdefault(r.get("id"), r)
        page += 1
        offset += PAGE
        if len(rows) < PAGE:
            break

    return sorted(by_id.values(), key=lambda r: (r.get("id") or 0),
                  reverse=True)


def offers() -> list[dict]:
    return get(f"{BASE}/offers", kind="json")


def public_prices() -> list[dict]:
    return get(f"{BASE}/public-prices", kind="json")


def stats() -> dict:
    return get(f"{BASE}/stats", kind="json")


def public_stats(window_days: int = 30) -> dict:
    return get(f"{BASE}/trades/public/stats?window_days={window_days}",
               kind="json")


def health() -> dict:
    return get(f"{BASE}/health", kind="json")


def reputation_bulk(ids: list[int]) -> list[dict]:
    """Map user ids -> reputation records (username, trust_tier, trust_score,
    trades_completed/cancelled, total_usdc_volume_traded, is_trusted,
    last_active_at). This is the public endpoint the marketplace uses to
    show seller usernames. Chunked to keep URLs short."""
    out: list[dict] = []
    uniq = sorted({int(i) for i in ids if i is not None})
    for k in range(0, len(uniq), 100):
        chunk = uniq[k:k + 100]
        try:
            rows = get(f"{BASE}/users/reputation-bulk?ids="
                       + ",".join(str(i) for i in chunk), kind="json")
            if isinstance(rows, list):
                out.extend(rows)
        except Exception:  # noqa: BLE001 - identity is best-effort
            continue
    return out
