# Pearl OTC — Settled Trade Tracer

A zero-backend dashboard that reconstructs **who bought and who sold** on
[pearl-otc.com](https://pearl-otc.com/marketplace), tracing every settled
trade down to the real **EVM** and **Pearl** addresses on both legs.

A scheduled job pulls the public data, resolves on-chain addresses, and
commits a JSON snapshot. The dashboard is a static page (GitHub Pages)
that reads that snapshot — open the link and it just works.

## How it works

Each settled trade is a PRL ↔ USDC swap across two chains:

| Leg | Source | What we extract |
|---|---|---|
| **Pearl** (UTXO chain) | `explorer.pearlresearch.ai/tx/{txid}` | `deposit_txid` → seller funds escrow; `release_txid` → escrow pays buyer; `refund_txid` → escrow returns to seller. vin/vout give the `prl1…` addresses. |
| **USDC** (Arbitrum/Base) | public RPC | `usdc_tx_hash` ERC-20 `Transfer` → buyer (`from`) pays seller (`to`). |
| Trade list / prices / stats | `api.pearl-otc.com` (public, no auth) | `/trades/public/all`, `/public-prices`, `/stats`, `/offers` |

Economic roles are derived from **transaction direction**, not the
`side` flag (which only marks who posted the offer). Resolution results
are cached in `cache/` and committed, so the heavy first backfill runs
once and hourly runs only process new trades.

```
collector/collect.py ─▶ docs/data/*.json (committed) ─▶ docs/ static site
        ▲
  GitHub Actions: hourly schedule + manual backfill
```

## Setup (one time)

1. Create a **public** GitHub repo (free GitHub Pages requires public) and
   push this folder.
2. **Settings → Pages**: Source = *Deploy from a branch*, Branch =
   `main`, Folder = `/docs`.
3. **Settings → Actions → General**: Workflow permissions =
   *Read and write*.
4. Seed the data (pick one):
   - **Actions → refresh → Run workflow** with `backfill = true`, or
   - run locally then push:
     ```
     pip install -r collector/requirements.txt
     python collector/collect.py --backfill
     git add docs/data cache && git commit -m "data: initial backfill" && git push
     ```
5. Open `https://<user>.github.io/<repo>/`. After step 4 the hourly
   workflow keeps it fresh automatically.

## Local development

```
pip install -r collector/requirements.txt
python collector/collect.py --max-pages 1     # quick: first ~200 trades
python -m http.server -d docs 8080            # open http://localhost:8080
```

`--max-pages N` limits how many 200-trade pages to pull (omit for full
history). The first run is slow; later runs reuse `cache/`.

## Dashboard

- **Trades** — sortable/filterable table (side, status, network, date,
  free-text search by address/txid/id); CSV export of the filtered view.
- **Addresses** — per-address rollup of PRL/USDC bought & sold, trade
  count, first/last seen; click through to a profile.
- **Address profile** — linked addresses (same party's other-leg
  address), top counterparties, and every trade it appears in.
- **Charts** — daily PRL/USDC volume and the PRL/USDC price series.

## Notes & limitations

- The Pearl explorer has no public API; addresses are parsed from the
  page's embedded data, so a frontend change there could need a parser
  tweak (`collector/pearl_explorer.py`).
- API coverage: `/trades/public/all` paginates the **full completed
  history**; `/trades/public` adds the **most recent ~200** trades of any
  status. Older REFUNDED/CANCELLED trades are *not* individually exposed
  by the API (only aggregate counts via `/trades/public/stats`), so the
  set of refunded/cancelled rows is the recent window, not all-time.
- Refunded/cancelled trades have no buyer (no release/USDC leg) — their
  rows are intentionally partial (seller side only).
- All inputs are already-public data. Not affiliated with Pearl Research
  or pearl-otc.com; for analysis only.
