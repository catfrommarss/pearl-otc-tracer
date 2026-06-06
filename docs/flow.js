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

const F = {
  entities: {}, idents: {}, userIndex: {},
  txCache: new Map(), addrCache: new Map(),
  expanded: new Set(),
  cy: null, dataLoaded: false, focus: null,
};

const KIND_COLOR = {
  pearl_otc: "#4ade80", system: "#fbbf24", exchange: "#fbbf24",
  bridge: "#5b8def", bridge_treasury: "#5b8def", pool: "#c084fc",
  unknown: "#9ca3af",
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

/* ---- data + prlscan fetch ---- */
async function flowInitData() {
  if (F.dataLoaded) return;
  const get = async f => {
    try { const r = await fetch(f, { cache: "no-store" }); return r.ok ? r.json() : null; }
    catch { return null; }
  };
  const [ent, ids] = await Promise.all([get("data/entities.json"), get("data/identities.json")]);
  F.entities = ent || {}; F.idents = ids || {};
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
async function pget(path) {
  const r = await fetch(PS + path, { cache: "no-store" });
  if (!r.ok) throw new Error("prlscan " + r.status);
  return r.json();
}
async function addrInfo(addr) {
  if (F.addrCache.has(addr)) return F.addrCache.get(addr);
  let d = null;
  try { d = await pget("/v1/addresses/" + encodeURIComponent(addr)); } catch (e) { throw e; }
  F.addrCache.set(addr, d);
  return d;
}
async function txInfo(txid) {
  if (F.txCache.has(txid)) return F.txCache.get(txid);
  let d = null;
  try { d = await pget("/v1/txs/" + encodeURIComponent(txid)); } catch { d = null; }
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
    ],
  });
  const cy = F.cy;
  cy.on("tap", "node", ev => {
    const n = ev.target;
    setFocus(n.data("addr"));
    expand(n.data("addr")).then(() => layout(true));
  });
  cy.on("dbltap", "node", ev => {
    const a = ev.target.data("addr");
    if (a) location.hash = "address/" + a;
  });
  cy.on("mouseover", "node", ev => showTip(ev.target, ev.originalEvent));
  cy.on("mouseout", "node", hideTip);
  cy.on("tap", ev => { if (ev.target === cy) hideTip(); });
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
  let bal = 0;
  try { const info = await addrInfo(addr); bal = info ? (Number(info.balance_grains) || 0) / G : 0; }
  catch { /* keep node with unknown balance */ }
  const size = Math.max(24, Math.min(92, 20 + Math.sqrt(bal) / 3));
  F.cy.add({ group: "nodes",
    data: { id: ent.id, addr, label: ent.label, kind: ent.kind, bal, size },
    classes: focal ? "focal" : "" });
  return ent.id;
}
function addEdge(src, dst, grains, dir) {
  const id = "e:" + src + "→" + dst;
  const ex = F.cy.getElementById(id);
  const prl = grains / G;
  if (ex.length) { ex.data("prl", (ex.data("prl") || 0) + prl); return; }
  F.cy.add({ group: "edges", data: { id, source: src, target: dst, prl, dir }, classes: dir });
}

