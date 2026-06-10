"use strict";
/* Pearl OTC dashboard · T1 spec implementation. */

const D = { trades: [], addresses: [], prices: [], meta: {}, identities: {},
  entities: {}, whales: {}, safetrade: {}, market: {} };
const addrIndex = new Map();
const charts = {};        // Chart.js instances by canvas id, for destroy/redraw
let chartsTabDrawn = false;
let tradesChartsDrawn = false;

const EXP = "https://explorer.pearlresearch.ai";
const SCAN = { ARBITRUM: "https://arbiscan.io", BASE: "https://basescan.org" };

/* ===== time helpers (UTC <-> local toggle) ===== */
let tzMode = localStorage.getItem("tz-mode") === "local" ? "local" : "utc";
function pad2(n) { return String(n).padStart(2, "0"); }
function formatTime(iso, mode /* 'full' | 'short' */) {
  if (!iso) return "—";
  if (tzMode === "utc") {
    // iso = "2026-05-19T14:56:17.123Z"
    const s = iso.slice(0, 19).replace("T", " ");
    return mode === "short" ? s.slice(5, 16) : s;
  }
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const yr = d.getFullYear(), mo = pad2(d.getMonth() + 1), da = pad2(d.getDate());
  const hr = pad2(d.getHours()), mi = pad2(d.getMinutes());
  return mode === "short" ? `${mo}-${da} ${hr}:${mi}` : `${yr}-${mo}-${da} ${hr}:${mi}`;
}
function tzSuffix() { return tzMode === "utc" ? "UTC" : "本地"; }

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ===== helpers ===== */
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : 0; };
const fmt = (x, d = 2) => num(x).toLocaleString("en-US", { maximumFractionDigits: d });
// Amount-adaptive: 0 decimals when ≥ 1,000 (large amounts read cleaner
// without ".00"), 2 decimals in the normal range, 4 decimals when < 1.
function fmtAmt(x) {
  const n = num(x);
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
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
/* ===== custom labels (committed shared layer + localStorage personal) =====
   Personal labels override shared. Both keyed by address. */
let sharedLabels = {};
let personalLabels = {};
try { personalLabels = JSON.parse(localStorage.getItem("pearl-labels") || "{}"); }
catch { personalLabels = {}; }
function labelOf(a) {
  if (!a) return "";
  return (personalLabels[a] || sharedLabels[a] || "").trim();
}
function setLabel(a, text) {
  text = (text || "").trim();
  if (text) personalLabels[a] = text; else delete personalLabels[a];
  try { localStorage.setItem("pearl-labels", JSON.stringify(personalLabels)); }
  catch {}
}
function labelChip(a) {
  const l = labelOf(a);
  if (!l) return "";
  const esc = l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return ` <span class="tag-chip" title="自定义标签：${esc}">${esc}</span>`;
}

/* ===== identities (address -> pearl-otc username + reputation) ===== */
function idOf(a) { return a ? D.identities[a] : null; }
// trust_tier -> color class. Observed tiers: excellent > good > fair >
// low > poor, plus "new". Unknown tiers fall back to neutral gray.
const TIER_CLASS = {
  excellent: "t-good", good: "t-good", trusted: "t-good",
  fair: "t-fair", ok: "t-fair",
  new: "t-new",
  low: "t-poor", poor: "t-poor", bad: "t-poor" };
function unameBadge(a) {
  const id = idOf(a);
  if (!id || !id.username) return "";
  const cls = TIER_CLASS[(id.trust_tier || "").toLowerCase()] || "t-new";
  const tip = `@${id.username} · 信誉:${id.trust_tier || "?"} · 平台成交 ${id.trades_completed ?? "?"}`;
  return ` <span class="uname ${cls}" title="${tip}">@${id.username}</span>`;
}
// Entity labels from prlscan (Safetrade / bridge / pool / system / OTC).
const ENTITY_CLASS = { system: "e-sys", exchange: "e-cex", bridge: "e-bridge",
  bridge_treasury: "e-bridge", pool: "e-pool", pearl_otc: "e-otc" };
function entityOf(a) { return a ? D.entities[a] : null; }
function entityBadge(a) {
  const e = entityOf(a);
  if (!e || !e.label) return "";
  // an OTC-username entity is already shown via unameBadge — skip dup
  if ((e.kind || "") === "pearl_otc") return "";
  const cls = ENTITY_CLASS[(e.kind || "system").toLowerCase()] || "e-sys";
  return ` <span class="ent ${cls}" title="链上实体：${e.label}">${e.label}</span>`;
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
  // data-addr lets the hover-highlight handler tag every occurrence of
  // the same address across the page.
  return `<a class="addr" data-addr="${a}" href="#address/${a}" title="${a}">${short(a)}</a>`
    + unameBadge(a) + entityBadge(a) + labelChip(a)
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
  // "side" labels the maker (who posted the offer), not the trade
  // direction. Use 卖单/买单 (sell-listing / buy-listing) so it can't be
  // mistaken for "this address bought/sold" — that's derived from the
  // seller/buyer columns instead.
  if (sd === "BUY_PRL")  return `<span class="side-buy" title="挂买单(maker=买方)">买单</span>`;
  if (sd === "SELL_PRL") return `<span class="side-sell" title="挂卖单(maker=卖方)">卖单</span>`;
  return `<span class="muted">—</span>`;
}
function destroyChart(id) {
  if (charts[id]) { try { charts[id].destroy(); } catch (e) {} delete charts[id]; }
}

/* ===== load ===== */
const _get = async f => {
  try { const r = await fetch(f, { cache: "no-store" }); return r.ok ? r.json() : null; }
  catch { return null; }
};
// addresses.json is the heaviest file (~2 MB) and only the 地址 tab needs
// it (the detail page derives everything from trades). Load it lazily.
let _addrLoading = null;
async function ensureAddresses() {
  if (D.addresses.length) return;
  if (!_addrLoading) _addrLoading = _get("data/addresses.json").then(a => {
    D.addresses = a || [];
    D.addresses.forEach(x => addrIndex.set(x.address, x));
  });
  await _addrLoading;
}

async function load() {
  // Eager: everything the default 成交 tab needs. Skip addresses.json.
  const [t, p, m, ids, lab, ent, wh, st, mk] = await Promise.all([
    _get("data/trades.json"), _get("data/prices.json"),
    _get("data/meta.json"), _get("data/identities.json"),
    _get("data/labels.json"), _get("data/entities.json"),
    _get("data/whales.json"), _get("data/safetrade.json"),
    _get("data/market.json")]);
  D.trades = t || []; D.prices = p || [];
  D.meta = m || {}; D.identities = ids || {};
  sharedLabels = lab || {};
  D.entities = ent || {}; D.whales = wh || {};
  D.safetrade = st || {}; D.market = mk || {};
  buildStatusFilter();
  renderKpis();
  route();
}

/* ===== KPI strip (4 KPIs, T1 spec) ===== */
function renderKpis() {
  const m = D.meta, s = m.otc_stats || {};
  const tr = D.trades.length;
  // "Fully traced" = all four legs identified (seller+buyer on both PRL
  // and EVM sides). Earlier we accepted "either leg on each side" which
  // showed 100% even when 2% of COMPLETED rows were missing the EVM leg
  // due to non-standard payment paths. Honest definition is stricter.
  // Traced% is measured over the ARCHIVE era only — live (post-redesign)
  // settlements carry no addresses and can never be "fully traced", so
  // including them would make the rate fall as live data grows.
  const archiveCompleted = D.trades.filter(r =>
    r.status === "COMPLETED" && r.source !== "live");
  const tracedC = archiveCompleted.filter(r =>
    r.seller_prl && r.seller_evm && r.buyer_prl && r.buyer_evm).length;
  const tracedPct = archiveCompleted.length
    ? (tracedC / archiveCompleted.length * 100).toFixed(1) : "0";

  const k = [
    { v: tracedPct + "%", l: "完整追溯率（存档）",
      d: `${fmt(tracedC, 0)} / ${fmt(archiveCompleted.length, 0)} 存档成交` },
    { v: compact(s.total_volume_prl), l: "PRL 累计成交",
      d: s.volume_24h_prl ? `+${compact(s.volume_24h_prl)} · 24h` : "", up: true },
    { v: compact(s.total_volume_usdc, true), l: "USDC 累计成交",
      d: s.volume_24h_usdc ? `+${compact(s.volume_24h_usdc, true)} · 24h` : "", up: true },
    { v: fmt(s.trades_24h, 0), l: "24h 成交笔数",
      d: s.volume_24h_prl ? `${compact(s.volume_24h_prl)} PRL` : "" },
  ];
  $("#kpis").innerHTML = k.map(x =>
    `<div class="kpi">
       <div class="v">${x.v}</div>
       <div class="l">${x.l}</div>
       ${x.d ? `<div class="d ${x.up ? "up" : ""}">${x.d}</div>` : ""}
     </div>`).join("");

  // Freshness uses formatTime so the top line follows the global
  // UTC/本地 toggle. Suffix tells the user which mode they're in.
  const g = formatTime(m.generated_at, "full");
  $("#freshness").textContent = `快照：${g} ${tzSuffix()} · ${fmt(tr, 0)} 笔`;

  // (data-source banner removed per request)
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

  destroyChart("chart-30d");
  charts["chart-30d"] = new Chart($("#chart-30d"), {
    type: "bar",
    data: {
      labels: days.map(d => d.slice(5)),
      datasets: [
        { label: "PRL",  data: days.map(d => byDay[d].prl),
          backgroundColor: PRI, hoverBackgroundColor: "#5fe89a",
          borderRadius: 3, borderSkipped: false,
          categoryPercentage: 0.78, barPercentage: 0.92, yAxisID: "y" },
        { label: "USDC", data: days.map(d => byDay[d].usdc),
          backgroundColor: "rgba(133,183,235,0.75)",
          hoverBackgroundColor: INFO,
          borderRadius: 3, borderSkipped: false,
          categoryPercentage: 0.78, barPercentage: 0.92, yAxisID: "y" },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },   // hover anywhere on column
      plugins: {
        legend: { position: "bottom",
          labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 } } },
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

/* ===== top buyers / sellers (24h) =====
   The window is anchored to the newest trade in the data, NOT the
   viewer's clock — otherwise a slightly stale snapshot or a quiet day
   would blank the panel. So it always shows the last 24h of *activity*. */
function latestTradeMs() {
  let mx = 0;
  for (const r of D.trades) {
    if (!r.time) continue;
    const t = new Date(r.time).getTime();
    if (t > mx) mx = t;
  }
  return mx || Date.now();
}
function renderTopParties(side) {
  // side: "buy" -> buyers (received PRL); "sell" -> sellers (sent PRL).
  // These are address-based, so they only exist for the archive era.
  // Anchor the 24h window to the latest ADDRESSED trade (not the newest
  // overall trade, which is now an address-less live settlement) so the
  // panel shows the final 24h of traced activity instead of going blank.
  const keyOf = r => side === "buy"
    ? (r.buyer_evm || r.buyer_prl) : (r.seller_evm || r.seller_prl);
  let anchor = 0;
  for (const r of D.trades) {
    if (r.status !== "COMPLETED" || !r.time || !keyOf(r)) continue;
    const t = new Date(r.time).getTime();
    if (t > anchor) anchor = t;
  }
  const cutoff = (anchor || Date.now()) - 86400 * 1000;
  const acc = new Map();
  D.trades.forEach(r => {
    if (r.status !== "COMPLETED" || !r.time) return;
    if (new Date(r.time).getTime() < cutoff) return;
    const key = keyOf(r);
    if (!key) return;
    const cur = acc.get(key) || { addr: key, amt: 0, n: 0 };
    cur.amt += num(r.prl_amount);
    cur.n += 1;
    acc.set(key, cur);
  });
  const list = [...acc.values()].sort((a, b) => b.amt - a.amt).slice(0, 8);
  const body = $(side === "buy" ? "#top-buyers-body" : "#top-sellers-body");
  if (!body) return;
  if (!list.length) {
    body.innerHTML = `<div class="empty">近 24h 暂无${side === "buy" ? "买入" : "卖出"}</div>`;
    return;
  }
  const max = list[0].amt;
  body.innerHTML = list.map((x, i) => {
    const w = max ? (x.amt / max * 100) : 0;
    const op = (1 - i * 0.5 / Math.max(list.length - 1, 1)).toFixed(2);
    const id = idOf(x.addr), lbl = labelOf(x.addr);
    const name = lbl ? lbl : (id && id.username ? `@${id.username}` : short(x.addr));
    return `<div class="tb-row" data-addr="${x.addr}" title="${x.addr}">
      <span class="addr">${name}<span class="tb-n"> ·${x.n}笔</span></span>
      <span class="bar-wrap"><span class="bar ${side === "sell" ? "sell" : ""}" style="width:${w.toFixed(1)}%;opacity:${op}"></span></span>
      <span class="v">${fmt(x.amt, 0)}<span class="u">PRL</span></span>
    </div>`;
  }).join("");
  $$(".tb-row", body).forEach(el =>
    el.onclick = () => { location.hash = "address/" + el.dataset.addr; });
}
function renderTopBuyers() { renderTopParties("buy"); renderTopParties("sell"); }

/* ===== whales / institutional accumulation tab ===== */
const FLAG_CN = { whale: "巨鲸", accumulator: "累积", silent: "静默DCA",
  absorb: "吸筹", fresh: "新巨鲸", hodl: "冷囤", off_otc: "场外建仓" };
function nameCell(a) {
  // compact: short addr (clickable) + username/entity/label badges
  if (!a) return `<span class="muted">—</span>`;
  return `<a class="addr" data-addr="${a}" href="#address/${a}" title="${a}">${short(a)}</a>`
    + unameBadge(a) + entityBadge(a) + labelChip(a);
}
function renderWhales() {
  const m = D.market || {}, cex = m.cex || {}, w = D.whales || {};
  const conc = w.concentration || {};
  // KPI strip: spread, OTC price, CEX price+vol, buy concentration
  const sp = m.spread_pct;
  const spCls = sp == null ? "" : (sp >= 0 ? "up" : "dn");
  const k = [
    { v: sp == null ? "—" : `${sp >= 0 ? "+" : ""}${sp}%`, l: "OTC 对 CEX 价差",
      d: sp == null ? "" : (sp >= 0 ? "OTC 溢价" : "OTC 折价"), up: sp >= 0, dn: sp < 0 },
    { v: m.otc_recent_price ? m.otc_recent_price : "—", l: "OTC 近价 (USDC)", d: "" },
    { v: cex.last ? cex.last : "—", l: "SafeTrade 价 (USDT)",
      d: cex.vol_24h_prl ? `24h ${compact(cex.vol_24h_prl)} PRL` : "" },
    { v: conc.top5_pct ? conc.top5_pct + "%" : "—", l: "买入集中度 (前5)",
      d: conc.n_net_buyers ? `${fmt(conc.n_net_buyers, 0)} 净买家` : "" },
  ];
  $("#whale-kpis").innerHTML = k.map(x =>
    `<div class="kpi"><div class="v ${x.up ? "up-v" : x.dn ? "dn-v" : ""}">${x.v}</div>`
    + `<div class="l">${x.l}</div>${x.d ? `<div class="d">${x.d}</div>` : ""}</div>`).join("");

  const buyers = w.buyers || [];
  $("#whale-sub").textContent =
    `${fmt(buyers.length, 0)} 个净买家 · 全网买入 ${compact(conc.total_buy_prl)} PRL · `
    + `前10 集中度 ${conc.top10_pct || "—"}%`;
  $("#whale-body").innerHTML = buyers.map((b, i) => {
    const flags = (b.flags || []).filter(f => FLAG_CN[f])
      .map(f => `<span class="wf wf-${f}">${FLAG_CN[f]}</span>`).join(" ");
    const ch = b.chain || {};
    // entity-level holdings (own addr + co-spend partners + cold wallets,
    // see collector/cluster.py) when clustered; single-address otherwise
    let bal = ch.balance_prl != null ? fmtAmt(ch.balance_prl) : "—";
    const cl = b.cluster;
    if (cl && ch.entity_balance_prl != null) {
      const nLink = (cl.addrs || []).length + (cl.cold || []).length;
      const coldSum = (cl.cold || []).reduce((s, c) => s + (c.balance_prl || 0), 0);
      const tip = `本址 ${fmtAmt(ch.balance_prl)} + 关联 ${nLink} 地址`
        + (coldSum ? `（冷钱包 ${fmtAmt(coldSum)}）` : "");
      bal = `<span title="${tip}">${fmtAmt(ch.entity_balance_prl)}`
        + `<span class="cl-mark">+${nLink}址</span></span>`;
    }
    return `<tr data-addr="${b.address}">
      <td class="id">${i + 1}</td>
      <td>${nameCell(b.address)}</td>
      <td class="num" style="color:var(--pri)">${fmtAmt(b.net_prl)}</td>
      <td class="num muted">${b.n_buy}/${b.n_sell}</td>
      <td class="num">${bal}</td>
      <td>${flags || '<span class="muted">—</span>'}</td>
      <td class="time">${b.last || ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">暂无数据</td></tr>`;
  $$("#whale-body tr[data-addr]").forEach(tr =>
    tr.onclick = e => { if (!e.target.closest("a,.copy")) location.hash = "address/" + tr.dataset.addr; });

  // SafeTrade large flows (free-amount + direction filter)
  renderSafetrade();
}

function renderSafetrade() {
  const st = D.safetrade || {}, all = st.flows || [];
  const body = $("#safetrade-body");
  if (!body) return;
  const minEl = $("#st-min"), dirEl = $("#st-dir");
  const min = Math.max(0, num(minEl && minEl.value) || 0);
  const dir = (dirEl && dirEl.value) || "";
  const flows = all.filter(f => num(f.prl) >= min && (!dir || f.kind === dir));
  const cnt = $("#st-count");
  if (cnt) cnt.textContent = `${fmt(flows.length, 0)} / ${fmt(all.length, 0)} 笔`;
  const head = st.balance_prl != null
    ? `<div class="sub" style="margin-bottom:8px">交易所余额 ${fmtAmt(st.balance_prl)} PRL · 历史净流入 ${fmtAmt((st.ext_received_prl || 0) - (st.ext_sent_prl || 0))} PRL</div>`
    : "";
  if (!flows.length) {
    body.innerHTML = head + `<div class="muted" style="padding:12px 0">无符合条件的大额进出</div>`;
    return;
  }
  body.innerHTML = head + `<div class="st-feed">` + flows.slice(0, 60).map(f => {
    const inb = f.kind === "deposit";
    const tx = f.txid
      ? `<a class="st-tx" href="${EXP}/tx/${f.txid}?network=mainnet" target="_blank" rel="noopener" title="${f.txid}">${f.txid.slice(0, 8)}… ↗</a>`
      : `<span class="muted">—</span>`;
    // counterparty pierced through an exchange deposit address → mark it
    const via = f.via
      ? ` <span class="st-via" title="经充值地址 ${f.via} 归集入热钱包">中转</span>`
      : "";
    return `<div class="st-row">
      <span class="st-dir ${inb ? "in" : "out"}">${inb ? "转入↘" : "提现↗"}</span>
      <span class="st-amt">${fmtAmt(f.prl)} PRL</span>
      <span class="st-cp">${f.counterparty ? nameCell(f.counterparty) + via : '<span class="muted">—</span>'}</span>
      <span class="time">${formatTime(new Date((f.time || 0) * 1000).toISOString(), "short")}</span>
      ${tx}
    </div>`;
  }).join("") + `</div>`;
}

/* ===== routing ===== */
function route() {
  const h = location.hash.slice(1) || "trades";
  if (h.startsWith("address/")) { showDetail(decodeURIComponent(h.slice(8))); return; }
  const base = h.split("/")[0];   // "flow/prl1…" -> "flow"
  $$(".view").forEach(v => v.classList.add("hidden"));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === base));
  const v = $("#view-" + base);
  (v || $("#view-trades")).classList.remove("hidden");
  if (base === "trades") { renderTrades(); renderTradesCharts(); renderTopBuyers(); }
  else if (base === "whales") renderWhales();
  else if (base === "flow") {
    const seed = h.includes("/") ? decodeURIComponent(h.slice(h.indexOf("/") + 1)) : "";
    if (window.renderFlow) window.renderFlow(seed);
  }
  else if (base === "addresses") { ensureAddresses().then(renderAddresses); }
  else if (base === "charts") drawCharts();
}
window.addEventListener("hashchange", route);

/* ===== trades table (10 cols) ===== */
// Default sort by time desc (newest first). id is no longer a reliable
// order key: post-redesign live rows have synthetic string ids ("L…").
let tState = { sort: "time", dir: -1, page: 0, per: 50 };

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
      const u = a => { const id = idOf(a); return id ? id.username : ""; };
      const hay = [r.id, r.seller_prl, r.seller_evm, r.buyer_prl, r.buyer_evm,
        r.deposit_txid, r.release_txid, r.refund_txid, r.usdc_tx_hash,
        r.maker_username,
        u(r.seller_prl), u(r.seller_evm), u(r.buyer_prl), u(r.buyer_evm),
        labelOf(r.seller_prl), labelOf(r.seller_evm),
        labelOf(r.buyer_prl), labelOf(r.buyer_evm)]
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
  // Helpers (inlined into the map): build a party cell with an optional
  // ⓜ maker badge prepended when this side posted the offer. data-addr
  // is added to every <a> so hover-highlight catches all occurrences.
  const partyCell = (prl, evm, isMaker, network) => {
    if (!prl && !evm) return `<span class="muted">未上链</span>`;
    const badge = isMaker
      ? `<span class="maker-tag" title="挂单方 (maker)">ⓜ</span>`
      : "";
    const a1 = prl
      ? `<a href="#address/${prl}" data-addr="${prl}" title="${prl}">${short(prl)}</a>${unameBadge(prl)}${entityBadge(prl)}${labelChip(prl)}`
      : `<span class="muted">—</span>`;
    const a2 = evm
      ? `<a href="#address/${evm}" data-addr="${evm}" title="${evm}">${short(evm)}</a>${unameBadge(evm)}${entityBadge(evm)}${labelChip(evm)}`
      : `<span class="muted">—</span>`;
    return `<div class="party">${badge}<div class="addr-stack">
        <div class="a1">${a1}</div><div class="a2">${a2}</div></div></div>`;
  };
  // Live (post-redesign) rows have only a maker username — no addresses,
  // side, network, or tx hashes. Render the maker in the seller slot and
  // mark the buyer side as undisclosed.
  const makerCell = mk => mk
    ? `<div class="party"><span class="maker-tag" title="挂单方 maker">ⓜ</span>`
      + `<span class="addr">@${String(mk).replace(/</g, "&lt;")}</span></div>`
    : `<span class="muted">—</span>`;
  $("#trades-body").innerHTML = slice.map(r => {
    const live = r.source === "live";
    // A live row is "enriched" when on-chain reconstruction recovered its
    // addresses (PRL via prlscan fee funnel; USDC via amount+time match).
    const enriched = live && (r.seller_prl || r.buyer_prl || r.seller_evm || r.buyer_evm);
    const t = formatTime(r.time, "short");
    const sellerCell = (live && !enriched) ? makerCell(r.maker_username)
      : partyCell(r.seller_prl, r.seller_evm, r.maker_side === "SELL_PRL", r.network);
    const buyerCell  = (live && !enriched)
      ? `<span class="muted" title="尚未恢复">—</span>`
      : partyCell(r.buyer_prl, r.buyer_evm, r.maker_side === "BUY_PRL", r.network);
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
    // For non-COMPLETED rows the USDC amount is just the original offer
    // quote, never actually paid — show it muted so it doesn't read as
    // a real settlement. CANCELLED also has no PRL on-chain transfer
    // (no deposit), so mute that too; REFUNDED's PRL did flow into
    // escrow and back so keep it readable.
    const muted = r.status !== "COMPLETED";
    const cancelled = r.status === "CANCELLED";
    const prlCell = r.prl_amount
      ? (cancelled
          ? `<span class="muted">${fmtAmt(r.prl_amount)}</span>`
          : fmtAmt(r.prl_amount))
      : '<span class="muted">—</span>';
    const usdcCell = r.usdc_amount
      ? (muted
          ? `<span class="muted">${fmtAmt(r.usdc_amount)}</span>`
          : fmtAmt(r.usdc_amount))
      : '<span class="muted">—</span>';
    const idCell = live
      ? `<span class="src-live" title="改版后新成交${r.inferred ? " · 地址经链上反查恢复（推断）" : ""}">live${r.inferred ? "·推断" : ""}</span>`
      : r.id;
    // For live rows the feed gives the maker username (side unknown), so
    // the 挂单 column shows @maker instead of 买单/卖单.
    const sideTd = live
      ? (r.maker_username
          ? `<span class="muted" title="挂单方 maker">@${String(r.maker_username).replace(/</g, "&lt;")}</span>`
          : '<span class="muted">—</span>')
      : sideCell(r.maker_side);
    return `<tr${live ? ' class="row-live"' : ''}>
      <td class="id">${idCell}</td>
      <td class="time">${t}</td>
      <td>${sideTd}</td>
      <td>${statusCell(r.status)}</td>
      <td>${netCell(r.network)}</td>
      <td class="num">${prlCell}</td>
      <td class="num">${usdcCell}</td>
      <td class="num">${r.price_per_prl_usdc ? fmt(r.price_per_prl_usdc, 4) : '<span class="muted">—</span>'}</td>
      <td>${sellerCell}</td>
      <td>${buyerCell}</td>
      ${txCell}
    </tr>`;
  }).join("") || `<tr><td colspan="11" class="muted" style="text-align:center;padding:20px">无匹配成交</td></tr>`;
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
  // PRL flows are only meaningful for Pearl addresses, USDC flows only
  // for EVM addresses — show "—" on the wrong-chain side instead of "0".
  const dash = '<span class="muted">—</span>';
  $("#addr-body").innerHTML = rows.slice(pg * per, pg * per + per).map(a => `
    <tr class="clk" data-addr="${a.address}">
      <td>${addrLink(a.address, a.network)}</td>
      <td class="muted">${a.chain}${a.network ? " · " + a.network.toLowerCase() : ""}</td>
      <td class="num">${a.chain === "pearl" ? fmtAmt(a.sold_prl) : dash}</td>
      <td class="num">${a.chain === "pearl" ? fmtAmt(a.bought_prl) : dash}</td>
      <td class="num">${a.chain === "evm" ? fmtAmt(a.recv_usdc) : dash}</td>
      <td class="num">${a.chain === "evm" ? fmtAmt(a.paid_usdc) : dash}</td>
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
  const dash = '<span class="muted">—</span>';
  const isE = isEvm(addr);
  // Everything here is derived from the trades this address appears in,
  // so the detail page works without the heavy addresses.json.
  const my = D.trades.filter(r =>
    [r.seller_prl, r.seller_evm, r.buyer_prl, r.buyer_evm].includes(addr));
  const network = my.find(r => r.network)?.network;
  const scan = isE
    ? `${SCAN[network] || SCAN.ARBITRUM}/address/${addr}`
    : `${EXP}/address/${addr}?network=mainnet`;
  const g = (l, v) => `<div><div class="v">${v}</div><div class="l">${l}</div></div>`;

  const completedMy = my.filter(r => r.status === "COMPLETED");
  const asSeller = completedMy.filter(r => r.seller_prl === addr || r.seller_evm === addr);
  const asBuyer  = completedMy.filter(r => r.buyer_prl === addr || r.buyer_evm === addr);
  const sumPRL  = arr => arr.reduce((s, r) => s + num(r.prl_amount), 0);
  const sumUSDC = arr => arr.reduce((s, r) => s + num(r.usdc_amount), 0);
  const times = my.map(r => r.time).filter(Boolean).sort();

  // Linked = same party's other-leg address (e.g. this Pearl seller's
  // EVM address), derived from each trade. Counterparties = the opposite
  // party, aggregated with trade count, PRL volume, and direction.
  const linkedC = {}, cpAgg = {};
  for (const r of my) {
    const meSeller = r.seller_prl === addr || r.seller_evm === addr;
    const myLegs = meSeller ? [r.seller_prl, r.seller_evm] : [r.buyer_prl, r.buyer_evm];
    for (const leg of myLegs)
      if (leg && leg !== addr) linkedC[leg] = (linkedC[leg] || 0) + 1;
    const cpLegs = meSeller ? [r.buyer_prl, r.buyer_evm] : [r.seller_prl, r.seller_evm];
    const cpKey = cpLegs[0] || cpLegs[1];   // prefer Pearl leg, else EVM
    if (!cpKey) continue;
    const c = cpAgg[cpKey] || { addr: cpKey, n: 0, prl: 0, boughtFromMe: 0, soldToMe: 0 };
    c.n += 1; c.prl += num(r.prl_amount);
    if (meSeller) c.boughtFromMe += 1; else c.soldToMe += 1;
    cpAgg[cpKey] = c;
  }
  const linked = Object.keys(linkedC).length
    ? Object.entries(linkedC).sort((a, b) => b[1] - a[1])
        .map(([ad, n]) => addrLink(ad) + ` <span class="muted">${n}×</span>`).join("　")
    : dash;
  const cps = Object.values(cpAgg).sort((a, b) => b.n - a.n).slice(0, 20);
  const cpRow = c => {
    const dir = c.boughtFromMe && c.soldToMe ? "双向"
      : c.boughtFromMe ? "向其卖出" : "从其买入";
    return `<div class="cp-row">${addrLink(c.addr, network)}
      <span class="cp-meta">${c.n}笔 · ${fmtAmt(c.prl)} PRL · ${dir}</span></div>`;
  };

  // pearl-otc identity (only known for addresses that were a user's
  // profile/refund address in some offer).
  const id = idOf(addr);
  const tierCls = id ? (TIER_CLASS[(id.trust_tier || "").toLowerCase()] || "t-new") : "";
  const idHead = id && id.username
    ? `<span class="uname ${tierCls} big">@${id.username}</span>` : "";
  const repBlock = id ? `
    <div class="card">
      <h3>平台信誉 · pearl-otc 记录</h3>
      <div class="dgrid">
        ${g("用户名", "@" + id.username)}
        ${g("信誉等级", id.trust_tier || "—")}
        ${g("平台成交数", fmt(id.trades_completed, 0))}
        ${g("平台取消数", fmt(id.trades_cancelled, 0))}
        ${g("平台累计 USDC", fmtAmt(id.total_usdc_volume_traded))}
        ${g("平台最近活跃", (id.last_active_at || "").slice(0, 10) || "—")}
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">
        ↑ 平台自报口径，与下方链上推导的数据来源不同，可能不完全一致。</div>
    </div>` : "";

  // Custom label editor (personal localStorage; shared shown as hint).
  const curLabel = personalLabels[addr] || "";
  const sharedHint = !curLabel && sharedLabels[addr] ? sharedLabels[addr] : "";
  const labelBlock = `
    <div class="label-edit">
      <span class="le-l">自定义标签</span>
      <input id="le-input" type="text" maxlength="40" value="${curLabel.replace(/"/g, "&quot;")}"
        placeholder="${sharedHint ? "共享：" + sharedHint : "给这个地址起个名…"}" />
      <button id="le-save" class="btn">保存</button>
      ${curLabel ? `<button id="le-clear" class="btn">清除</button>` : ""}
      <span class="le-hint muted">仅存于本浏览器</span>
    </div>`;

  $("#detail-body").innerHTML = `
    <div class="detail-head">
      <span class="pill s">${isE ? "EVM" + (network ? " · " + network.toLowerCase() : "") : "PEARL"}</span>
      ${idHead}
      ${labelOf(addr) ? `<span class="tag-chip big">${labelOf(addr)}</span>` : ""}
      <span class="addr mono">${addr}</span>
      <span class="copy" data-copy="${addr}">⧉ 复制</span>
      ${!isE ? `<a class="flow-link" href="#flow/${encodeURIComponent(addr)}">在资金流图查看 ⇲</a>` : ""}
      <a href="${scan}" target="_blank" rel="noopener">浏览器打开 ↗</a>
    </div>
    ${labelBlock}
    ${repBlock}
    <div class="dgrid">
      ${g("PRL 卖出", fmtAmt(sumPRL(asSeller)))}${g("PRL 买入", fmtAmt(sumPRL(asBuyer)))}
      ${g("USDC 收入", fmtAmt(sumUSDC(asSeller)))}${g("USDC 支出", fmtAmt(sumUSDC(asBuyer)))}
      ${g("成交数", my.length)}
      ${g("首次出现", (times[0] || "").slice(0, 10))}
      ${g("最近活跃", (times.at(-1) || "").slice(0, 10))}
    </div>
    <div class="two">
      <div class="card"><h3>同方关联地址（同一方的另一腿）</h3>${linked}</div>
      <div class="card"><h3>对手方关系（${cps.length}）</h3>
        ${cps.length ? cps.map(cpRow).join("") : dash}</div>
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
          <td class="time">${formatTime(r.time, "short")}</td>
          <td>${roleLabel}</td>
          <td>${sideCell(r.maker_side)}</td>
          <td class="num">${fmtAmt(r.prl_amount)}</td>
          <td class="num">${r.usdc_amount && r.status === "COMPLETED" ? fmtAmt(r.usdc_amount) : `<span class="muted">${r.usdc_amount ? fmtAmt(r.usdc_amount) : "—"}</span>`}</td>
          <td>${addrLink(cp, r.network)}</td>
          <td class="muted">${txLink("pearl", null, r.deposit_txid)} ${txLink("evm", r.network, r.usdc_tx_hash)}</td></tr>`;
      }).join("")}
    </tbody></table></div></div>`;

  // Wire the label editor (re-attached on each render).
  const save = () => { setLabel(addr, $("#le-input").value); showDetail(addr); };
  $("#le-save") && ($("#le-save").onclick = save);
  $("#le-input") && ($("#le-input").addEventListener("keydown",
    e => { if (e.key === "Enter") save(); }));
  $("#le-clear") && ($("#le-clear").onclick = () => { setLabel(addr, ""); showDetail(addr); });
}

/* ===== charts tab ===== */
function drawCharts() {
  if (chartsTabDrawn || !window.Chart) { if (!window.Chart) setTimeout(drawCharts, 200); return; }
  chartsTabDrawn = true;
  const byDay = {};
  D.trades.forEach(r => {
    // Only COMPLETED — matches the trades-page 30d chart so users see
    // consistent numbers across views (REFUNDED/CANCELLED inflate by ~8%).
    if (r.status !== "COMPLETED" || !r.time) return;
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
$("#btn-back").onclick = () => {
  // Prefer real history navigation so users go back where they came from
  // (trades table, search results, etc.); fall back to addresses tab when
  // they landed on this page directly.
  if (history.length > 1) history.back();
  else location.hash = "addresses";
};
["f-search", "f-status", "f-side", "f-network", "f-resolved", "f-from", "f-to"]
  .forEach(id => $("#" + id).addEventListener("input",
    () => { tState.page = 0; renderTrades(); }));
["a-search", "a-chain", "a-sort"].forEach(id =>
  $("#" + id).addEventListener("input", () => { aState.page = 0; renderAddresses(); }));
// SafeTrade flow feed: free-amount + direction filter (persisted)
(() => {
  const minEl = $("#st-min"), dirEl = $("#st-dir");
  if (minEl) {
    const saved = localStorage.getItem("st-min");
    if (saved) minEl.value = saved;
    minEl.addEventListener("input", () => {
      localStorage.setItem("st-min", minEl.value);
      if (typeof renderSafetrade === "function") renderSafetrade();
    });
  }
  if (dirEl) dirEl.addEventListener("change", () => {
    if (typeof renderSafetrade === "function") renderSafetrade();
  });
})();
$("#btn-csv").onclick = csv;
$$("#trades-table th[data-sort]").forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  if (tState.sort === k) tState.dir *= -1;
  else { tState.sort = k; tState.dir = (k === "id" || k === "time") ? -1 : 1; }
  tState.page = 0; renderTrades();
});

/* ===== UTC ⇄ 本地 time-mode toggle ===== */
function applyTzButton() {
  const b = $("#btn-tz");
  if (!b) return;
  b.textContent = tzMode === "utc" ? "UTC" : "本地";
  b.classList.toggle("local", tzMode === "local");
  b.title = tzMode === "utc" ? "当前 UTC · 点击切换到本地时间" : "当前本地时间 · 点击切回 UTC";
}
$("#btn-tz")?.addEventListener("click", () => {
  tzMode = tzMode === "utc" ? "local" : "utc";
  localStorage.setItem("tz-mode", tzMode);
  applyTzButton();
  renderKpis();
  // Re-render whichever view is showing so all timestamps follow.
  const h = (location.hash.slice(1) || "trades").split("/")[0];
  if (h === "trades") renderTrades();
  else if (h === "addresses") renderAddresses();
  else if (location.hash.startsWith("#address/"))
    showDetail(decodeURIComponent(location.hash.slice(9)));
});
applyTzButton();

/* ===== hover-highlight every occurrence of the same address ===== */
let _hoverAddr = null;
document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-addr]");
  if (!el) return;
  const a = el.dataset.addr;
  if (!a || a === _hoverAddr) return;
  if (_hoverAddr)
    document.querySelectorAll(".addr-hl").forEach(x => x.classList.remove("addr-hl"));
  _hoverAddr = a;
  // CSS.escape protects against punctuation in the (already-safe) addr.
  document.querySelectorAll(`[data-addr="${CSS.escape(a)}"]`)
    .forEach(x => x.classList.add("addr-hl"));
});
document.addEventListener("mouseout", e => {
  const el = e.target.closest("[data-addr]");
  if (!el) return;
  const rel = e.relatedTarget;
  // If the mouse is moving to another [data-addr] element, let the
  // next mouseover handle the switch — don't blink off in between.
  if (rel && rel.closest && rel.closest("[data-addr]")) return;
  document.querySelectorAll(".addr-hl").forEach(x => x.classList.remove("addr-hl"));
  _hoverAddr = null;
});

load();
