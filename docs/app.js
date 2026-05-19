"use strict";
const D = { trades: [], addresses: [], prices: [], meta: {}, stats: {}, offers: [] };
const addrIndex = new Map();           // address -> aggregate
let charted = false;

const EXP = "https://explorer.pearlresearch.ai";
const SCAN = { ARBITRUM: "https://arbiscan.io", BASE: "https://basescan.org" };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : 0; };
const fmt = (x, d = 2) => num(x).toLocaleString("en-US",
  { maximumFractionDigits: d });
const isEvm = a => typeof a === "string" && a.startsWith("0x");

function short(a) {
  if (!a) return "";
  return a.length > 18 ? a.slice(0, 9) + "…" + a.slice(-6) : a;
}
function txLink(chain, network, txid) {
  if (!txid) return "";
  const u = chain === "pearl"
    ? `${EXP}/tx/${txid}?network=mainnet`
    : `${SCAN[network] || SCAN.ARBITRUM}/tx/${txid}`;
  return `<a href="${u}" target="_blank" rel="noopener">${txid.slice(0, 8)}…</a>`;
}
function addrCell(a, network) {
  if (!a) return `<span class="muted">—</span>`;
  const chain = isEvm(a) ? "evm" : "pearl";
  const u = chain === "pearl"
    ? `${EXP}/address/${a}?network=mainnet`
    : `${SCAN[network] || SCAN.ARBITRUM}/address/${a}`;
  return `<a class="addr" href="#address/${a}" title="${a}">${short(a)}</a>`
    + ` <a class="copy" href="${u}" target="_blank" rel="noopener" title="open in explorer">↗</a>`
    + ` <span class="copy" data-copy="${a}" title="copy">⧉</span>`;
}

async function load() {
  const get = async f => {
    try { const r = await fetch(f, { cache: "no-store" }); return r.ok ? r.json() : null; }
    catch { return null; }
  };
  const [t, a, p, m, s, o] = await Promise.all([
    get("data/trades.json"), get("data/addresses.json"),
    get("data/prices.json"), get("data/meta.json"),
    get("data/stats.json"), get("data/offers.json")]);
  D.trades = t || []; D.addresses = a || []; D.prices = p || [];
  D.meta = m || {}; D.stats = s || {}; D.offers = o || [];
  D.addresses.forEach(x => addrIndex.set(x.address, x));
  buildStatusFilter();
  renderKpis();
  route();
}