async function expand(addr) {
  if (!addr || F.expanded.has(addr)) return;
  F.expanded.add(addr);
  const myId = entOf(addr).id;

  // 1) Page through the (cheap) tx list. Each list item carries delta_grains,
  //    so we learn every tx's direction + size WITHOUT fetching its body. This
  //    is what lets us reach rare-but-large OUTFLOWS that a recent-window scan
  //    misses: an accumulating whale may have e.g. 155 inbound txs vs only 8
  //    outbound — its big consolidations sit deep in history, far past the
  //    most-recent page.
  let list = [];
  try {
    let cursor = null;
    for (let p = 0; p < 6; p++) {
      const d = await pget("/v1/addresses/" + encodeURIComponent(addr) + "/txs?limit=50"
        + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      const items = (d && d.items) || [];
      list.push(...items);
      cursor = d && d.next_cursor;
      if (!cursor || !items.length) break;
    }
  } catch { flowToast("prlscan 暂时不可用"); F.expanded.delete(addr); return; }
  if (!list.length) return;

  // 2) Fetch tx bodies only for the biggest txs in EACH direction, so inflows
  //    and outflows are both represented regardless of how lopsided the counts.
  const mag = it => Math.abs(it.delta_grains || 0);
  const byMag = (a, b) => mag(b) - mag(a);
  const inTxs = list.filter(it => (it.delta_grains || 0) > 0).sort(byMag).slice(0, 20);
  const outTxs = list.filter(it => (it.delta_grains || 0) < 0).sort(byMag).slice(0, 20);

  const agg = {};   // counterparty entityId -> {addr,in,out,ent}
  await mapLimit([...inTxs, ...outTxs], 6, async it => {
    const tx = await txInfo(it.txid);
    if (!tx) return;
    const ins = tx.inputs || [], outs = tx.outputs || [];
    const focalIsInput = ins.some(i => i.prev_address === addr);
    if (focalIsInput) {
      // SENT — each output to another entity is a recipient (out-edge)
      for (const o of outs) {
        const a = o.address;
        if (!a || a === addr) continue;
        const ce = entOf(a);
        if (ce.id === myId) continue;       // change / self
        (agg[ce.id] = agg[ce.id] || { addr: a, in: 0, out: 0, ent: ce }).out += (o.value_grains || 0);
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
        if (ce.id !== myId)
          (agg[ce.id] = agg[ce.id] || { addr: big.prev_address, in: 0, out: 0, ent: ce }).in += recv;
      }
    }
  });

  // 3) Show the top counterparties per direction (deduped), so outflows always
  //    surface even when inbound activity dwarfs them. A dust floor relative to
  //    the biggest flow keeps the graph focused (hides 1-PRL test txs etc.).
  const all = Object.values(agg);
  let maxMag = 0;
  for (const c of all) maxMag = Math.max(maxMag, c.in, c.out);
  const floor = Math.max(G, maxMag * 0.001);    // >= 1 PRL, and >= 0.1% of the largest flow
  const topIn = all.filter(c => c.in >= floor).sort((a, b) => b.in - a.in).slice(0, 10);
  const topOut = all.filter(c => c.out >= floor).sort((a, b) => b.out - a.out).slice(0, 8);
  const pick = new Map();
  for (const c of [...topIn, ...topOut]) pick.set(c.ent.id, c);
  for (const c of pick.values()) {
    await addNode(c.addr, false);
    if (c.in >= floor) addEdge(c.ent.id, myId, c.in, "in");
    if (c.out >= floor) addEdge(myId, c.ent.id, c.out, "out");
  }
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
  const kn = { pearl_otc: "OTC用户", system: "实体", bridge: "桥", pool: "矿池", unknown: "未知" }[k] || k;
  tip.innerHTML = `<b>${node.data("label")}</b><br>${kn} · 余额 ${fnum(node.data("bal"))} PRL`
    + `<br><span class="muted">${fshort(node.data("addr"))} · 点击展开 / 双击看详情</span>`;
  const x = (ev && ev.clientX) || 0, y = (ev && ev.clientY) || 0;
  tip.style.left = (x + 14) + "px";
  tip.style.top = (y + 14) + "px";
  tip.hidden = false;
}
function hideTip() { const t = document.getElementById("flow-tip"); if (t) t.hidden = true; }

/* ---- seed / search ---- */
async function flowSeed(query) {
  await flowInitData();
  await flowReady();
  ensureCy();
  const addr = await resolveQuery(query);
  if (!addr) { flowToast("未找到该地址 / 用户名 / 交易"); return; }
  F.cy.elements().remove();
  F.expanded.clear();
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
  if (go) go.onclick = () => { if (inp.value.trim()) location.hash = "flow/" + encodeURIComponent(inp.value.trim()); };
  if (inp) inp.addEventListener("keydown", e => { if (e.key === "Enter" && inp.value.trim()) location.hash = "flow/" + encodeURIComponent(inp.value.trim()); });
  if (reset) reset.onclick = () => {
    if (F.cy) F.cy.elements().remove();
    F.expanded.clear(); F.focus = null;
    const el = document.getElementById("flow-focus"); if (el) el.textContent = "";
    const em = document.getElementById("flow-empty"); if (em) em.style.display = "block";
    location.hash = "flow";
  };
}
if (document.readyState !== "loading") flowWire();
else document.addEventListener("DOMContentLoaded", flowWire);
