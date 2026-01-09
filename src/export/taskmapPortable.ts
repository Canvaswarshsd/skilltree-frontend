// frontend/src/export/taskmapPortable.ts
import type { Task, TaskAttachment } from "../MapView";

type Meta = {
  centerDone?: boolean;
  centerAttachments?: TaskAttachment[];
  branchEdgeColorOverride?: Record<string, string>;
  edgeColorOverride?: Record<string, string>;
};

type Args = Meta & {
  projectTitle: string;
  tasks: Task[];
  nodeOffset: Record<string, { x: number; y: number }>;
  branchColorOverride: Record<string, string>;
  centerColor: string;
};

const slugifyTitle = (t: string) =>
  t
    .trim()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function normalizeAttachment(a: any): TaskAttachment | null {
  const name = String(a?.name ?? "attachment.pdf");
  const dataUrl =
    typeof a?.dataUrl === "string"
      ? a.dataUrl
      : typeof a?.url === "string"
        ? a.url
        : typeof a?.href === "string"
          ? a.href
          : "";

  if (!dataUrl) return null;
  return { name, dataUrl };
}

function normalizeTasks(tasks: Task[]): Task[] {
  const src = Array.isArray(tasks) ? tasks : [];
  return src.map((t: any) => {
    const atts = Array.isArray(t?.attachments)
      ? (t.attachments.map(normalizeAttachment).filter(Boolean) as TaskAttachment[])
      : [];
    return { ...t, attachments: atts };
  });
}

function normalizeCenterAttachments(atts?: TaskAttachment[]): TaskAttachment[] {
  const src = Array.isArray(atts) ? atts : [];
  return (src as any[]).map(normalizeAttachment).filter(Boolean) as TaskAttachment[];
}

