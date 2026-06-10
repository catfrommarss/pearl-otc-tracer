"use strict";
/* PRL on-chain flow tracer (Arkham-style ego graph).
   Live, client-side: the browser talks to prlscan directly
   (api.prlscan.com sends Access-Control-Allow-Origin: *), so there is no
   backend and no precompute — any address is explorable and always fresh.
   Cytoscape.js + fcose renders an entity-merged, balance-sized node graph;
   clicking a node expands one hop of its counterparties. */

const PS = "https://api.prlscan.com";
const G = 1e8;                       // grains per PRL
const EXPLORER = "https://explorer.pearlresearch.ai";
// Addresses with <= this many txs get an EXACT full scan (every tx body
// fetched). Above it, we fall back to top-by-size sampling so exchange/hub
// wallets (thousands of txs) don't stall the browser or hammer the API.
const FULL_SCAN_CAP = 400;

const F = {
  entities: {}, idents: {}, userIndex: {},
  clusters: {}, whaleRank: {},
  txCache: new Map(), addrCache: new Map(),
  expanded: new Set(),
  cy: null, dataLoaded: false, focus: null,
  windowDays: 0,            // 0 = 全部, 7, 30
  tracing: false,
};

const KIND_COLOR = {
  pearl_otc: "#4ade80", system: "#fbbf24", exchange: "#fbbf24",
  bridge: "#5b8def", bridge_treasury: "#5b8def", pool: "#c084fc",
  cold: "#a7b4c7", unknown: "#9ca3af",
};

function fshort(a) {
  if (!a) return "";
  return a.length > 18 ? a.slice(0, 8) + "…" + a.slice(-5) : a;
}
function fnum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(n < 1 ? 2 : 0);
}
function flowToast(msg) {
  const el = document.getElementById("flow-focus");
  if (!el) return;
  const prev = el.textContent;
  el.textContent = "⚠ " + msg;
  el.classList.add("err");
  setTimeout(() => { el.classList.remove("err"); el.textContent = prev; }, 2600);
}
function flowStatus(msg) {     // transient non-error progress text in the bar
  const el = document.getElementById("flow-focus");
  if (el) { el.classList.remove("err"); el.textContent = msg; }
}

