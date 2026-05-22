"""Client for the public api.pearl-otc.com endpoints (no auth required)."""
from __future__ import annotations

from common import get

BASE = "https://api.pearl-otc.com"
PAGE = 200  # server-enforced max for limit


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
