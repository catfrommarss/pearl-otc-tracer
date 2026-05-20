"use strict";
/* Pearl OTC dashboard · T1 spec implementation. */

const D = { trades: [], addresses: [], prices: [], meta: {}, stats: {}, offers: [] };
const addrIndex = new Map();
const charts = {};        // Chart.js instances by canvas id, for destroy/redraw
let chartsTabDrawn = false;
let tradesChartsDrawn = false;

const EXP = "https://explorer.pearlresearch.ai";
const SCAN = { ARBITRUM: "https://arbiscan.io", BASE: "https://basescan.org" };

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ===== helpers ===== */
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : 0; };
const fmt = (x, d = 2) => num(x).toLocaleString("en-US", { maximumFractionDigits: d });
const isEvm = a => typeof a === "string" && a.startsWith("0x");
function compact(n, dollar = false) {
  n = num(n);
  const s = n < 0 ? "-" : "";
  n = Math.abs(n);
  let r;
  if (n >= 1e9) r = (n / 1e9).toFixed(2) + "B";
  else if (n >= 1e6) r = (n / 1e6).toFixed(2) + "M";
  else if (n >= 1e3) r = (n / 1e3).toFixed(1) + "K";
  else r = n.toFixed(0);
  return s + (dollar ? "$" : "") + r;
}
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
function addrLink(a, network) {
  if (!a) return `<span class="muted">—</span>`;
  const chain = isEvm(a) ? "evm" : "pearl";
  const u = chain === "pearl"
    ? `${EXP}/address/${a}?network=mainnet`
    : `${SCAN[network] || SCAN.ARBITRUM}/address/${a}`;
  return `<a class="addr" href="#address/${a}" title="${a}">${short(a)}</a>`
    + ` <a class="copy" href="${u}" target="_blank" rel="noopener" title="浏览器中打开">↗</a>`
    + ` <span class="copy" data-copy="${a}" title="复制">⧉</span>`;
}
function netCell(net) {
  if (!net) return `<span class="muted">—</span>`;
  const cls = net === "BASE" ? "net-base" : "net-arb";
  return `<span class="${cls}">${net === "BASE" ? "base" : "arb"}</span>`;
}
function statusCell(st) {
  if (st === "COMPLETED") return `<span class="st"><span class="dot done"></span>done</span>`;
  if (st === "REFUNDED")  return `<span class="st"><span class="dot refund"></span>refund</span>`;
  if (st === "CANCELLED") return `<span class="st"><span class="dot cancel"></span>cancel</span>`;
  return `<span class="st">${(st || "").toLowerCase()}</span>`;
}
function sideCell(sd) {
  if (sd === "BUY_PRL")  return `<span class="side-buy">buy</span>`;
  if (sd === "SELL_PRL") return `<span class="side-sell">sell</span>`;
  return `<span class="muted">—</span>`;
}
function destroyChart(id) {
  if (charts[id]) { try { charts[id].destroy(); } catch (e) {} delete charts[id]; }
}

/* ===== load ===== */
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

/* ===== KPI strip (4 KPIs, T1 spec) ===== */
function renderKpis() {
  const m = D.meta, s = m.otc_stats || D.stats || {};
  const tr = D.trades.length;
  const traced = D.trades.filter(r =>
    (r.seller_prl || r.seller_evm) && (r.buyer_prl || r.buyer_evm)).length;
  const tracedPct = tr ? (traced / tr * 100).toFixed(1) : "0";

  const k = [
    { v: tracedPct + "%", l: "全量追溯率", d: `${fmt(traced, 0)} / ${fmt(tr, 0)}` },
    { v: compact(s.total_volume_prl), l: "PRL 累计成交",
      d: s.volume_24h_prl ? `+${compact(s.volume_24h_prl)} · 24h` : "", up: true },
    { v: compact(s.total_volume_usdc, true), l: "USDC 累计成交",
      d: s.volume_24h_usdc ? `+${compact(s.volume_24h_usdc, true)} · 24h` : "", up: true },
    { v: fmt(m.active_offers, 0), l: "活跃挂单", d: "" },
  ];
  $("#kpis").innerHTML = k.map(x =>
    `<div class="kpi">
       <div class="v">${x.v}</div>
       <div class="l">${x.l}</div>
       ${x.d ? `<div class="d ${x.up ? "up" : ""}">${x.d}</div>` : ""}
     </div>`).join("");

  const g = m.generated_at ? new Date(m.generated_at).toLocaleString("zh-CN", {hour12:false}) : "—";
  $("#freshness").textContent = `快照：${g} · ${fmt(tr, 0)} 笔`;
}