/* ---- data + prlscan fetch ---- */
async function flowInitData() {
  if (F.dataLoaded) return;
  const get = async f => {
    try { const r = await fetch(f, { cache: "no-store" }); return r.ok ? r.json() : null; }
    catch { return null; }
  };
  const [ent, ids, cls, wh] = await Promise.all([
    get("data/entities.json"), get("data/identities.json"),
    get("data/clusters.json"), get("data/whales.json")]);
  F.entities = ent || {}; F.idents = ids || {}; F.clusters = cls || {};
  ((wh && wh.buyers) || []).slice(0, 50).forEach((b, i) => {
    F.whaleRank[b.address] = { rank: i + 1, net: b.net_prl };
  });
  const ui = {};
  for (const [a, r] of Object.entries(F.idents))
    if (r && r.username) ui[r.username.toLowerCase()] = ui[r.username.toLowerCase()] || a;
  for (const [a, r] of Object.entries(F.entities)) {
    const l = (r.label || "").replace(/^@/, "");
    if (l) ui[l.toLowerCase()] = ui[l.toLowerCase()] || a;
  }
  F.userIndex = ui;
  F.dataLoaded = true;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pget(path) {
  // polite client for a free public API: back off twice on 429/5xx
  for (let i = 0; ; i++) {
    const r = await fetch(PS + path, { cache: "no-store" });
    if (r.ok) return r.json();
    if (i < 2 && (r.status === 429 || r.status >= 500)) { await sleep(800 * (i + 1)); continue; }
    throw new Error("prlscan " + r.status);
  }
}
async function addrInfo(addr) {
  if (F.addrCache.has(addr)) return F.addrCache.get(addr);
  const d = await pget("/v1/addresses/" + encodeURIComponent(addr));
  F.addrCache.set(addr, d);
  return d;
}
async function txInfo(txid) {
  if (F.txCache.has(txid)) return F.txCache.get(txid);
  let d = null;
  try { d = await pget("/v1/txs/" + encodeURIComponent(txid)); }
  catch { return null; }   // do NOT cache failures — a rate-limited tx would
                           // otherwise stay invisible for the whole session
  F.txCache.set(txid, d);
  return d;
}
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

/* ---- entity resolution (merge known identities into one named node) ---- */
function entOf(addr) {
  const e = F.entities[addr];
  if (e && e.label)
    return { id: "ent:" + e.label, label: e.label.replace(/^@/, ""), kind: e.kind || "system", addr };
  const id = F.idents[addr];
  if (id && id.username)
    return { id: "u:" + id.username, label: id.username, kind: "pearl_otc", addr };
  // whale-cluster member: keep its own node (the whale→cold edge is the
  // interesting part) but name + color it instead of "未知"
  const cl = F.clusters[addr];
  if (cl && cl.owner_name)
    return { id: addr, kind: "cold", addr,
             label: cl.owner_name + (cl.kind === "cold" ? "·冷" : "·关联") };
  return { id: addr, label: fshort(addr), kind: "unknown", addr };
}

/* ---- cytoscape ---- */
function flowReady() {
  return new Promise(res => {
    (function poll() {
      if (window.cytoscape && window.cytoscapeFcose) return res();
      setTimeout(poll, 120);
    })();
  });
}
function ensureCy() {
  if (F.cy) return;
  try { window.cytoscape.use(window.cytoscapeFcose); } catch (e) {}
  F.cy = window.cytoscape({
    container: document.getElementById("flow-graph"),
    minZoom: 0.15, maxZoom: 3, wheelSensitivity: 0.25,
    style: [
      { selector: "node", style: {
        "background-color": ele => KIND_COLOR[ele.data("kind")] || KIND_COLOR.unknown,
        "width": "data(size)", "height": "data(size)",
        "label": "data(label)", "color": "#e5e7eb",
        "font-family": "'JetBrains Mono', monospace", "font-size": 10,
        "text-valign": "bottom", "text-margin-y": 3, "text-max-width": 110,
        "text-wrap": "ellipsis", "min-zoomed-font-size": 7,
        "border-width": 0, "transition-property": "border-width",
      } },
      { selector: "node.focal", style: {
        "border-width": 3, "border-color": "#e5e7eb", "color": "#fff",
        "font-size": 12, "font-weight": 600,
      } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#4ade80" } },
      { selector: "edge", style: {
        "curve-style": "bezier", "width": "mapData(prl, 0, 200000, 1, 5)",
        "target-arrow-shape": "triangle", "arrow-scale": 0.7,
        "opacity": 0.8, "line-cap": "round",
        // transfer amount on the edge (direction encoded by color)
        "label": ele => fnum(ele.data("prl")),
        "font-family": "'JetBrains Mono', monospace", "font-size": 9,
        "color": "#cbd5e1", "text-rotation": "autorotate",
        "text-background-color": "#0a0b0e", "text-background-opacity": 0.85,
        "text-background-padding": 2, "min-zoomed-font-size": 7,
      } },
      { selector: "edge.in", style: { "line-color": "#4ade80", "target-arrow-color": "#4ade80" } },
      { selector: "edge.out", style: { "line-color": "#f87171", "target-arrow-color": "#f87171" } },
      // trace path: bright + thick; everything else dims while tracing
      { selector: "edge.trace", style: { "opacity": 1, "width": 4, "arrow-scale": 1 } },
      { selector: "node.trace", style: { "border-width": 2, "border-color": "#fbbf24" } },
      { selector: ".dim", style: { "opacity": 0.18, "text-opacity": 0.25 } },
    ],
  });
  const cy = F.cy;
  cy.on("tap", "node", ev => {
    const n = ev.target;
    cy.elements().removeClass("dim").removeClass("trace");  // leave trace view
    setFocus(n.data("addr"));
    expand(n.data("addr")).then(() => layout(true));
  });
  cy.on("dbltap", "node", ev => {
    const a = ev.target.data("addr");
    if (a) location.hash = "address/" + a;
  });
  cy.on("tap", "edge", ev => showEdgePanel(ev.target));
  cy.on("mouseover", "node", ev => showTip(ev.target, ev.originalEvent));
  cy.on("mouseout", "node", hideTip);
  cy.on("tap", ev => { if (ev.target === cy) { hideTip(); hideEdgePanel(); } });
}
function layout(fit) {
  if (!F.cy) return;
  F.cy.layout({
    name: "fcose", animate: true, animationDuration: 500,
    nodeRepulsion: 8000, idealEdgeLength: 110, padding: 40,
    fit: fit !== false,
  }).run();
}

async function addNode(addr, focal) {
  const ent = entOf(addr);
  const existing = F.cy.getElementById(ent.id);
  if (existing.length) { if (focal) existing.addClass("focal"); return ent.id; }
  let bal = 0, recv = 0;
  try {
    const info = await addrInfo(addr);
    bal = info ? (Number(info.balance_grains) || 0) / G : 0;
    recv = info ? (Number(info.external_received_grains) || 0) / G : 0;
  } catch { /* keep node with unknown balance */ }
  const size = Math.max(24, Math.min(92, 20 + Math.sqrt(bal) / 3));
  const wr = F.whaleRank[addr];
  const label = ent.label + (wr ? " ⌗" + wr.rank : "");
  F.cy.add({ group: "nodes",
    data: { id: ent.id, addr, label, kind: ent.kind, bal, recv, size,
            rank: wr ? wr.rank : 0, net: wr ? wr.net : 0 },
    classes: focal ? "focal" : "" });
  return ent.id;
}
function addEdge(src, dst, grains, dir, txs) {
  const id = "e:" + src + "→" + dst;
  const ex = F.cy.getElementById(id);
  const prl = grains / G;
  const cap = arr => (arr || []).sort((a, b) => b.prl - a.prl).slice(0, 50);
  if (ex.length) {
    // The same (src,dst) flow re-derived from the OTHER endpoint's expansion
    // describes the SAME transfers — adding would double-count. Keep the
    // larger (more complete) view instead, and sync dir/class so the color
    // semantics follow the winning view.
    if (prl > (ex.data("prl") || 0)) {
      ex.data("prl", prl);
      ex.data("txs", cap(txs));
      if (ex.data("dir") !== dir) {
        ex.data("dir", dir);
        ex.removeClass("in").removeClass("out").addClass(dir);
      }
    }
    return;
  }
  F.cy.add({ group: "edges",
    data: { id, source: src, target: dst, prl, dir, txs: cap(txs) },
    classes: dir });
}

function tEp(it) {              // list-item time → epoch seconds (ISO or unix)
  const t = it && it.time;
  if (t == null) return 0;
  if (typeof t === "number") return t > 1e12 ? Math.floor(t / 1000) : t;
  const p = Date.parse(t);
  return isNaN(p) ? 0 : Math.floor(p / 1000);
}

const AGG_TTL = 10 * 60 * 1000;     // localStorage scan cache, 10 min
function aggKey(addr) { return `flowagg:v2:${addr}:${F.windowDays}`; }
function aggLoad(addr) {
  try {
    const raw = localStorage.getItem(aggKey(addr));
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || Date.now() - o.t > AGG_TTL || !Array.isArray(o.agg)) return null;
    return o;
  } catch { return null; }
}
function aggSave(addr, txCount, fullScan, aggArr) {
  try {
    const slim = aggArr.slice(0, 60).map(c => ({
      addr: c.addr, in: c.in, out: c.out,
      txsIn: (c.txsIn || []).slice(0, 30), txsOut: (c.txsOut || []).slice(0, 30),
    }));
    localStorage.setItem(aggKey(addr), JSON.stringify(
      { t: Date.now(), txCount, fullScan, agg: slim }));
  } catch { /* quota — skip caching */ }
}

async function expand(addr) {
  if (!addr || F.expanded.has(addr)) return;
  F.expanded.add(addr);
  const myId = entOf(addr).id;

  // ---- localStorage fast path: same addr+window scanned in the last 10min
  const cachedAgg = aggLoad(addr);
  let all, txCount = 0, fullScan = true;
  if (cachedAgg) {
    txCount = cachedAgg.txCount; fullScan = cachedAgg.fullScan;
    all = cachedAgg.agg.map(c => ({ ...c, ent: entOf(c.addr) }))
      .filter(c => c.ent.id !== myId);
  } else {
    // How many txs does this address have? (cheap — cached by addrInfo.)
    // Decides exact full scan vs. sampling.
    try { const info = await addrInfo(addr); txCount = info ? (Number(info.tx_count) || 0) : 0; } catch {}
    fullScan = txCount > 0 && txCount <= FULL_SCAN_CAP;
    flowStatus(fullScan ? `追溯中…全量扫描 ${txCount} 笔`
                        : `追溯中…采样（共 ${txCount || "?"} 笔）`);

    // 1) Page the (cheap) tx list — items carry delta_grains, so direction +
    //    size are known WITHOUT fetching bodies. This reaches rare-but-large
    //    outflows far past the most-recent page. Full scan reads all pages;
    //    sampling reads a bounded recent window.
    const maxPages = fullScan ? 50 : 6;   // limit=100 → full(<=400) is <=4 pages
    let list = [];
    try {
      let cursor = null;
      for (let p = 0; p < maxPages; p++) {
        const d = await pget("/v1/addresses/" + encodeURIComponent(addr) + "/txs?limit=100"
          + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
        const items = (d && d.items) || [];
        list.push(...items);
        cursor = d && d.next_cursor;
        if (!cursor || !items.length) break;
      }
    } catch { flowToast("prlscan 暂时不可用"); F.expanded.delete(addr); setFocus(addr); return; }

    // time-window filter (全部 / 30天 / 7天)
    if (F.windowDays > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - F.windowDays * 86400;
      list = list.filter(it => tEp(it) >= cutoff);
    }
    if (!list.length) {
      setFocus(addr);
      if (F.windowDays > 0) flowToast(`窗口内（${F.windowDays} 天）无交易`);
      return;
    }

    // 2) Pick which txs to resolve (a body fetch each — the one real cost).
    //    Full scan: every tx. Sampling: biggest per DIRECTION, so outflows
    //    surface no matter how lopsided the counts.
    let picked;
    if (fullScan) {
      picked = list;
    } else {
      const mag = it => Math.abs(it.delta_grains || 0);
      const byMag = (a, b) => mag(b) - mag(a);
      const inTxs = list.filter(it => (it.delta_grains || 0) > 0).sort(byMag).slice(0, 20);
      const outTxs = list.filter(it => (it.delta_grains || 0) < 0).sort(byMag).slice(0, 20);
      picked = [...inTxs, ...outTxs];
    }

    const agg = {};   // counterparty entityId -> {addr,in,out,txsIn,txsOut,ent}
    const slot = ce => (agg[ce.id] = agg[ce.id]
      || { addr: ce.addr, in: 0, out: 0, txsIn: [], txsOut: [], ent: ce });
    let failed = 0;
    await mapLimit(picked, 4, async it => {
      const tx = await txInfo(it.txid);
      if (!tx) { failed++; return; }
      const t = tEp(it);
      const ins = tx.inputs || [], outs = tx.outputs || [];
      const focalIsInput = ins.some(i => i.prev_address === addr);
      if (focalIsInput) {
        // SENT — each output to another entity is a recipient (out-edge)
        for (const o of outs) {
          const a = o.address;
          if (!a || a === addr) continue;
          const ce = entOf(a);
          if (ce.id === myId) continue;       // change / self
          const s = slot({ ...ce, addr: a });
          s.out += (o.value_grains || 0);
          s.txsOut.push({ txid: it.txid, prl: (o.value_grains || 0) / G, t });
        }
      } else {
        // RECEIVED — attribute the received total to the largest input sender
        const recv = outs.filter(o => o.address === addr).reduce((s, o) => s + (o.value_grains || 0), 0);
        let big = null;
        for (const i of ins) {
          if (!i.prev_address || i.prev_address === addr) continue;
          if (!big || (i.prev_value_grains || 0) > (big.prev_value_grains || 0)) big = i;
        }
        if (big) {
          const ce = entOf(big.prev_address);
          if (ce.id !== myId) {
            const s = slot({ ...ce, addr: big.prev_address });
            s.in += recv;
            s.txsIn.push({ txid: it.txid, prl: recv / G, t });
          }
        }
      }
    });
    all = Object.values(agg);
    if (failed === 0) aggSave(addr, txCount, fullScan, all);
    else flowToast(`${failed} 笔交易获取失败，本视图不完整（未缓存）`);
  }

  // 3) Show the top counterparties per direction (deduped). A dust floor
  //    relative to the biggest flow hides 1-PRL noise.
  let maxMag = 0;
  for (const c of all) maxMag = Math.max(maxMag, c.in, c.out);
  const floor = Math.max(G, maxMag * 0.001);    // >= 1 PRL and >= 0.1% of max
  const topIn = all.filter(c => c.in >= floor).sort((a, b) => b.in - a.in).slice(0, 10);
  const topOut = all.filter(c => c.out >= floor).sort((a, b) => b.out - a.out).slice(0, 8);
  const pick = new Map();
  for (const c of [...topIn, ...topOut]) pick.set(c.ent.id, c);
  for (const c of pick.values()) {
    await addNode(c.addr, false);
    if (c.in >= floor) addEdge(c.ent.id, myId, c.in, "in", c.txsIn);
    if (c.out >= floor) addEdge(myId, c.ent.id, c.out, "out", c.txsOut);
  }

  setFocus(addr);     // clear the "追溯中…" status back to the focus label
  if (!fullScan && txCount > FULL_SCAN_CAP)
    flowToast(`交易量大（${txCount} 笔），已按金额采样展示`);
}

function setFocus(addr) {
  F.focus = addr;
  F.cy.nodes().removeClass("focal");
  const ent = entOf(addr);
  F.cy.getElementById(ent.id).addClass("focal");
  const el = document.getElementById("flow-focus");
  if (el) el.textContent = "焦点：" + (ent.kind !== "unknown" ? (ent.kind === "pearl_otc" ? "@" : "") + ent.label : fshort(addr));
}
function showTip(node, ev) {
  const tip = document.getElementById("flow-tip");
  if (!tip) return;
  const k = node.data("kind");
  const kn = { pearl_otc: "OTC用户", system: "实体", bridge: "桥", pool: "矿池",
               cold: "关联钱包", unknown: "未知" }[k] || k;
  const bal = node.data("bal") || 0, recv = node.data("recv") || 0;
  const ret = recv > 0 ? Math.min(999, Math.round(bal / recv * 100)) : null;
  const rank = node.data("rank") || 0;
  tip.innerHTML = `<b>${node.data("label")}</b><br>${kn} · 余额 ${fnum(bal)} PRL`
    + (ret != null ? ` · 留存 ${ret}%` : "")
    + (rank ? `<br>净累积榜 ⌗${rank} · 净买入 ${fnum(node.data("net"))} PRL` : "")
    + `<br><span class="muted">${fshort(node.data("addr"))} · 点击展开 / 双击看详情</span>`;
  const x = (ev && ev.clientX) || 0, y = (ev && ev.clientY) || 0;
  tip.style.left = (x + 14) + "px";
  tip.style.top = (y + 14) + "px";
  tip.hidden = false;
}
function hideTip() { const t = document.getElementById("flow-tip"); if (t) t.hidden = true; }

/* ---- edge detail panel: the txs behind an aggregated edge ---- */
function showEdgePanel(edge) {
  const el = document.getElementById("flow-panel");
  if (!el) return;
  const txs = edge.data("txs") || [];
  const src = F.cy.getElementById(edge.data("source")).data("label");
  const dst = F.cy.getElementById(edge.data("target")).data("label");
  const rows = txs.slice(0, 30).map(x => {
    const d = x.t ? new Date(x.t * 1000).toISOString().slice(5, 16).replace("T", " ") : "—";
    return `<div class="fp-row"><span class="fp-t">${d}</span>`
      + `<span class="fp-v">${fnum(x.prl)}</span>`
      + `<a href="${EXPLORER}/tx/${x.txid}?network=mainnet" target="_blank" `
      + `rel="noopener">${(x.txid || "").slice(0, 10)}…</a></div>`;
  }).join("");
  el.innerHTML = `<div class="fp-head"><b>${src} → ${dst}</b>`
    + `<button class="fp-close" id="fp-close">×</button></div>`
    + `<div class="fp-sub">合计 ${fnum(edge.data("prl"))} PRL · ${txs.length} 笔`
    + `${txs.length >= 50 ? "（仅展示最大 50）" : ""}</div>`
    + (rows || `<div class="fp-sub muted">无明细（缓存视图）</div>`);
  el.hidden = false;
  const c = document.getElementById("fp-close");
  if (c) c.onclick = hideEdgePanel;
}
function hideEdgePanel() { const p = document.getElementById("flow-panel"); if (p) p.hidden = true; }

/* ---- trace mode: follow the largest outflow hop by hop ---- */
async function traceFlow() {
  if (F.tracing) return;
  if (!F.focus) { flowToast("先搜索一个起点地址"); return; }
  F.tracing = true;
  const btn = document.getElementById("flow-trace");
  if (btn) btn.disabled = true;
  try {
    F.cy.elements().removeClass("trace").removeClass("dim");
    let cur = F.focus;
    const visited = new Set();
    let endLabel = entOf(cur).label, endReason = "达到跳数上限";
    for (let hop = 0; hop < 6; hop++) {
      const ent = entOf(cur);
      if (visited.has(ent.id)) { endLabel = ent.label; endReason = "回到已访问节点"; break; }
      visited.add(ent.id);
      if (hop > 0 && ["system", "exchange", "bridge", "bridge_treasury", "pool"].includes(ent.kind)) {
        endLabel = ent.label; endReason = "已知实体"; break;
      }
      flowStatus(`追踪第 ${hop + 1} 跳：${ent.label} …`);
      await expand(cur);
      F.cy.getElementById(ent.id).addClass("trace");
      // outgoing = source is me; the source/target pair already encodes
      // direction (source pays target). Do NOT also test data("dir") — an
      // edge first derived from the OTHER endpoint's expansion keeps its
      // original dir value, which would hide a real outflow here.
      let best = null;
      F.cy.edges().forEach(e => {
        if (e.data("source") === ent.id
            && (!best || e.data("prl") > best.data("prl"))) best = e;
      });
      if (!best) { endLabel = ent.label; endReason = "无对外流出 · 囤币端点"; break; }
      best.addClass("trace");
      const tgt = F.cy.getElementById(best.data("target"));
      tgt.addClass("trace");
      endLabel = tgt.data("label");
      cur = tgt.data("addr");
    }
    F.cy.elements().forEach(el2 => { if (!el2.hasClass("trace")) el2.addClass("dim"); });
    layout(true);
    const el = document.getElementById("flow-focus");
    if (el) el.textContent = `追踪 → 终点：${endLabel}（${endReason}）`;
  } finally {
    F.tracing = false;
    if (btn) btn.disabled = false;
  }
}

/* ---- seed / search ---- */
async function flowSeed(query) {
  await flowInitData();
  await flowReady();
  ensureCy();
  const addr = await resolveQuery(query);
  if (!addr) { flowToast("未找到该地址 / 用户名 / 交易"); return; }
  F.cy.elements().remove();
  F.expanded.clear();
  hideEdgePanel();
  document.getElementById("flow-empty").style.display = "none";
  await addNode(addr, true);
  await expand(addr);
  setFocus(addr);
  layout(true);
}
async function resolveQuery(q) {
  q = (q || "").trim();
  if (!q) return null;
  if (q.startsWith("prl1")) return q;
  if (q.startsWith("0x")) { flowToast("资金流图仅支持 Pearl(prl1) 地址"); return null; }
  if (/^[0-9a-fA-F]{64}$/.test(q)) {                 // txid -> its main output address
    const tx = await txInfo(q);
    if (tx && tx.outputs && tx.outputs[0]) return tx.outputs[0].address;
    return null;
  }
  const name = q.replace(/^@/, "").toLowerCase();      // @username
  return F.userIndex[name] || null;
}

/* ---- entry (called by app.js route) ---- */
window.renderFlow = function (seed) {
  flowInitData();
  const empty = document.getElementById("flow-empty");
  if (seed) { flowSeed(seed); }
  else if (F.cy && F.cy.nodes().length) { /* keep current graph */ }
  else if (empty) { empty.style.display = "block"; }
};

/* wire controls once DOM is ready */
function flowWire() {
  const go = document.getElementById("flow-go");
  const inp = document.getElementById("flow-search");
  const reset = document.getElementById("flow-reset");
  const win = document.getElementById("flow-window");
  const trace = document.getElementById("flow-trace");
  if (go) go.onclick = () => { if (inp.value.trim()) location.hash = "flow/" + encodeURIComponent(inp.value.trim()); };
  if (inp) inp.addEventListener("keydown", e => { if (e.key === "Enter" && inp.value.trim()) location.hash = "flow/" + encodeURIComponent(inp.value.trim()); });
  if (reset) reset.onclick = () => {
    if (F.cy) F.cy.elements().remove();
    F.expanded.clear(); F.focus = null;
    hideEdgePanel();
    const el = document.getElementById("flow-focus"); if (el) el.textContent = "";
    const em = document.getElementById("flow-empty"); if (em) em.style.display = "block";
    location.hash = "flow";
  };
  if (win) win.onchange = () => {
    F.windowDays = Number(win.value) || 0;
    hideEdgePanel();
    if (F.focus) flowSeed(F.focus);        // re-scan under the new window
  };
  if (trace) trace.onclick = () => { traceFlow(); };
}
if (document.readyState !== "loading") flowWire();
else document.addEventListener("DOMContentLoaded", flowWire);