function renderKpis() {
  const m = D.meta, s = D.meta.otc_stats || D.stats || {};
  const tr = D.trades.length;
  const traced = D.trades.filter(r =>
    (r.seller_prl || r.seller_evm) && (r.buyer_prl || r.buyer_evm)).length;
  const k = [
    ["traced trades", `${fmt(tr, 0)}`],
    ["fully traced", `${fmt(traced, 0)} (${tr ? Math.round(traced / tr * 100) : 0}%)`],
    ["unique addresses", fmt(D.addresses.length, 0)],
    ["total completed", fmt(s.total_trades_completed, 0)],
    ["volume PRL (all)", fmt(s.total_volume_prl, 0)],
    ["volume USDC (all)", fmt(s.total_volume_usdc, 0)],
    ["24h PRL", fmt(s.volume_24h_prl, 0)],
    ["active offers", fmt(m.active_offers, 0)],
  ];
  $("#kpis").innerHTML = k.map(([l, v]) =>
    `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  const g = m.generated_at ? new Date(m.generated_at).toLocaleString() : "—";
  $("#freshness").textContent = `snapshot: ${g} · ${fmt(tr, 0)} trades`;
}

function buildStatusFilter() {
  const set = [...new Set(D.trades.map(r => r.status))].filter(Boolean).sort();
  $("#f-status").insertAdjacentHTML("beforeend",
    set.map(s => `<option value="${s}">${s}</option>`).join(""));
}

/* ---------- routing ---------- */
function route() {
  const h = location.hash.slice(1) || "trades";
  if (h.startsWith("address/")) { showDetail(decodeURIComponent(h.slice(8))); return; }
  $$(".view").forEach(v => v.classList.add("hidden"));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === h));
  const v = $("#view-" + h);
  (v || $("#view-trades")).classList.remove("hidden");
  if (h === "trades") renderTrades();
  else if (h === "addresses") renderAddresses();
  else if (h === "charts") drawCharts();
  else if (h === "about") renderAbout();
}
window.addEventListener("hashchange", route);

/* ---------- trades ---------- */
let tState = { sort: "id", dir: -1, page: 0, per: 50 };

function filteredTrades() {
  const q = $("#f-search").value.trim().toLowerCase();
  const st = $("#f-status").value, sd = $("#f-side").value,
    nw = $("#f-network").value, ro = $("#f-resolved").checked;
  const from = $("#f-from").value ? new Date($("#f-from").value) : null;
  const to = $("#f-to").value ? new Date($("#f-to").value + "T23:59:59") : null;
  let rows = D.trades.filter(r => {
    if (st && r.status !== st) return false;
    if (sd && r.maker_side !== sd) return false;
    if (nw && r.network !== nw) return false;
    if (ro && !((r.seller_prl || r.seller_evm) && (r.buyer_prl || r.buyer_evm)))
      return false;
    if (from || to) {
      const d = r.time ? new Date(r.time) : null;
      if (!d || (from && d < from) || (to && d > to)) return false;
    }
    if (q) {
      const hay = [r.id, r.seller_prl, r.seller_evm, r.buyer_prl, r.buyer_evm,
        r.deposit_txid, r.release_txid, r.refund_txid, r.usdc_tx_hash]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const k = tState.sort, dir = tState.dir;
  const numeric = ["id", "prl_amount", "usdc_amount", "price_per_prl_usdc"];
  rows.sort((a, b) => {
    let x = a[k], y = b[k];
    if (numeric.includes(k)) { x = num(x); y = num(y); }
    else if (k === "time") { x = x || ""; y = y || ""; }
    else { x = (x || "").toString(); y = (y || "").toString(); }
    return x < y ? -dir : x > y ? dir : 0;
  });
  return rows;
}

function renderTrades() {
  const rows = filteredTrades();
  const per = tState.per, pg = tState.page;
  const slice = rows.slice(pg * per, pg * per + per);
  $("#trades-body").innerHTML = slice.map(r => {
    const t = r.time ? new Date(r.time).toISOString().replace("T", " ").slice(0, 16) : "—";
    return `<tr>
      <td>${r.id}</td><td class="muted">${t}</td>
      <td><span class="pill ${r.maker_side}">${(r.maker_side || "").replace("_PRL", "")}</span></td>
      <td><span class="pill s">${r.status}</span></td>
      <td class="muted">${r.network || ""}</td>
      <td class="num">${fmt(r.prl_amount, 2)}</td>
      <td class="num">${fmt(r.usdc_amount, 2)}</td>
      <td class="num">${fmt(r.price_per_prl_usdc, 4)}</td>
      <td>${addrCell(r.seller_prl)} <span class="tag">prl</span><br>${addrCell(r.seller_evm, r.network)} <span class="tag">evm</span></td>
      <td>${addrCell(r.buyer_prl)} <span class="tag">prl</span><br>${addrCell(r.buyer_evm, r.network)} <span class="tag">evm</span></td>
      <td class="muted">${txLink("pearl", null, r.deposit_txid)} dep<br>
        ${txLink("pearl", null, r.release_txid || r.refund_txid)} ${r.release_txid ? "rel" : r.refund_txid ? "ref" : ""}<br>
        ${txLink("evm", r.network, r.usdc_tx_hash)} usdc</td>
    </tr>`;
  }).join("") || `<tr><td colspan="11" class="muted">no matching trades</td></tr>`;
  $("#t-count").textContent = `${fmt(rows.length, 0)} trades`;
  pager("#t-pager", rows.length, per, pg, n => { tState.page = n; renderTrades(); });
}

/* ---------- addresses ---------- */
let aState = { page: 0, per: 60 };
function filteredAddresses() {
  const q = $("#a-search").value.trim().toLowerCase();
  const ch = $("#a-chain").value, sk = $("#a-sort").value;
  let rows = D.addresses.filter(a =>
    (!ch || a.chain === ch) && (!q || a.address.toLowerCase().includes(q)));
  rows.sort((x, y) => sk === "last_seen"
    ? (y.last_seen || "").localeCompare(x.last_seen || "")
    : num(y[sk]) - num(x[sk]));
  return rows;
}
function renderAddresses() {
  const rows = filteredAddresses();
  const per = aState.per, pg = aState.page;
  $("#addr-body").innerHTML = rows.slice(pg * per, pg * per + per).map(a => `
    <tr class="clk" data-addr="${a.address}">
      <td>${addrCell(a.address, a.network)}</td>
      <td class="muted">${a.chain}${a.network ? " · " + a.network : ""}</td>
      <td class="num">${fmt(a.sold_prl, 0)}</td>
      <td class="num">${fmt(a.bought_prl, 0)}</td>
      <td class="num">${fmt(a.recv_usdc, 0)}</td>
      <td class="num">${fmt(a.paid_usdc, 0)}</td>
      <td class="num">${a.n_trades}</td>
      <td class="muted">${(a.last_seen || "").slice(0, 10)}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">no addresses</td></tr>`;
  $("#a-count").textContent = `${fmt(rows.length, 0)} addresses`;
  pager("#a-pager", rows.length, per, pg, n => { aState.page = n; renderAddresses(); });
  $$("#addr-body tr.clk").forEach(tr =>
    tr.onclick = e => { if (!e.target.closest("a,.copy")) location.hash = "address/" + tr.dataset.addr; });
}

/* ---------- address detail ---------- */
function showDetail(addr) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $$(".tab").forEach(t => t.classList.remove("active"));
  $("#view-detail").classList.remove("hidden");
  const a = addrIndex.get(addr);
  const my = D.trades.filter(r => [r.seller_prl, r.seller_evm,
    r.buyer_prl, r.buyer_evm].includes(addr));
  const network = a ? a.network : (my[0] && my[0].network);
  const scan = isEvm(addr)
    ? `${SCAN[network] || SCAN.ARBITRUM}/address/${addr}`
    : `${EXP}/address/${addr}?network=mainnet`;
  const g = (l, v) => `<div><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const sold = a ? a.sold_prl : my.filter(r => r.seller_prl === addr || r.seller_evm === addr)
    .reduce((s, r) => s + num(r.prl_amount), 0);
  const bought = a ? a.bought_prl : my.filter(r => r.buyer_prl === addr || r.buyer_evm === addr)
    .reduce((s, r) => s + num(r.prl_amount), 0);
  const linked = a && a.linked && a.linked.length
    ? a.linked.map(l => addrCell(l.address) + ` <span class="tag">${l.trades}×</span>`).join(" ")
    : '<span class="muted">—</span>';
  const cps = a && a.counterparties ? a.counterparties.slice(0, 20) : [];

  $("#detail-body").innerHTML = `
    <div class="detail-head">
      <span class="pill s">${isEvm(addr) ? "EVM" + (network ? " · " + network : "") : "PEARL"}</span>
      <span class="addr">${addr}</span>
      <span class="copy" data-copy="${addr}">⧉ copy</span>
      <a href="${scan}" target="_blank" rel="noopener">open in explorer ↗</a>
    </div>
    <div class="dgrid">
      ${g("PRL sold", fmt(sold, 2))}${g("PRL bought", fmt(bought, 2))}
      ${g("USDC received", fmt(a ? a.recv_usdc : 0, 2))}
      ${g("USDC paid", fmt(a ? a.paid_usdc : 0, 2))}
      ${g("trades", my.length)}
      ${g("first seen", (a && a.first_seen || (my.at(-1) || {}).time || "").slice(0, 10))}
      ${g("last seen", (a && a.last_seen || (my[0] || {}).time || "").slice(0, 10))}
    </div>
    <div class="two">
      <div class="card"><h3>Linked addresses (same party, other leg)</h3>${linked}</div>
      <div class="card"><h3>Top counterparties</h3>
        ${cps.length ? cps.map(c => `<div>${addrCell(c.address)} <span class="tag">${c.trades}×</span></div>`).join("") : '<span class="muted">—</span>'}</div>
    </div>
    <div class="card"><h3>Trades involving this address (${my.length})</h3>
    <div class="tablewrap"><table><thead><tr>
      <th>#</th><th>time</th><th>role</th><th>side</th><th class="num">PRL</th>
      <th class="num">USDC</th><th>counterparty</th><th>txs</th></tr></thead><tbody>
      ${my.slice(0, 300).map(r => {
        const role = (r.seller_prl === addr || r.seller_evm === addr) ? "SELLER" : "BUYER";
        const cp = role === "SELLER"
          ? (isEvm(addr) ? r.buyer_evm : r.buyer_prl)
          : (isEvm(addr) ? r.seller_evm : r.seller_prl);
        return `<tr><td>${r.id}</td>
          <td class="muted">${(r.time || "").replace("T", " ").slice(0, 16)}</td>
          <td><span class="pill ${role === "SELLER" ? "SELL_PRL" : "BUY_PRL"}">${role}</span></td>
          <td class="muted">${(r.maker_side || "").replace("_PRL", "")}</td>
          <td class="num">${fmt(r.prl_amount, 2)}</td>
          <td class="num">${fmt(r.usdc_amount, 2)}</td>
          <td>${addrCell(cp, r.network)}</td>
          <td class="muted">${txLink("pearl", null, r.deposit_txid)} ${txLink("evm", r.network, r.usdc_tx_hash)}</td></tr>`;
      }).join("")}
    </tbody></table></div></div>`;
}

/* ---------- charts ---------- */
function drawCharts() {
  if (charted || !window.Chart) { if (!window.Chart) setTimeout(drawCharts, 200); return; }
  charted = true;
  const byDay = {};
  D.trades.forEach(r => {
    if (!r.time) return;
    const d = r.time.slice(0, 10);
    (byDay[d] = byDay[d] || { prl: 0, usdc: 0 });
    byDay[d].prl += num(r.prl_amount); byDay[d].usdc += num(r.usdc_amount);
  });
  const days = Object.keys(byDay).sort();
  new Chart($("#chart-vol"), {
    type: "bar",
    data: {
      labels: days, datasets: [
        { label: "PRL", data: days.map(d => byDay[d].prl), backgroundColor: "#7c9cff" },
        { label: "USDC", data: days.map(d => byDay[d].usdc), backgroundColor: "#3fb27f" }]
    },
    options: { responsive: true, scales: { x: { ticks: { maxTicksLimit: 14 } } } }
  });
  const pts = (D.prices || []).slice().sort((a, b) => a.t - b.t);
  new Chart($("#chart-price"), {
    type: "line",
    data: {
      labels: pts.map(p => new Date(p.t * 1000).toISOString().slice(0, 10)),
      datasets: [{ label: "PRL/USDC", data: pts.map(p => p.p), borderColor: "#e0794a", pointRadius: 0, tension: .2 }]
    },
    options: { responsive: true, scales: { x: { ticks: { maxTicksLimit: 12 } } } }
  });
}

/* ---------- about ---------- */
function renderAbout() {
  const m = D.meta, res = m.resolution || {};
  $("#about-body").innerHTML = `
    <h2>What this is</h2>
    <p>Every <b>settled trade</b> on <code>pearl-otc.com</code> is a PRL↔USDC swap
    across two chains. This tool reconstructs <b>who sold and who bought</b> by
    resolving each trade's on-chain transactions to real addresses.</p>
    <h2>How addresses are traced</h2>
    <p>• <b>Pearl leg</b> (UTXO chain): the PRL seller funds a per-trade 2-of-2
    escrow (<code>deposit_txid</code>); on success PRL is released to the buyer
    (<code>release_txid</code>), else refunded to the seller
    (<code>refund_txid</code>). Inputs/outputs are read from the Pearl explorer.<br>
    • <b>USDC leg</b>: the buyer pays the seller on Arbitrum/Base
    (<code>usdc_tx_hash</code>); the ERC-20 Transfer is decoded via public RPC.<br>
    • Economic roles are derived from transaction direction, not the
    <code>side</code> flag (which only marks who posted the offer).</p>
    <h2>Snapshot</h2>
    <div class="dgrid">
      <div><div class="v">${fmt(m.trades, 0)}</div><div class="l">trades</div></div>
      <div><div class="v">${fmt(res.deposit, 0)}/${fmt(m.trades, 0)}</div><div class="l">pearl deposit resolved</div></div>
      <div><div class="v">${fmt(res.release, 0)}</div><div class="l">release resolved</div></div>
      <div><div class="v">${fmt(res.evm, 0)}</div><div class="l">usdc leg resolved</div></div>
      <div><div class="v">${fmt(res.both_sides, 0)}</div><div class="l">both sides traced</div></div>
      <div><div class="v">${m.generated_at || "—"}</div><div class="l">generated (UTC)</div></div>
    </div>
    <p class="muted">Source data is public. Roles for refunded/cancelled trades
    may be partial (no buyer). Not affiliated with Pearl Research or
    pearl-otc.com — for analysis only.</p>`;
}

/* ---------- shared ---------- */
function pager(sel, total, per, page, go) {
  const pages = Math.ceil(total / per) || 1;
  const el = $(sel);
  if (pages <= 1) { el.innerHTML = ""; return; }
  const b = (txt, n, dis) =>
    `<button class="btn" ${dis ? "disabled" : ""} data-p="${n}">${txt}</button>`;
  el.innerHTML = b("‹ prev", page - 1, page === 0)
    + `<span>page ${page + 1} / ${pages}</span>`
    + b("next ›", page + 1, page >= pages - 1);
  $$("button", el).forEach(x => x.onclick = () => {
    const n = +x.dataset.p; if (n >= 0 && n < pages) go(n);
    window.scrollTo({ top: 0 });
  });
}

function csv() {
  const rows = filteredTrades();
  const cols = ["id", "time", "status", "maker_side", "network", "prl_amount",
    "usdc_amount", "price_per_prl_usdc", "fee_prl", "seller_prl", "seller_evm",
    "buyer_prl", "buyer_evm", "escrow_prl", "deposit_txid", "release_txid",
    "refund_txid", "usdc_tx_hash"];
  const esc = v => `"${(v ?? "").toString().replace(/"/g, '""')}"`;
  const out = [cols.join(",")].concat(
    rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n");
  const u = URL.createObjectURL(new Blob([out], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = u; a.download = `pearl-otc-trades-${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(u);
}

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const c = e.target.closest("[data-copy]");
  if (c) { navigator.clipboard?.writeText(c.dataset.copy); c.textContent = "✓"; setTimeout(() => c.textContent = c.classList.contains("copy") && c.dataset.copy ? "⧉" : c.textContent, 900); }
});
$("#btn-back").onclick = () => { location.hash = "addresses"; };
["f-search", "f-status", "f-side", "f-network", "f-resolved", "f-from", "f-to"]
  .forEach(id => $("#" + id).addEventListener("input",
    () => { tState.page = 0; renderTrades(); }));
["a-search", "a-chain", "a-sort"].forEach(id =>
  $("#" + id).addEventListener("input", () => { aState.page = 0; renderAddresses(); }));
$("#btn-csv").onclick = csv;
$$("#trades-table th[data-sort]").forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  if (tState.sort === k) tState.dir *= -1;
  else { tState.sort = k; tState.dir = (k === "id" || k === "time") ? -1 : 1; }
  tState.page = 0; renderTrades();
});
load();