function buildStatusFilter() {
  const set = [...new Set(D.trades.map(r => r.status))].filter(Boolean).sort();
  const map = { COMPLETED: "done", REFUNDED: "refund", CANCELLED: "cancel" };
  $("#f-status").insertAdjacentHTML("beforeend",
    set.map(s => `<option value="${s}">${map[s] || s.toLowerCase()}</option>`).join(""));
}

/* ===== chart strip: 30d daily volume + price panel ===== */
const PRI = "#4ade80", INFO = "#85B7EB", NEG = "#f87171",
      INK2 = "#9ca3af", INK3 = "#6b7280", ROW = "#15161a";

function renderTradesCharts() {
  if (tradesChartsDrawn || !window.Chart) {
    if (!window.Chart) setTimeout(renderTradesCharts, 200);
    return;
  }
  tradesChartsDrawn = true;

  /* --- 30d daily volume ---
     Pre-build a full 30-day calendar window with zero-filled buckets so
     days without settlements show as 0 and the x-axis stays uniform; then
     fold in completed trades. */
  const byDay = {};
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    byDay[key] = { prl: 0, usdc: 0 };
    days.push(key);
  }
  D.trades.forEach(r => {
    if (r.status !== "COMPLETED" || !r.time) return;
    const day = r.time.slice(0, 10);
    if (!byDay[day]) return;                   // outside the 30-day window
    byDay[day].prl  += num(r.prl_amount);
    byDay[day].usdc += num(r.usdc_amount);
  });
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.color = INK3;

  const pointHoverCommon = {
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHitRadius: 20,                        // generous mouse-target
    pointHoverBorderColor: "#0a0b0e",
    pointHoverBorderWidth: 2,
  };

  destroyChart("chart-30d");
  charts["chart-30d"] = new Chart($("#chart-30d"), {
    type: "line",
    data: {
      labels: days.map(d => d.slice(5)),
      datasets: [
        { label: "PRL",  data: days.map(d => byDay[d].prl),  borderColor: PRI,
          backgroundColor: "rgba(74,222,128,.12)", borderWidth: 2,
          tension: 0, fill: true, yAxisID: "y",
          pointHoverBackgroundColor: PRI, ...pointHoverCommon },
        { label: "USDC", data: days.map(d => byDay[d].usdc), borderColor: INFO,
          borderWidth: 1.5, borderDash: [5, 4],
          tension: 0, fill: false, yAxisID: "y",
          pointHoverBackgroundColor: INFO, ...pointHoverCommon },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },   // hover anywhere on column
      plugins: {
        legend: { position: "bottom",
          labels: { boxWidth: 16, boxHeight: 2, font: { size: 11 } } },
        tooltip: {
          backgroundColor: "rgba(14,16,20,0.96)",
          borderColor: "#1c1e24", borderWidth: 1,
          padding: 10, cornerRadius: 6,
          titleFont: { family: "'JetBrains Mono'", size: 11, weight: "500" },
          bodyFont:  { family: "'JetBrains Mono'", size: 12 },
          titleColor: "#e5e7eb", bodyColor: "#9ca3af",
          displayColors: true, boxWidth: 10, boxHeight: 2,
          callbacks: {
            title: items => {
              const i = items[0]?.dataIndex;
              return (i != null && days[i]) ? days[i] : (items[0]?.label || "");
            },
            label: ctx => `  ${ctx.dataset.label}  ${
              ctx.parsed.y.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          }
        }
      },
      scales: {
        x: { grid: { color: ROW, drawBorder: false }, ticks: { maxTicksLimit: 8 } },
        y: { grid: { color: ROW, drawBorder: false }, ticks: { callback: v => compact(v) } }
      }
    }
  });

  /* --- price panel: current + 24h delta + sparkline --- */
  const pts = (D.prices || []).slice().sort((a, b) => a.t - b.t);
  if (pts.length) {
    const last = pts[pts.length - 1];
    const cutoff24 = last.t - 86400;
    // most recent point at or before 24h ago
    let prev = pts[0];
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= cutoff24) { prev = pts[i]; break; }
    const delta = prev.p ? (last.p - prev.p) / prev.p * 100 : 0;
    const up = delta >= 0;
    $("#price-now").textContent = last.p.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    const arrow = up ? "▲" : "▼";
    $("#price-dlt").textContent = `${arrow} ${up ? "+" : ""}${delta.toFixed(2)}% · 24h`;
    $("#price-dlt").className = "dlt " + (up ? "up" : "dn");

    // sparkline: last 30 days of prices
    const cut30 = last.t - 30 * 86400;
    const recent = pts.filter(x => x.t >= cut30);
    destroyChart("chart-spark");
    charts["chart-spark"] = new Chart($("#chart-spark"), {
      type: "line",
      data: {
        labels: recent.map(x => x.t),
        datasets: [{
          data: recent.map(x => x.p), borderColor: up ? PRI : NEG,
          backgroundColor: up ? "rgba(74,222,128,.18)" : "rgba(248,113,113,.18)",
          borderWidth: 2, pointRadius: 0, tension: .25, fill: true
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } }
      }
    });
  }
}

/* ===== top buyers (24h) ===== */
function renderTopBuyers() {
  const cutoff = Date.now() - 86400 * 1000;
  const acc = new Map();
  D.trades.forEach(r => {
    if (r.status !== "COMPLETED" || !r.time) return;
    const ts = new Date(r.time).getTime();
    if (ts < cutoff) return;
    const key = r.buyer_evm || r.buyer_prl;
    if (!key) return;
    const cur = acc.get(key) || { addr: key, amt: 0, n: 0, nets: new Set(),
      otherSide: r.buyer_evm ? r.buyer_prl : r.buyer_evm };
    cur.amt += num(r.prl_amount);
    cur.n += 1;
    if (r.network) cur.nets.add(r.network);
    acc.set(key, cur);
  });
  const list = [...acc.values()].sort((a, b) => b.amt - a.amt).slice(0, 8);
  const body = $("#top-buyers-body");
  if (!list.length) {
    body.innerHTML = `<div class="empty">过去 24h 暂无成交</div>`;
    return;
  }
  const max = list[0].amt;
  body.innerHTML = list.map((x, i) => {
    const w = max ? (x.amt / max * 100) : 0;
    const op = (1 - i * 0.5 / Math.max(list.length - 1, 1)).toFixed(2);
    return `<div class="tb-row" data-addr="${x.addr}">
      <span class="addr">${short(x.addr)}</span>
      <span class="bar-wrap"><span class="bar" style="width:${w.toFixed(1)}%;opacity:${op}"></span></span>
      <span class="v">${fmt(x.amt, 0)}<span class="u">PRL</span></span>
    </div>`;
  }).join("");
  $$(".tb-row", body).forEach(el =>
    el.onclick = () => { location.hash = "address/" + el.dataset.addr; });
}

/* ===== routing ===== */
function route() {
  const h = location.hash.slice(1) || "trades";
  if (h.startsWith("address/")) { showDetail(decodeURIComponent(h.slice(8))); return; }
  $$(".view").forEach(v => v.classList.add("hidden"));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === h));
  const v = $("#view-" + h);
  (v || $("#view-trades")).classList.remove("hidden");
  if (h === "trades") { renderTrades(); renderTradesCharts(); renderTopBuyers(); }
  else if (h === "addresses") renderAddresses();
  else if (h === "charts") drawCharts();
  else if (h === "about") renderAbout();
}
window.addEventListener("hashchange", route);

/* ===== trades table (10 cols) ===== */
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
    const t = r.time ? r.time.slice(5, 16).replace("T", " ") : "—";
    const sellerCell = (r.seller_prl || r.seller_evm)
      ? `<div class="addr-stack">
           <div class="a1">${r.seller_prl ? `<a href="#address/${r.seller_prl}">${short(r.seller_prl)}</a>` : "—"}</div>
           <div class="a2">${r.seller_evm ? `<a href="#address/${r.seller_evm}">${short(r.seller_evm)}</a>` : "—"}</div>
         </div>`
      : `<span class="muted">未上链</span>`;
    const txCell = (r.deposit_txid || r.release_txid || r.refund_txid || r.usdc_tx_hash)
      ? `<td class="txs">
           <span class="txs-toggle" data-tid="${r.id}">•••</span>
           <div class="txs-pop" id="pop-${r.id}" hidden>
             ${r.deposit_txid ? `<div class="row"><span class="k">deposit</span><span class="v">${txLink("pearl",null,r.deposit_txid)}</span></div>` : ""}
             ${r.release_txid ? `<div class="row"><span class="k">release</span><span class="v">${txLink("pearl",null,r.release_txid)}</span></div>` : ""}
             ${r.refund_txid  ? `<div class="row"><span class="k">refund</span><span class="v">${txLink("pearl",null,r.refund_txid)}</span></div>` : ""}
             ${r.usdc_tx_hash ? `<div class="row"><span class="k">usdc</span><span class="v">${txLink("evm",r.network,r.usdc_tx_hash)}</span></div>` : ""}
           </div>
         </td>`
      : `<td class="txs muted">—</td>`;
    return `<tr>
      <td class="id">${r.id}</td>
      <td class="time">${t}</td>
      <td>${sideCell(r.maker_side)}</td>
      <td>${statusCell(r.status)}</td>
      <td>${netCell(r.network)}</td>
      <td class="num">${fmt(r.prl_amount, 2)}</td>
      <td class="num">${r.usdc_amount ? fmt(r.usdc_amount, 2) : '<span class="muted">—</span>'}</td>
      <td class="num">${r.price_per_prl_usdc ? fmt(r.price_per_prl_usdc, 4) : '<span class="muted">—</span>'}</td>
      <td>${sellerCell}</td>
      ${txCell}
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="muted" style="text-align:center;padding:20px">无匹配成交</td></tr>`;
  $("#t-count").textContent = `${fmt(rows.length, 0)} 笔`;
  pager("#t-pager", rows.length, per, pg, n => { tState.page = n; renderTrades(); });
}

/* ===== addresses ===== */
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
      <td>${addrLink(a.address, a.network)}</td>
      <td class="muted">${a.chain}${a.network ? " · " + a.network.toLowerCase() : ""}</td>
      <td class="num">${fmt(a.sold_prl, 0)}</td>
      <td class="num">${fmt(a.bought_prl, 0)}</td>
      <td class="num">${fmt(a.recv_usdc, 0)}</td>
      <td class="num">${fmt(a.paid_usdc, 0)}</td>
      <td class="num">${a.n_trades}</td>
      <td class="muted">${(a.last_seen || "").slice(0, 10)}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">无匹配地址</td></tr>`;
  $("#a-count").textContent = `${fmt(rows.length, 0)} 个地址`;
  pager("#a-pager", rows.length, per, pg, n => { aState.page = n; renderAddresses(); });
  $$("#addr-body tr.clk").forEach(tr =>
    tr.onclick = e => { if (!e.target.closest("a,.copy")) location.hash = "address/" + tr.dataset.addr; });
}

/* ===== address detail ===== */
function showDetail(addr) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $$(".tab").forEach(t => t.classList.remove("active"));
  $("#view-detail").classList.remove("hidden");
  const a = addrIndex.get(addr);
  const my = D.trades.filter(r =>
    [r.seller_prl, r.seller_evm, r.buyer_prl, r.buyer_evm].includes(addr));
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
    ? a.linked.map(l => addrLink(l.address) + ` <span class="muted">${l.trades}×</span>`).join("　")
    : '<span class="muted">—</span>';
  const cps = a && a.counterparties ? a.counterparties.slice(0, 20) : [];

  $("#detail-body").innerHTML = `
    <div class="detail-head">
      <span class="pill s">${isEvm(addr) ? "EVM" + (network ? " · " + network.toLowerCase() : "") : "PEARL"}</span>
      <span class="addr mono">${addr}</span>
      <span class="copy" data-copy="${addr}">⧉ 复制</span>
      <a href="${scan}" target="_blank" rel="noopener">浏览器打开 ↗</a>
    </div>
    <div class="dgrid">
      ${g("PRL 卖出", fmt(sold, 2))}${g("PRL 买入", fmt(bought, 2))}
      ${g("USDC 收入", fmt(a ? a.recv_usdc : 0, 2))}
      ${g("USDC 支出", fmt(a ? a.paid_usdc : 0, 2))}
      ${g("成交数", my.length)}
      ${g("首次出现", (a && a.first_seen || (my.at(-1) || {}).time || "").slice(0, 10))}
      ${g("最近活跃", (a && a.last_seen  || (my[0]    || {}).time || "").slice(0, 10))}
    </div>
    <div class="two">
      <div class="card"><h3>同方关联地址（同一方的另一腿）</h3>${linked}</div>
      <div class="card"><h3>主要对手方</h3>
        ${cps.length ? cps.map(c => `<div>${addrLink(c.address)} <span class="muted">${c.trades}×</span></div>`).join("") : '<span class="muted">—</span>'}</div>
    </div>
    <div class="card"><h3>该地址的成交（${my.length} 笔）</h3>
    <div class="tablewrap"><table><thead><tr>
      <th>#</th><th>时间</th><th>角色</th><th>方向</th><th class="num">PRL</th>
      <th class="num">USDC</th><th>对手方</th><th>tx</th></tr></thead><tbody>
      ${my.slice(0, 300).map(r => {
        const role = (r.seller_prl === addr || r.seller_evm === addr) ? "SELLER" : "BUYER";
        const roleLabel = role === "SELLER"
          ? `<span class="side-sell">卖方</span>`
          : `<span class="side-buy">买方</span>`;
        const cp = role === "SELLER"
          ? (isEvm(addr) ? r.buyer_evm : r.buyer_prl)
          : (isEvm(addr) ? r.seller_evm : r.seller_prl);
        return `<tr><td class="id">${r.id}</td>
          <td class="time">${(r.time || "").slice(5, 16).replace("T", " ")}</td>
          <td>${roleLabel}</td>
          <td>${sideCell(r.maker_side)}</td>
          <td class="num">${fmt(r.prl_amount, 2)}</td>
          <td class="num">${r.usdc_amount ? fmt(r.usdc_amount, 2) : "—"}</td>
          <td>${addrLink(cp, r.network)}</td>
          <td class="muted">${txLink("pearl", null, r.deposit_txid)} ${txLink("evm", r.network, r.usdc_tx_hash)}</td></tr>`;
      }).join("")}
    </tbody></table></div></div>`;
}

/* ===== charts tab ===== */
function drawCharts() {
  if (chartsTabDrawn || !window.Chart) { if (!window.Chart) setTimeout(drawCharts, 200); return; }
  chartsTabDrawn = true;
  const byDay = {};
  D.trades.forEach(r => {
    if (!r.time) return;
    const d = r.time.slice(0, 10);
    (byDay[d] = byDay[d] || { prl: 0, usdc: 0 });
    byDay[d].prl += num(r.prl_amount); byDay[d].usdc += num(r.usdc_amount);
  });
  const days = Object.keys(byDay).sort();
  destroyChart("chart-vol");
  charts["chart-vol"] = new Chart($("#chart-vol"), {
    type: "bar",
    data: {
      labels: days, datasets: [
        { label: "PRL", data: days.map(d => byDay[d].prl), backgroundColor: PRI },
        { label: "USDC", data: days.map(d => byDay[d].usdc), backgroundColor: INFO }]
    },
    options: { responsive: true,
      scales: { x: { ticks: { maxTicksLimit: 14 }, grid: { color: ROW } },
                y: { grid: { color: ROW } } } }
  });
  const pts = (D.prices || []).slice().sort((a, b) => a.t - b.t);
  destroyChart("chart-price");
  charts["chart-price"] = new Chart($("#chart-price"), {
    type: "line",
    data: {
      labels: pts.map(p => new Date(p.t * 1000).toISOString().slice(0, 10)),
      datasets: [{ label: "PRL/USDC", data: pts.map(p => p.p), borderColor: PRI,
        pointRadius: 0, tension: .2, borderWidth: 2 }]
    },
    options: { responsive: true,
      scales: { x: { ticks: { maxTicksLimit: 12 }, grid: { color: ROW } },
                y: { grid: { color: ROW } } } }
  });
}

/* ===== about ===== */
function renderAbout() {
  const m = D.meta, res = m.resolution || {};
  $("#about-body").innerHTML = `
    <h2>这是什么</h2>
    <p>每笔 <code>pearl-otc.com</code> 上的 <b>成交</b>都是横跨两条链的 PRL ↔ USDC 兑换。
    这个看板把每笔成交的链上交易反查到真实地址，还原 <b>谁在卖、谁在买</b>。</p>
    <h2>地址是怎么追溯的</h2>
    <p>• <b>Pearl 腿</b>（UTXO 链）：PRL 卖方把币转入一个一次性 2-of-2 multisig 托管地址
    （<code>deposit_txid</code>）；成交成功则释放给买方（<code>release_txid</code>），
    失败则退还给卖方（<code>refund_txid</code>）。vin/vout 从 Pearl 区块浏览器解析。<br>
    • <b>USDC 腿</b>：买方在 Arbitrum/Base 上付款给卖方（<code>usdc_tx_hash</code>），
    通过公共 RPC 解码 ERC-20 Transfer 日志得到买方/卖方 EVM 地址。<br>
    • 经济角色（买/卖）由交易方向推导，与 <code>side</code> 标记无关
    （后者只标注谁挂的单）。</p>
    <h2>数据快照</h2>
    <div class="dgrid">
      <div><div class="v">${fmt(m.trades, 0)}</div><div class="l">成交总笔数</div></div>
      <div><div class="v">${fmt(res.deposit, 0)}/${fmt(m.trades, 0)}</div><div class="l">Pearl deposit 已解析</div></div>
      <div><div class="v">${fmt(res.release, 0)}</div><div class="l">release 已解析</div></div>
      <div><div class="v">${fmt(res.evm, 0)}</div><div class="l">USDC 腿已解析</div></div>
      <div><div class="v">${fmt(res.both_sides, 0)}</div><div class="l">双边都已追溯</div></div>
      <div><div class="v">${m.generated_at || "—"}</div><div class="l">生成时间 (UTC)</div></div>
    </div>
    <p class="muted">数据全部来自公开接口。退款 / 取消的成交因没有买方腿，记录会是部分的（仅卖方侧）。
    本工具与 Pearl Research / pearl-otc.com 无关联，仅供分析用。</p>`;
}

/* ===== shared ===== */
function pager(sel, total, per, page, go) {
  const pages = Math.ceil(total / per) || 1;
  const el = $(sel);
  if (pages <= 1) { el.innerHTML = ""; return; }
  const b = (txt, n, dis) =>
    `<button class="btn" ${dis ? "disabled" : ""} data-p="${n}">${txt}</button>`;
  el.innerHTML = b("← 上一页", page - 1, page === 0)
    + `<span>第 ${page + 1} / ${pages} 页</span>`
    + b("下一页 →", page + 1, page >= pages - 1);
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
  const u = URL.createObjectURL(new Blob(["﻿" + out], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = u; a.download = `pearl-otc-trades-${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(u);
}

/* ===== events ===== */
document.addEventListener("click", e => {
  // copy buttons
  const c = e.target.closest("[data-copy]");
  if (c) {
    navigator.clipboard?.writeText(c.dataset.copy);
    const orig = c.textContent;
    c.textContent = "✓";
    setTimeout(() => { c.textContent = orig; }, 900);
    return;
  }
  // tx fold toggle
  const t = e.target.closest(".txs-toggle");
  if (t) {
    const pop = $("#pop-" + t.dataset.tid);
    const wasOpen = !pop.hasAttribute("hidden");
    $$(".txs-pop").forEach(p => p.setAttribute("hidden", ""));
    $$(".txs-toggle.open").forEach(x => x.classList.remove("open"));
    if (!wasOpen) { pop.removeAttribute("hidden"); t.classList.add("open"); }
    e.stopPropagation();
    return;
  }
  // click outside closes popovers
  if (!e.target.closest(".txs-pop")) {
    $$(".txs-pop").forEach(p => p.setAttribute("hidden", ""));
    $$(".txs-toggle.open").forEach(x => x.classList.remove("open"));
  }
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