export function exportPortableTaskMap(args: Args) {
  const safeTasks = normalizeTasks(args.tasks ?? []);
  const safeCenterAttachments = normalizeCenterAttachments(args.centerAttachments);

  const data = {
    v: 1,
    app: "OpenTaskMap",
    createdAt: Date.now(),

    projectTitle: args.projectTitle || "Project",
    centerColor: args.centerColor || "#020617",

    // meta aus MapView (falls nicht vorhanden: defaults)
    centerDone: !!args.centerDone,
    centerAttachments: safeCenterAttachments,
    branchEdgeColorOverride: args.branchEdgeColorOverride ?? {},
    edgeColorOverride: args.edgeColorOverride ?? {},

    tasks: safeTasks,
    nodeOffset: args.nodeOffset ?? {},
    branchColorOverride: args.branchColorOverride ?? {},
  };

  // sicher in <script> einbetten
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no" />
<title>${escapeHtml(data.projectTitle)} – OpenTaskMap</title>
<style>
  :root{
    --bg:#0b1220;
    --panel: rgba(2,6,23,0.82);
    --panelBorder: rgba(255,255,255,0.10);
    --text: rgba(255,255,255,0.92);
    --muted: rgba(255,255,255,0.65);
    --gold: #fbbf24;
    --shadow: 0 12px 36px rgba(0,0,0,0.18);
  }
  html,body{
    height:100%;
    margin:0;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
    background: var(--bg);
    color: var(--text);
    overflow:hidden;
    overscroll-behavior: none;
  }

  .topbar{
    position: fixed;
    left: calc(14px + env(safe-area-inset-left));
    right: calc(14px + env(safe-area-inset-right));
    top: calc(14px + env(safe-area-inset-top));
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap: 12px;
    padding: calc(10px + env(safe-area-inset-top)) 12px 10px 12px;
    border-radius: 14px;
    background: var(--panel);
    border: 1px solid var(--panelBorder);
    box-shadow: var(--shadow);
    z-index: 10;
    backdrop-filter: blur(10px);
  }
  .title{font-weight:900; letter-spacing:0.2px; font-size:14px; display:flex; gap:10px; align-items:baseline;}
  .title .brand{color: var(--gold); font-weight:900;}
  .title .name{color: var(--text); font-weight:800; max-width: 55vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .hint{color: var(--muted); font-size:12px; white-space:nowrap;}
  .btn{
    appearance:none; border:1px solid var(--panelBorder);
    background: rgba(255,255,255,0.06); color: var(--text);
    padding: 8px 10px; border-radius: 12px;
    font-weight:800; font-size:12px; cursor:pointer;
  }
  .btn:hover{background: rgba(255,255,255,0.10);}

  .viewport{
    position: absolute;
    inset: 0;
    touch-action: none;
  }
  .world{
    position:absolute; left:0; top:0;
    transform-origin: 0 0;
    touch-action: none;
  }
  .map-stage{
    position:absolute; left:0; top:0;
    background: #ffffff;
    border-radius: 18px;
    box-shadow: var(--shadow);
    overflow:hidden;
    touch-action: none;
  }
  .edges{
    position:absolute; inset:0;
    overflow: visible;
    pointer-events: none;
  }
  .node{
    position:absolute;
    transform: translate(-50%,-50%);
    border-radius: 999px;
    box-shadow: var(--shadow);
    display:flex;
    align-items:center;
    justify-content:center;
    text-align:center;
    font-weight:800;
    color: #fff;
    user-select:none;
    cursor: pointer;
    touch-action: none;
  }
  .node[data-done="true"]::after{
    content:"";
    position:absolute; inset:0;
    border-radius: 999px;
    background: rgba(255,255,255,0.28);
    pointer-events: none;
  }
  .node .text{position:relative; z-index:1; line-height:1.1; font-size:14px; padding: 0 10px;}
  .node .text span{display:block; white-space:nowrap;}
  .badge{
    position:absolute; z-index:2;
    width: 26px; height: 26px;
    border-radius: 999px;
    display:flex; align-items:center; justify-content:center;
    font-weight:900;
    box-shadow: 0 10px 22px rgba(0,0,0,0.18);
    pointer-events: none;
  }
  .badge.done{right: -6px; top: -6px; background:#22c55e;}
  .badge.done span{color:#fff; transform: translateY(-0.5px);}

  .overlay{
    position: fixed; inset:0;
    background: rgba(2,6,23,0.72);
    display:none;
    z-index: 30;
  }
  .overlay.open{display:block;}
  .modal{
    position: absolute; left: 50%; top: 50%;
    transform: translate(-50%,-50%);
    width: min(980px, 92vw);
    height: min(720px, 82vh);
    background: rgba(2,6,23,0.94);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 18px;
    box-shadow: 0 18px 60px rgba(0,0,0,0.35);
    overflow:hidden;
    display:flex;
    flex-direction:column;
  }
  .modalHeader{
    padding: 10px 12px;
    display:flex; align-items:center; justify-content:space-between;
    gap: 10px;
    border-bottom: 1px solid rgba(255,255,255,0.10);
  }
  .modalTitle{
    font-weight:900; font-size:13px; color: rgba(255,255,255,0.92);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .modalBody{
    flex:1;
    display:flex;
    min-height:0;
  }
  .fileList{
    width: 280px;
    border-right: 1px solid rgba(255,255,255,0.10);
    padding: 10px;
    overflow:auto;
    -webkit-overflow-scrolling: touch;
  }
  .fileItem{
    width:100%;
    text-align:left;
    padding: 8px 10px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.06);
    color: rgba(255,255,255,0.92);
    cursor:pointer;
    font-weight:800;
    font-size:12px;
    margin-bottom: 8px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .fileItem:hover{background: rgba(255,255,255,0.10);}
  .viewer{
    flex:1;
    min-width:0;
    background: #0b1220;
    position: relative;
  }
  .viewer iframe{
    position:absolute; inset:0;
    width:100%; height:100%;
    border:0;
    background:#0b1220;
  }
  .empty{
    color: rgba(255,255,255,0.70);
    font-size: 12px;
    padding: 14px;
  }
</style>
</head>
<body>
  <div class="topbar">
    <div class="title">
      <span class="brand">OpenTaskMap</span>
      <span class="name" id="tTitle"></span>
    </div>
    <div style="display:flex; gap:10px; align-items:center;">
      <div class="hint">Drag to pan · Wheel/Pinch to zoom · Click a node to open PDFs</div>
      <button class="btn" id="btnCenter">Center</button>
    </div>
  </div>

  <div class="viewport" id="viewport">
    <div class="world" id="world"></div>
  </div>

  <div class="overlay" id="overlay" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modalHeader">
        <div class="modalTitle" id="modalTitle">Files</div>
        <button class="btn" id="btnClose">Close</button>
      </div>
      <div class="modalBody">
        <div class="fileList" id="fileList"></div>
        <div class="viewer" id="viewer">
          <iframe id="pdfFrame" title="PDF Viewer"></iframe>
        </div>
      </div>
    </div>
  </div>

  <script id="__OTM_DATA__" type="application/json">${json}</script>

<script>
(() => {
  // iOS gesture zoom block (zusätzlich zu touch-action)
  const prevent = (e) => e.preventDefault();
  document.addEventListener("gesturestart", prevent, { passive:false });
  document.addEventListener("gesturechange", prevent, { passive:false });
  document.addEventListener("gestureend", prevent, { passive:false });

  const DATA = JSON.parse(document.getElementById("__OTM_DATA__").textContent);

  const CENTER_ID = "__CENTER__";
  const BRANCH_COLORS = ["#f97316","#6366f1","#22c55e","#eab308","#0ea5e9","#f43f5e"];

  const R_CENTER = 75;
  const R_ROOT = 60;
  const R_CHILD = 50;
  const ROOT_RADIUS = 280;
  const RING = 130;

  const MIN_Z = 0.35;
  const MAX_Z = 4;

  const EXPORT_MIN_PADDING_PX = 18;
  const EXPORT_SHADOW_PAD_X = 36;
  const EXPORT_SHADOW_PAD_TOP = 24;
  const EXPORT_SHADOW_PAD_BOTTOM = 48;

  const MAXLEN_CENTER = 12;
  const MAXLEN_ROOT_AND_CHILD = 12;

  const worldEl = document.getElementById("world");
  const viewportEl = document.getElementById("viewport");
  const btnCenter = document.getElementById("btnCenter");
  const topbarEl = document.querySelector(".topbar");

  document.getElementById("tTitle").textContent = (DATA.projectTitle || "Project");

  const tasks = Array.isArray(DATA.tasks) ? DATA.tasks : [];
  const nodeOffset = DATA.nodeOffset || {};
  const branchColorOverride = DATA.branchColorOverride || {};
  const branchEdgeColorOverride = DATA.branchEdgeColorOverride || {};
  const edgeColorOverride = DATA.edgeColorOverride || {};

  const taskById = new Map(tasks.map(t => [t.id, t]));
  const childrenByParent = new Map();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const arr = childrenByParent.get(t.parentId) || [];
    arr.push(t);
    childrenByParent.set(t.parentId, arr);
  }
  const roots = tasks.filter(t => t.parentId === null);

  const getOffset = (id) => nodeOffset[id] || {x:0,y:0};
  const edgeKey = (p,c) => p + "__" + c;

  const splitTitleLines = (t, maxLen, maxLines=3) => {
    const s = String(t || "").trim() || "Project";
    const hardParts = s.split(/\\r?\\n/);
    const lines = [];
    for (let part of hardParts) {
      while (part.length > 0 && lines.length < maxLines) {
        if (part.length <= maxLen) { lines.push(part); part=""; break; }
        let breakAt = part.lastIndexOf(" ", maxLen);
        if (breakAt > 0) {
          lines.push(part.slice(0, breakAt));
          part = part.slice(breakAt + 1);
        } else {
          const sliceLen = Math.max(1, maxLen - 1);
          lines.push(part.slice(0, sliceLen) + "-");
          part = part.slice(sliceLen);
        }
      }
      if (lines.length >= maxLines) break;
    }
    return lines.slice(0, maxLines);
  };

  const segmentBetweenCircles = (c1x,c1y,r1,c2x,c2y,r2,overlap=0) => {
    const dx = c2x - c1x;
    const dy = c2y - c1y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const x1 = c1x + ux * (r1 - overlap);
    const y1 = c1y + uy * (r1 - overlap);
    const x2 = c2x - ux * (r2 - overlap);
    const y2 = c2y - uy * (r2 - overlap);
    return { x1,y1,x2,y2 };
  };

  // Done-Vererbung wie in MapView
  const doneCache = new Map();
  const effectiveDone = (id) => {
    if (doneCache.has(id)) return doneCache.get(id);
    if (id === CENTER_ID) { doneCache.set(id, !!DATA.centerDone); return !!DATA.centerDone; }
    let cur = taskById.get(id);
    const chain = [];
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? taskById.get(cur.parentId) : null;
    }
    let value = !!DATA.centerDone;
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i];
      if (typeof t.done === "boolean") value = t.done;
    }
    doneCache.set(id, value);
    return value;
  };

  const getAttachments = (id) => {
    if (id === CENTER_ID) return Array.isArray(DATA.centerAttachments) ? DATA.centerAttachments : [];
    const t = taskById.get(id);
    return (t && Array.isArray(t.attachments)) ? t.attachments : [];
  };

  // Positionen wie MapView (Roots radial, Children spread)
  const pos = {};
  pos[CENTER_ID] = { x: 0, y: 0 };

  const totalRoots = Math.max(roots.length, 1);

  const rec = (parentId, px, py, gpx, gpy) => {
    const kids = childrenByParent.get(parentId) || [];
    if (!kids.length) return;

    const base = Math.atan2(py - gpy, px - gpx);
    const SPREAD = Math.min(Math.PI, Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6)));
    const step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
    const start = base - SPREAD / 2;

    for (let idx = 0; idx < kids.length; idx++) {
      const kid = kids[idx];
      const ang = start + idx * step;

      const cxBase = px + Math.cos(ang) * RING;
      const cyBase = py + Math.sin(ang) * RING;

      const ko = getOffset(kid.id);
      const cx = cxBase + ko.x;
      const cy = cyBase + ko.y;

      pos[kid.id] = { x: cx, y: cy };
      rec(kid.id, cx, cy, px, py);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const ang = (i / totalRoots) * Math.PI * 2;

    const rxBase = Math.cos(ang) * ROOT_RADIUS;
    const ryBase = Math.sin(ang) * ROOT_RADIUS;

    const ro = getOffset(root.id);
    const rx = rxBase + ro.x;
    const ry = ryBase + ro.y;

    pos[root.id] = { x: rx, y: ry };
    rec(root.id, rx, ry, 0, 0);
  }

  const rootIndex = new Map(roots.map((r,i)=>[r.id,i]));

  const rootBubbleColor = (rootId) => {
    const idx = rootIndex.get(rootId) ?? 0;
    return branchColorOverride[rootId] || BRANCH_COLORS[idx % BRANCH_COLORS.length];
  };

  const bubbleColorFor = (id) => {
    if (id === CENTER_ID) return DATA.centerColor || "#020617";
    const t = taskById.get(id);
    if (!t) return "#64748b";
    let cur = t;
    while (cur && cur.parentId) cur = taskById.get(cur.parentId);
    const rootId = cur ? cur.id : t.id;
    const base = rootBubbleColor(rootId);
    return (t.parentId ? (t.color || base) : base);
  };

  const edgeBaseColorForRoot = (rootId) => {
    const base = rootBubbleColor(rootId);
    return branchEdgeColorOverride[rootId] || base;
  };

  // Layout bounds
  const nodes = [];
  const edges = [];

  const pushNode = (id, kind, r) => {
    const p = pos[id];
    nodes.push({
      id,
      kind,
      x: p.x,
      y: p.y,
      r,
      bubbleColor: bubbleColorFor(id),
      title: (id === CENTER_ID) ? (DATA.projectTitle || "Project") : (taskById.get(id)?.title || "Task"),
      done: effectiveDone(id)
    });
  };

  pushNode(CENTER_ID, "center", R_CENTER);

  for (const root of roots) {
    pushNode(root.id, "root", R_ROOT);
    const c = pos[CENTER_ID];
    const rP = pos[root.id];
    const seg = segmentBetweenCircles(c.x,c.y,R_CENTER,rP.x,rP.y,R_ROOT);
    edges.push({
      parentId: CENTER_ID,
      childId: root.id,
      ...seg,
      color: edgeBaseColorForRoot(root.id)
    });
  }

  const addEdgesRec = (parentId, rootId) => {
    const kids = childrenByParent.get(parentId) || [];
    if (!kids.length) return;
    for (const kid of kids) {
      pushNode(kid.id, "child", R_CHILD);

      const pP = pos[parentId];
      const cP = pos[kid.id];
      const pr = (parentId === CENTER_ID) ? R_CENTER : (taskById.get(parentId)?.parentId === null ? R_ROOT : R_CHILD);
      const seg = segmentBetweenCircles(pP.x,pP.y,pr,cP.x,cP.y,R_CHILD);

      const baseEdge = edgeBaseColorForRoot(rootId);
      const key = edgeKey(parentId, kid.id);
      const color = edgeColorOverride[key] || baseEdge;

      edges.push({ parentId, childId: kid.id, ...seg, color });
      addEdgesRec(kid.id, rootId);
    }
  };

  for (const root of roots) addEdgesRec(root.id, root.id);

  // bounds (nodes only)
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    minY = Math.min(minY, n.y - n.r);
    maxY = Math.max(maxY, n.y + n.r);
  }
  minX -= (EXPORT_SHADOW_PAD_X + EXPORT_MIN_PADDING_PX);
  maxX += (EXPORT_SHADOW_PAD_X + EXPORT_MIN_PADDING_PX);
  minY -= (EXPORT_SHADOW_PAD_TOP + EXPORT_MIN_PADDING_PX);
  maxY += (EXPORT_SHADOW_PAD_BOTTOM + EXPORT_MIN_PADDING_PX);

  const width = Math.max(1, Math.ceil(maxX - minX));
  const height = Math.max(1, Math.ceil(maxY - minY));
  const originX = -minX;
  const originY = -minY;

  // build stage
  const stage = document.createElement("div");
  stage.className = "map-stage";
  stage.style.width = width + "px";
  stage.style.height = height + "px";

  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("class","edges");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  for (const e of edges) {
    const line = document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1", String(originX + e.x1));
    line.setAttribute("y1", String(originY + e.y1));
    line.setAttribute("x2", String(originX + e.x2));
    line.setAttribute("y2", String(originY + e.y2));
    line.setAttribute("stroke", e.color);
    line.setAttribute("stroke-width","3");
    line.setAttribute("stroke-linecap","round");
    svg.appendChild(line);
  }

  stage.appendChild(svg);

  // click suppression after pan/pinch
  let suppressClickUntil = 0;
  const suppressClick = () => { suppressClickUntil = Date.now() + 250; };

  for (const n of nodes) {
    const el = document.createElement("div");
    el.className = "node";
    el.style.left = (originX + n.x) + "px";
    el.style.top = (originY + n.y) + "px";
    el.style.width = (n.r*2) + "px";
    el.style.height = (n.r*2) + "px";
    el.style.background = n.bubbleColor;
    el.dataset.id = n.id;
    el.dataset.done = n.done ? "true" : "false";

    const text = document.createElement("div");
    text.className = "text";
    const maxLen = (n.kind === "center") ? MAXLEN_CENTER : MAXLEN_ROOT_AND_CHILD;
    const lines = splitTitleLines(n.title, maxLen, 3);
    for (const ln of lines) {
      const sp = document.createElement("span");
      sp.textContent = ln;
      text.appendChild(sp);
    }
    el.appendChild(text);

    if (n.done) {
      const badge = document.createElement("div");
      badge.className = "badge done";
      const s = document.createElement("span");
      s.textContent = "✓";
      badge.appendChild(s);
      el.appendChild(badge);
    }

    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (Date.now() < suppressClickUntil) return;
      openFilesForNode(n.id);
    });

    stage.appendChild(el);
  }

  worldEl.innerHTML = "";
  worldEl.appendChild(stage);

  // pan/zoom (mouse + touch + pinch)
  let panX = 0, panY = 0, z = 1;

  const clampZ = (v) => Math.max(MIN_Z, Math.min(MAX_Z, v));

  const applyTransform = () => {
    worldEl.style.transform = \`translate(\${panX}px,\${panY}px) scale(\${z})\`;
  };

  const centerView = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const tb = topbarEl ? topbarEl.getBoundingClientRect() : { bottom: 74 };
    const topbarBottom = tb.bottom + 10; // small spacing
    const usableH = Math.max(1, vh - topbarBottom - 14);

    z = clampZ(Math.min(1, Math.min((vw*0.90)/width, (usableH*0.92)/height)));
    panX = (vw/2) - (width*z)/2;
    panY = (topbarBottom + (usableH/2)) - (height*z)/2;

    applyTransform();
  };

  btnCenter.addEventListener("click", centerView);
  window.addEventListener("resize", centerView);

  // context menu off (for right-drag)
  viewportEl.addEventListener("contextmenu", (e) => e.preventDefault());

  // pointers
  const pointers = new Map(); // id -> {x,y}
  let panStart = null;
  let pinchStart = null;

  const isOnNode = (e) => !!(e.target && e.target.closest && e.target.closest(".node"));

  const startPinchIfPossible = () => {
    if (pointers.size !== 2) return;
    const ids = Array.from(pointers.keys());
    const p1 = pointers.get(ids[0]);
    const p2 = pointers.get(ids[1]);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;

    // capture both pointers (so moves bleiben stabil)
    try { viewportEl.setPointerCapture?.(ids[0]); } catch {}
    try { viewportEl.setPointerCapture?.(ids[1]); } catch {}

    pinchStart = {
      dist,
      z0: z,
      worldX: (midX - panX) / z,
      worldY: (midY - panY) / z,
      midX,
      midY,
    };
    panStart = null;
  };

  viewportEl.addEventListener("pointerdown", (e) => {
    const overlayOpen = document.getElementById("overlay").classList.contains("open");
    if (overlayOpen) return;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Wenn wir jetzt 2 Pointer haben: pinch starten (auch wenn einer auf Node begann)
    if (pointers.size === 2) {
      startPinchIfPossible();
      return;
    }

    // Pan nur starten, wenn NICHT auf Node begonnen wurde
    if (!isOnNode(e)) {
      try { viewportEl.setPointerCapture?.(e.pointerId); } catch {}
      panStart = { id: e.pointerId, x: e.clientX, y: e.clientY, panX0: panX, panY0: panY };
    } else {
      panStart = null;
    }
  });

  viewportEl.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const overlayOpen = document.getElementById("overlay").classList.contains("open");
    if (overlayOpen) return;

    if (pinchStart && pointers.size >= 2) {
      const ids = Array.from(pointers.keys()).slice(0, 2);
      const p1 = pointers.get(ids[0]);
      const p2 = pointers.get(ids[1]);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;

      const scale = dist / (pinchStart.dist || 1);
      z = clampZ(pinchStart.z0 * scale);

      // keep world point under midpoint stable
      panX = midX - pinchStart.worldX * z;
      panY = midY - pinchStart.worldY * z;

      suppressClick();
      applyTransform();
      return;
    }

    if (panStart && panStart.id === e.pointerId) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      if (Math.hypot(dx, dy) > 3) suppressClick();
      panX = panStart.panX0 + dx;
      panY = panStart.panY0 + dy;
      applyTransform();
    }
  });

  const endPointer = (e) => {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);

    try { viewportEl.releasePointerCapture?.(e.pointerId); } catch {}

    if (pointers.size < 2) pinchStart = null;

    if (pointers.size === 1) {
      // if one finger remains, allow continuing pan (even if it started on node during pinch)
      const [id, p] = pointers.entries().next().value;
      panStart = { id, x: p.x, y: p.y, panX0: panX, panY0: panY };
    } else {
      panStart = null;
    }
  };

  viewportEl.addEventListener("pointerup", endPointer);
  viewportEl.addEventListener("pointercancel", endPointer);

  // wheel zoom
  viewportEl.addEventListener("wheel", (e) => {
    e.preventDefault();

    const overlayOpen = document.getElementById("overlay").classList.contains("open");
    if (overlayOpen) return;

    const rect = viewportEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    const next = clampZ(z * factor);

    const wx = (cx - panX) / z;
    const wy = (cy - panY) / z;

    z = next;
    panX = cx - wx * z;
    panY = cy - wy * z;

    suppressClick();
    applyTransform();
  }, { passive:false });

  // file overlay
  const overlay = document.getElementById("overlay");
  const btnClose = document.getElementById("btnClose");
  const fileList = document.getElementById("fileList");
  const pdfFrame = document.getElementById("pdfFrame");
  const modalTitle = document.getElementById("modalTitle");

  let currentObjectUrl = null;

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

  const closeOverlay = () => {
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden","true");
    fileList.innerHTML = "";
    pdfFrame.removeAttribute("src");
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  };

  btnClose.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOverlay(); });

  const openPdf = async (att) => {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    const du = String(att?.dataUrl || "");
    if (!du) {
      pdfFrame.removeAttribute("src");
      return;
    }

    // Wenn jemand aus Versehen blob: URLs exportiert hat -> die sind in einer neuen Datei nicht mehr gültig
    if (du.startsWith("blob:")) {
      pdfFrame.removeAttribute("src");
      fileList.innerHTML = '<div class="empty">This attachment was stored as a blob URL and cannot be embedded. Please re-attach the PDF so it becomes a data URL.</div>';
      return;
    }

    // iOS: data: direkt ist oft am stabilsten im iframe
    if (isIOS()) {
      pdfFrame.src = du;
      return;
    }

    // sonst: dataUrl -> Blob -> ObjectURL (stabiler/performanter)
    try {
      const res = await fetch(du);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      currentObjectUrl = url;
      pdfFrame.src = url;
    } catch {
      pdfFrame.src = du;
    }
  };

  const openFilesForNode = (nodeId) => {
    const atts = getAttachments(nodeId).filter(a => a && a.dataUrl);
    if (!atts || atts.length === 0) return;

    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden","false");

    const title = (nodeId === CENTER_ID) ? (DATA.projectTitle || "Project") : (taskById.get(nodeId)?.title || "Task");
    modalTitle.textContent = title;

    fileList.innerHTML = "";

    if (atts.length === 1) {
      fileList.innerHTML = '<div class="empty">1 PDF attached.</div>';
      void openPdf(atts[0]);
      return;
    }

    const info = document.createElement("div");
    info.className = "empty";
    info.textContent = atts.length + " PDFs attached:";
    fileList.appendChild(info);

    for (const att of atts) {
      const b = document.createElement("button");
      b.className = "fileItem";
      b.textContent = att.name || "attachment.pdf";
      b.addEventListener("click", () => void openPdf(att));
      fileList.appendChild(b);
    }

    void openPdf(atts[0]);
  };

  // initial center
  centerView();
})();
</script>
</body>
</html>`;

  const filenameBase = slugifyTitle(data.projectTitle) || "taskmap";
  const filename = `${filenameBase}.taskmap.html`;
  downloadBlob(filename, new Blob([html], { type: "text/html;charset=utf-8" }));
}

function escapeHtml(s: string) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
