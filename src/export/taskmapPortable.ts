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

// Attachments im Export: dataUrl ODER ref auf <script type="text/plain"> (damit JSON.parse klein bleibt)
type PortableAttachment = {
  name: string;
  dataUrl?: string;
  ref?: string;
};

const slugifyTitle = (t: string) =>
  t
    .trim()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();

function isIOSLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/i.test(ua);
  const iPadOS = navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1;
  return iOS || iPadOS;
}

async function trySaveWithFilePicker(filename: string, blob: Blob): Promise<boolean> {
  const w = window as any;
  if (typeof w.showSaveFilePicker !== "function") return false;

  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "HTML", accept: { "text/html": [".html"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

async function tryShareFile(filename: string, blob: Blob): Promise<boolean> {
  const nav = navigator as any;
  if (!nav?.share) return false;

  try {
    const file = new File([blob], filename, { type: blob.type || "text/html" });
    if (typeof nav.canShare === "function" && !nav.canShare({ files: [file] })) return false;

    await nav.share({ files: [file], title: filename });
    return true;
  } catch {
    return false;
  }
}

function downloadBlob(filename: string, blob: Blob) {
  void (async () => {
    if (await trySaveWithFilePicker(filename, blob)) return;
    if (await tryShareFile(filename, blob)) return;

    const url = URL.createObjectURL(blob);

    // iOS: a.download ist oft blockiert → im neuen Tab öffnen (User kann dann "Share → Save to Files")
    if (isIOSLike()) {
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
  })();
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

function escapeHtml(s: string) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeScriptText(s: string) {
  // verhindert Script-Termination / HTML-Pitfalls
  return String(s ?? "").replace(/<\/script/gi, "<\\/script");
}

// ✅ Hoist: Base64-dataUrls NICHT ins JSON, sondern in separate <script type="text/plain"> Tags
function hoistAttachmentsIntoScripts(
  tasks: Task[],
  centerAtts: TaskAttachment[]
): { tasksPortable: any[]; centerPortable: PortableAttachment[]; attachmentScripts: string } {
  let n = 0;
  const scripts: string[] = [];

  const hoistOne = (att: TaskAttachment): PortableAttachment => {
    const name = String(att?.name || "attachment.pdf");
    const du = String((att as any)?.dataUrl || "");

    if (!du) return { name };

    // blob: ist NICHT portable
    if (du.startsWith("blob:")) return { name, dataUrl: du };

    // data: hoisten → spart RAM beim JSON.parse
    if (du.startsWith("data:")) {
      const id = `__OTM_ATT_${++n}__`;
      scripts.push(
        `<script id="${id}" type="text/plain">${escapeScriptText(du)}</script>`
      );
      return { name, ref: id };
    }

    // normale URL
    return { name, dataUrl: du };
  };

  const tasksPortable = (tasks || []).map((t: any) => {
    const atts = Array.isArray(t?.attachments) ? (t.attachments as TaskAttachment[]) : [];
    const portableAtts = atts.map(hoistOne).filter(Boolean);
    return { ...t, attachments: portableAtts };
  });

  const centerPortable = (centerAtts || []).map(hoistOne).filter(Boolean);

  return { tasksPortable, centerPortable, attachmentScripts: scripts.join("\n") };
}

export function exportPortableTaskMap(args: Args) {
  const safeTasks = normalizeTasks(args.tasks ?? []);
  const safeCenterAttachments = normalizeCenterAttachments(args.centerAttachments);

  const { tasksPortable, centerPortable, attachmentScripts } = hoistAttachmentsIntoScripts(
    safeTasks,
    safeCenterAttachments
  );

  const data = {
    v: 1,
    app: "OpenTaskMap",
    createdAt: Date.now(),

    projectTitle: args.projectTitle || "Project",
    centerColor: args.centerColor || "#020617",

    centerDone: !!args.centerDone,
    centerAttachments: centerPortable, // portable attachments
    branchEdgeColorOverride: args.branchEdgeColorOverride ?? {},
    edgeColorOverride: args.edgeColorOverride ?? {},

    tasks: tasksPortable, // portable tasks
    nodeOffset: args.nodeOffset ?? {},
    branchColorOverride: args.branchColorOverride ?? {},
  };

  // klein halten
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no" />
<title>${escapeHtml(data.projectTitle)} – OpenTaskMap</title>
<style>
  /* Fallbacks (falls CSS vars in irgendeinem Viewer fehlen) */
  html,body{ background:#0b1220; color:#ffffff; }

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

  /* Boot/Errors (wenn irgendwas im Viewer blockiert/crasht) */
  .boot{
    position:fixed; inset:0;
    display:flex; align-items:center; justify-content:center;
    padding: 22px;
    z-index: 50;
    background: rgba(11,18,32,0.96);
  }
  .bootCard{
    width:min(520px, 92vw);
    border-radius: 16px;
    background: rgba(2,6,23,0.86);
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 18px 60px rgba(0,0,0,0.35);
    padding: 14px 14px 12px 14px;
  }
  .bootTitle{ font-weight:900; font-size:13px; margin-bottom:8px; }
  .bootText{ color: rgba(255,255,255,0.74); font-size:12px; line-height:1.35; }
  .bootErr{
    margin-top:10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: rgba(255,255,255,0.78);
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 12px;
    padding: 10px;
    max-height: 180px;
    overflow:auto;
    white-space: pre-wrap;
  }

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
    width: 200px;
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
    overflow:hidden;
  }

  .pdfBar{
    position:absolute; left:0; right:0; top:0;
    height: 44px;
    display:flex; align-items:center; justify-content:space-between;
    gap: 10px;
    padding: 0 10px;
    background: rgba(2,6,23,0.72);
    border-bottom: 1px solid rgba(255,255,255,0.10);
    z-index: 2;
    backdrop-filter: blur(10px);
  }
  .pdfInfo{
    font-weight:900; font-size:12px;
    color: rgba(255,255,255,0.85);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    max-width: 55%;
  }
  .btnSm{
    appearance:none;
    border:1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06);
    color: rgba(255,255,255,0.92);
    padding: 6px 8px;
    border-radius: 10px;
    font-weight:900;
    font-size:12px;
    cursor:pointer;
  }
  .btnSm:hover{background: rgba(255,255,255,0.10);}

  .pdfWrap{
    position:absolute; left:0; right:0; top:44px; bottom:0;
    overflow:hidden;
    background:#0b1220;
  }
  iframe.pdfFrame{
    position:absolute; inset:0;
    width:100%; height:100%;
    border:0;
    background:#0b1220;
  }

  /* clickable message card */
  .pdfMsg{
    position:absolute; inset:0;
    display:flex; align-items:center; justify-content:center;
    padding: 18px;
    z-index: 3;
    pointer-events: auto;
  }
  .pdfMsgCard{
    width: min(460px, 92vw);
    border-radius: 16px;
    background: rgba(2,6,23,0.86);
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 18px 60px rgba(0,0,0,0.35);
    padding: 12px;
  }
  .pdfMsgText{
    color: rgba(255,255,255,0.74);
    font-size: 12px;
    line-height: 1.35;
    margin-bottom: 10px;
  }
  .pdfMsgBtns{
    display:flex; gap:8px; flex-wrap:wrap;
  }

  .modal.one .fileList{ display:none; }
  .modal.one .modalBody{ display:block; }
  .modal.one .viewer{ position:relative; width:100%; height:100%; }

  @media (max-width: 820px){
    .modalBody{ flex-direction:column; }
    .fileList{
      width:auto;
      border-right:none;
      border-bottom: 1px solid rgba(255,255,255,0.10);
      max-height: 120px;
    }
    .hint{ display:none; }
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
    <div class="modal" id="modal" role="dialog" aria-modal="true">
      <div class="modalHeader">
        <div class="modalTitle" id="modalTitle">Files</div>
        <button class="btn" id="btnClose">Close</button>
      </div>
      <div class="modalBody">
        <div class="fileList" id="fileList"></div>
        <div class="viewer" id="viewer">
          <div class="pdfBar">
            <div class="pdfInfo" id="pdfInfo">PDF</div>
            <div style="display:flex; gap:8px; align-items:center;">
              <button class="btnSm" id="pdfOpen">Open</button>
              <button class="btnSm" id="pdfDownload">Download</button>
            </div>
          </div>
          <div class="pdfWrap" id="pdfWrap">
            <div class="pdfMsg" id="pdfMsg" style="display:flex;">
              <div class="pdfMsgCard">
                <div class="pdfMsgText" id="pdfMsgText">Select a PDF.</div>
                <div class="pdfMsgBtns">
                  <button class="btnSm" id="pdfMsgOpen">Open</button>
                  <button class="btnSm" id="pdfMsgSave">Save</button>
                </div>
              </div>
            </div>
            <iframe class="pdfFrame" id="pdfFrame" title="PDF Viewer"></iframe>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="boot" id="boot">
    <div class="bootCard">
      <div class="bootTitle">Loading map…</div>
      <div class="bootText" id="bootText">
        If this stays blank/white on a phone, the file viewer may be blocking scripts or the device ran out of memory.
        Try opening the file in the browser (Safari/Chrome) instead of a preview.
      </div>
      <div class="bootErr" id="bootErr" style="display:none;"></div>
    </div>
  </div>

  <script id="__OTM_DATA__" type="application/json">${json}</script>
  ${attachmentScripts}

<script>
(function(){
  "use strict";

  // show runtime errors instead of white screen
  var boot = document.getElementById("boot");
  var bootErr = document.getElementById("bootErr");
  function showBootError(err){
    try{
      if (!boot) return;
      if (bootErr){
        bootErr.style.display = "block";
        bootErr.textContent = String(err && (err.stack || err.message || err) || "Unknown error");
      }
    }catch{}
  }
  window.addEventListener("error", function(e){ showBootError(e && (e.error || e.message)); });
  window.addEventListener("unhandledrejection", function(e){ showBootError(e && (e.reason || e)); });

  // iOS/iPadOS detect
  var ua = navigator.userAgent || "";
  var IS_IOS = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // prevent pinch-zoom (page)
  (function(){
    var prevent = function(e){ e.preventDefault(); };
    document.addEventListener("gesturestart", prevent, { passive:false });
    document.addEventListener("gesturechange", prevent, { passive:false });
    document.addEventListener("gestureend", prevent, { passive:false });
  })();

  var DATA = {};
  try{
    DATA = JSON.parse((document.getElementById("__OTM_DATA__").textContent || "{}"));
  }catch(err){
    showBootError(err);
    return;
  }

  var CENTER_ID = "__CENTER__";
  var BRANCH_COLORS = ["#f97316","#6366f1","#22c55e","#eab308","#0ea5e9","#f43f5e"];

  var R_CENTER = 75;
  var R_ROOT = 60;
  var R_CHILD = 50;
  var ROOT_RADIUS = 280;
  var RING = 130;

  var MIN_Z = 0.35;
  var MAX_Z = 4;

  var EXPORT_MIN_PADDING_PX = 18;
  var EXPORT_SHADOW_PAD_X = 36;
  var EXPORT_SHADOW_PAD_TOP = 24;
  var EXPORT_SHADOW_PAD_BOTTOM = 48;

  var MAXLEN_CENTER = 12;
  var MAXLEN_ROOT_AND_CHILD = 12;

  var worldEl = document.getElementById("world");
  var viewportEl = document.getElementById("viewport");
  var btnCenter = document.getElementById("btnCenter");
  var topbarEl = document.querySelector(".topbar");
  document.getElementById("tTitle").textContent = (DATA.projectTitle || "Project");

  var tasks = Array.isArray(DATA.tasks) ? DATA.tasks : [];
  var nodeOffset = DATA.nodeOffset || {};
  var branchColorOverride = DATA.branchColorOverride || {};
  var branchEdgeColorOverride = DATA.branchEdgeColorOverride || {};
  var edgeColorOverride = DATA.edgeColorOverride || {};

  // resolve portable attachment dataUrl (ref -> <script text/plain>)
  function resolveAttachmentDataUrl(att){
    if (!att) return "";
    if (att.ref){
      var el = document.getElementById(att.ref);
      return (el && el.textContent ? el.textContent.trim() : "");
    }
    return String(att.dataUrl || "");
  }

  // build maps
  var taskById = new Map(tasks.map(function(t){ return [t.id, t]; }));
  var childrenByParent = new Map();
  for (var i=0;i<tasks.length;i++){
    var t = tasks[i];
    if (!t || !t.parentId) continue;
    var arr = childrenByParent.get(t.parentId) || [];
    arr.push(t);
    childrenByParent.set(t.parentId, arr);
  }
  var roots = tasks.filter(function(t){ return t && t.parentId === null; });

  function getOffset(id){ return nodeOffset[id] || {x:0,y:0}; }
  function edgeKey(p,c){ return p + "__" + c; }

  function splitTitleLines(t, maxLen, maxLines){
    if (maxLines === void 0) maxLines = 3;
    var s = String(t || "").trim() || "Project";
    var hardParts = s.split(/\\r?\\n/);
    var lines = [];
    for (var hp=0; hp<hardParts.length; hp++){
      var part = hardParts[hp];
      while (part.length > 0 && lines.length < maxLines){
        if (part.length <= maxLen){ lines.push(part); part=""; break; }
        var breakAt = part.lastIndexOf(" ", maxLen);
        if (breakAt > 0){
          lines.push(part.slice(0, breakAt));
          part = part.slice(breakAt + 1);
        } else {
          var sliceLen = Math.max(1, maxLen - 1);
          lines.push(part.slice(0, sliceLen) + "-");
          part = part.slice(sliceLen);
        }
      }
      if (lines.length >= maxLines) break;
    }
    return lines.slice(0, maxLines);
  }

  function segmentBetweenCircles(c1x,c1y,r1,c2x,c2y,r2,overlap){
    if (overlap === void 0) overlap = 0;
    var dx = c2x - c1x;
    var dy = c2y - c1y;
    var len = Math.hypot(dx, dy) || 1;
    var ux = dx / len;
    var uy = dy / len;
    var x1 = c1x + ux * (r1 - overlap);
    var y1 = c1y + uy * (r1 - overlap);
    var x2 = c2x - ux * (r2 - overlap);
    var y2 = c2y - uy * (r2 - overlap);
    return { x1:x1,y1:y1,x2:x2,y2:y2 };
  }

  var doneCache = new Map();
  function effectiveDone(id){
    if (doneCache.has(id)) return doneCache.get(id);
    if (id === CENTER_ID){ doneCache.set(id, !!DATA.centerDone); return !!DATA.centerDone; }
    var cur = taskById.get(id);
    var chain = [];
    while (cur){
      chain.push(cur);
      cur = cur.parentId ? taskById.get(cur.parentId) : null;
    }
    var value = !!DATA.centerDone;
    for (var ci = chain.length - 1; ci >= 0; ci--){
      var tt = chain[ci];
      if (typeof tt.done === "boolean") value = tt.done;
    }
    doneCache.set(id, value);
    return value;
  }

  function getAttachments(id){
    if (id === CENTER_ID) return Array.isArray(DATA.centerAttachments) ? DATA.centerAttachments : [];
    var t = taskById.get(id);
    return (t && Array.isArray(t.attachments)) ? t.attachments : [];
  }

  var pos = {};
  pos[CENTER_ID] = { x: 0, y: 0 };
  var totalRoots = Math.max(roots.length, 1);

  function rec(parentId, px, py, gpx, gpy){
    var kids = childrenByParent.get(parentId) || [];
    if (!kids.length) return;

    var base = Math.atan2(py - gpy, px - gpx);
    var SPREAD = Math.min(Math.PI, Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6)));
    var step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
    var start = base - SPREAD / 2;

    for (var idx=0; idx<kids.length; idx++){
      var kid = kids[idx];
      var ang = start + idx * step;

      var cxBase = px + Math.cos(ang) * RING;
      var cyBase = py + Math.sin(ang) * RING;

      var ko = getOffset(kid.id);
      var cx = cxBase + ko.x;
      var cy = cyBase + ko.y;

      pos[kid.id] = { x: cx, y: cy };
      rec(kid.id, cx, cy, px, py);
    }
  }

  for (var r=0; r<roots.length; r++){
    var root = roots[r];
    var ang = (r / totalRoots) * Math.PI * 2;

    var rxBase = Math.cos(ang) * ROOT_RADIUS;
    var ryBase = Math.sin(ang) * ROOT_RADIUS;

    var ro = getOffset(root.id);
    var rx = rxBase + ro.x;
    var ry = ryBase + ro.y;

    pos[root.id] = { x: rx, y: ry };
    rec(root.id, rx, ry, 0, 0);
  }

  var rootIndex = new Map(roots.map(function(rr,i2){ return [rr.id, i2]; }));

  function rootBubbleColor(rootId){
    var idx = rootIndex.get(rootId) || 0;
    return branchColorOverride[rootId] || BRANCH_COLORS[idx % BRANCH_COLORS.length];
  }

  function bubbleColorFor(id){
    if (id === CENTER_ID) return DATA.centerColor || "#020617";
    var t = taskById.get(id);
    if (!t) return "#64748b";
    var cur = t;
    while (cur && cur.parentId) cur = taskById.get(cur.parentId);
    var rootId = cur ? cur.id : t.id;
    var base = rootBubbleColor(rootId);
    return (t.parentId ? (t.color || base) : base);
  }

  function edgeBaseColorForRoot(rootId){
    var base = rootBubbleColor(rootId);
    return branchEdgeColorOverride[rootId] || base;
  }

  var nodes = [];
  var edges = [];

  function pushNode(id, kind, rad){
    var p = pos[id];
    nodes.push({
      id: id,
      kind: kind,
      x: p.x,
      y: p.y,
      r: rad,
      bubbleColor: bubbleColorFor(id),
      title: (id === CENTER_ID) ? (DATA.projectTitle || "Project") : ((taskById.get(id) || {}).title || "Task"),
      done: effectiveDone(id)
    });
  }

  pushNode(CENTER_ID, "center", R_CENTER);

  for (var rr2=0; rr2<roots.length; rr2++){
    var root2 = roots[rr2];
    pushNode(root2.id, "root", R_ROOT);
    var c = pos[CENTER_ID];
    var rP = pos[root2.id];
    var seg = segmentBetweenCircles(c.x,c.y,R_CENTER,rP.x,rP.y,R_ROOT);
    edges.push({
      parentId: CENTER_ID,
      childId: root2.id,
      x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
      color: edgeBaseColorForRoot(root2.id)
    });
  }

  function addEdgesRec(parentId, rootId){
    var kids = childrenByParent.get(parentId) || [];
    if (!kids.length) return;
    for (var k=0; k<kids.length; k++){
      var kid = kids[k];
      pushNode(kid.id, "child", R_CHILD);

      var pP = pos[parentId];
      var cP = pos[kid.id];
      var pr = (parentId === CENTER_ID) ? R_CENTER : (((taskById.get(parentId) || {}).parentId === null) ? R_ROOT : R_CHILD);
      var seg2 = segmentBetweenCircles(pP.x,pP.y,pr,cP.x,cP.y,R_CHILD);

      var baseEdge = edgeBaseColorForRoot(rootId);
      var key = edgeKey(parentId, kid.id);
      var color = edgeColorOverride[key] || baseEdge;

      edges.push({ parentId: parentId, childId: kid.id, x1: seg2.x1, y1: seg2.y1, x2: seg2.x2, y2: seg2.y2, color: color });
      addEdgesRec(kid.id, rootId);
    }
  }

  for (var rr3=0; rr3<roots.length; rr3++){
    addEdgesRec(roots[rr3].id, roots[rr3].id);
  }

  var minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (var nn=0; nn<nodes.length; nn++){
    var n2 = nodes[nn];
    minX = Math.min(minX, n2.x - n2.r);
    maxX = Math.max(maxX, n2.x + n2.r);
    minY = Math.min(minY, n2.y - n2.r);
    maxY = Math.max(maxY, n2.y + n2.r);
  }
  minX -= (EXPORT_SHADOW_PAD_X + EXPORT_MIN_PADDING_PX);
  maxX += (EXPORT_SHADOW_PAD_X + EXPORT_MIN_PADDING_PX);
  minY -= (EXPORT_SHADOW_PAD_TOP + EXPORT_MIN_PADDING_PX);
  maxY += (EXPORT_SHADOW_PAD_BOTTOM + EXPORT_MIN_PADDING_PX);

  var width = Math.max(1, Math.ceil(maxX - minX));
  var height = Math.max(1, Math.ceil(maxY - minY));
  var originX = -minX;
  var originY = -minY;

  var stage = document.createElement("div");
  stage.className = "map-stage";
  stage.style.width = width + "px";
  stage.style.height = height + "px";

  var svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("class","edges");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  for (var ee=0; ee<edges.length; ee++){
    var e2 = edges[ee];
    var line = document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1", String(originX + e2.x1));
    line.setAttribute("y1", String(originY + e2.y1));
    line.setAttribute("x2", String(originX + e2.x2));
    line.setAttribute("y2", String(originY + e2.y2));
    line.setAttribute("stroke", e2.color);
    line.setAttribute("stroke-width","3");
    line.setAttribute("stroke-linecap","round");
    svg.appendChild(line);
  }
  stage.appendChild(svg);

  var suppressClickUntil = 0;
  function suppressClick(){ suppressClickUntil = Date.now() + 250; }

  for (var ni=0; ni<nodes.length; ni++){
    var n3 = nodes[ni];
    var el = document.createElement("div");
    el.className = "node";
    el.style.left = (originX + n3.x) + "px";
    el.style.top = (originY + n3.y) + "px";
    el.style.width = (n3.r*2) + "px";
    el.style.height = (n3.r*2) + "px";
    el.style.background = n3.bubbleColor;
    el.dataset.id = n3.id;
    el.dataset.done = n3.done ? "true" : "false";

    var text = document.createElement("div");
    text.className = "text";
    var maxLen = (n3.kind === "center") ? MAXLEN_CENTER : MAXLEN_ROOT_AND_CHILD;
    var lines = splitTitleLines(n3.title, maxLen, 3);
    for (var li=0; li<lines.length; li++){
      var sp = document.createElement("span");
      sp.textContent = lines[li];
      text.appendChild(sp);
    }
    el.appendChild(text);

    if (n3.done){
      var badge = document.createElement("div");
      badge.className = "badge done";
      var s = document.createElement("span");
      s.textContent = "✓";
      badge.appendChild(s);
      el.appendChild(badge);
    }

    el.addEventListener("click", (function(id){
      return function(ev){
        ev.stopPropagation();
        if (Date.now() < suppressClickUntil) return;
        openFilesForNode(id);
      };
    })(n3.id));

    stage.appendChild(el);
  }

  worldEl.innerHTML = "";
  worldEl.appendChild(stage);

  var panX = 0, panY = 0, z = 1;
  function clampZ(v){ return Math.max(MIN_Z, Math.min(MAX_Z, v)); }
  function applyTransform(){
    worldEl.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + z + ")";
  }

  function centerView(){
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var tb = topbarEl ? topbarEl.getBoundingClientRect() : { bottom: 74 };
    var topbarBottom = tb.bottom + 10;
    var usableH = Math.max(1, vh - topbarBottom - 14);

    z = clampZ(Math.min(1, Math.min((vw*0.90)/width, (usableH*0.92)/height)));
    panX = (vw/2) - (width*z)/2;
    panY = (topbarBottom + (usableH/2)) - (height*z)/2;

    applyTransform();
  }

  btnCenter.addEventListener("click", centerView);
  window.addEventListener("resize", centerView);
  viewportEl.addEventListener("contextmenu", function(e){ e.preventDefault(); });

  var pointers = new Map();
  var panStart = null;
  var pinchStart = null;

  function isOnNode(e){
    return !!(e.target && e.target.closest && e.target.closest(".node"));
  }

  function startPinchIfPossible(){
    if (pointers.size !== 2) return;
    var ids = Array.from(pointers.keys());
    var p1 = pointers.get(ids[0]);
    var p2 = pointers.get(ids[1]);
    var midX = (p1.x + p2.x) / 2;
    var midY = (p1.y + p2.y) / 2;
    var dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;

    try { viewportEl.setPointerCapture && viewportEl.setPointerCapture(ids[0]); } catch {}
    try { viewportEl.setPointerCapture && viewportEl.setPointerCapture(ids[1]); } catch {}

    pinchStart = {
      dist: dist,
      z0: z,
      worldX: (midX - panX) / z,
      worldY: (midY - panY) / z,
    };
    panStart = null;
  }

  viewportEl.addEventListener("pointerdown", function(e){
    var overlayOpen = document.getElementById("overlay").classList.contains("open");
    if (overlayOpen) return;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2){ startPinchIfPossible(); return; }

    if (!isOnNode(e)){
      try { viewportEl.setPointerCapture && viewportEl.setPointerCapture(e.pointerId); } catch {}
      panStart = { id: e.pointerId, x: e.clientX, y: e.clientY, panX0: panX, panY0: panY };
    } else {
      panStart = null;
    }
  });

  viewportEl.addEventListener("pointermove", function(e){
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    var overlayOpen = document.getElementById("overlay").classList.contains("open");
    if (overlayOpen) return;

    if (pinchStart && pointers.size >= 2){
      var ids = Array.from(pointers.keys()).slice(0, 2);
      var p1 = pointers.get(ids[0]);
      var p2 = pointers.get(ids[1]);
      var midX = (p1.x + p2.x) / 2;
      var midY = (p1.y + p2.y) / 2;
      var dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;

      var scale = dist / (pinchStart.dist || 1);
      z = clampZ(pinchStart.z0 * scale);

      panX = midX - pinchStart.worldX * z;
      panY = midY - pinchStart.worldY * z;

      suppressClick();
      applyTransform();
      return;
    }

    if (panStart && panStart.id === e.pointerId){
      var dx = e.clientX - panStart.x;
      var dy = e.clientY - panStart.y;
      if (Math.hypot(dx, dy) > 3) suppressClick();
      panX = panStart.panX0 + dx;
      panY = panStart.panY0 + dy;
      applyTransform();
    }
  });

  function endPointer(e){
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    try { viewportEl.releasePointerCapture && viewportEl.releasePointerCapture(e.pointerId); } catch {}

    if (pointers.size < 2) pinchStart = null;

    if (pointers.size === 1){
      var it = pointers.entries().next().value;
      if (it){
        var id = it[0], p = it[1];
        panStart = { id: id, x: p.x, y: p.y, panX0: panX, panY0: panY };
      }
    } else {
      panStart = null;
    }
  }

  viewportEl.addEventListener("pointerup", endPointer);
  viewportEl.addEventListener("pointercancel", endPointer);

  viewportEl.addEventListener("wheel", function(e){
    e.preventDefault();

    var overlayOpen = document.getElementById("overlay").classList.contains("open");
    if (overlayOpen) return;

    var rect = viewportEl.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;

    var factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    var next = clampZ(z * factor);

    var wx = (cx - panX) / z;
    var wy = (cy - panY) / z;

    z = next;
    panX = cx - wx * z;
    panY = cy - wy * z;

    suppressClick();
    applyTransform();
  }, { passive:false });

  // ===== PDF Overlay =====
  var overlay = document.getElementById("overlay");
  var btnClose = document.getElementById("btnClose");
  var fileList = document.getElementById("fileList");
  var modalTitle = document.getElementById("modalTitle");
  var modalEl = document.getElementById("modal");

  var pdfInfo = document.getElementById("pdfInfo");
  var pdfOpen = document.getElementById("pdfOpen");
  var pdfDownload = document.getElementById("pdfDownload");
  var pdfFrame = document.getElementById("pdfFrame");

  var pdfMsg = document.getElementById("pdfMsg");
  var pdfMsgText = document.getElementById("pdfMsgText");
  var pdfMsgOpen = document.getElementById("pdfMsgOpen");
  var pdfMsgSave = document.getElementById("pdfMsgSave");

  var currentPdfUrl = "";
  var currentObjectUrl = "";
  var currentPdfBlob = null;
  var currentPdfName = "attachment.pdf";

  function revokeObjectUrl(){
    if (currentObjectUrl){
      try{ URL.revokeObjectURL(currentObjectUrl); }catch{}
      currentObjectUrl = "";
    }
  }

  function showPdfCard(text){
    if (pdfMsgText) pdfMsgText.textContent = text || "";
    if (pdfMsg) pdfMsg.style.display = "flex";
  }
  function hidePdfCard(){
    if (pdfMsg) pdfMsg.style.display = "none";
  }

  function dataUrlToBytes(dataUrl){
    var s = String(dataUrl || "");
    if (!s.startsWith("data:")) return null;
    var comma = s.indexOf(",");
    if (comma < 0) return null;
    var meta = s.slice(0, comma);
    var b64 = s.slice(comma + 1);
    if (!/;base64/i.test(meta)) return null;

    try{
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }catch(err){
      console.error("[OTM] base64 decode failed", err);
      return null;
    }
  }

  function setPdfSrc(url, isObject){
    revokeObjectUrl();
    currentPdfUrl = url || "";
    currentPdfBlob = null;

    if (isObject) currentObjectUrl = url || "";
    pdfFrame.src = "about:blank";

    // iOS inline PDF ist oft unreliable → immer card anzeigen
    showPdfCard(IS_IOS ? "PDF ready. Tap Open (iOS does not always show PDFs inline)." : "Loading PDF…");

    setTimeout(function(){
      pdfFrame.src = currentPdfUrl || "about:blank";
    }, 0);
  }

  pdfFrame.addEventListener("load", function(){
    if (!currentPdfUrl || currentPdfUrl === "about:blank") return;
    // Nicht auf iOS autohide – dort ist load oft "fake-success" bei leeren PDFs im iframe
    if (!IS_IOS) hidePdfCard();
  });

  function doOpen(){
    if (!currentPdfUrl) return;
    window.open(currentPdfUrl, "_blank", "noopener,noreferrer");
  }

  async function doSaveOrDownload(){
    if (!currentPdfUrl) return;

    // Wenn wir Blob haben (data:), können wir share/save sauber machen
    if (currentPdfBlob){
      try{
        var file = new File([currentPdfBlob], currentPdfName || "attachment.pdf", { type: "application/pdf" });
        if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))){
          await navigator.share({ files: [file], title: currentPdfName || "PDF" });
          return;
        }
      }catch{}
    }

    // iOS fallback: Open (User speichert dann im PDF-Viewer via Share)
    if (IS_IOS){
      doOpen();
      return;
    }

    // klassischer download
    var a = document.createElement("a");
    a.href = currentPdfUrl;
    a.download = currentPdfName || "attachment.pdf";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    try{ a.click(); }catch{}
    a.remove();
  }

  pdfOpen.addEventListener("click", doOpen);
  pdfDownload.addEventListener("click", doSaveOrDownload);
  pdfMsgOpen.addEventListener("click", doOpen);
  pdfMsgSave.addEventListener("click", doSaveOrDownload);

  // Button-Text auf iOS anpassen
  if (IS_IOS){
    pdfDownload.textContent = "Save";
  }

  async function openPdf(att){
    revokeObjectUrl();
    currentPdfUrl = "";
    currentPdfBlob = null;

    var resolved = resolveAttachmentDataUrl(att);
    var name = String((att && att.name) || "attachment.pdf");
    currentPdfName = name;

    if (!resolved){
      pdfInfo.textContent = "PDF";
      showPdfCard("No PDF data.");
      pdfFrame.src = "about:blank";
      return;
    }

    if (resolved.startsWith("blob:")){
      pdfInfo.textContent = name;
      showPdfCard("This PDF was stored as a blob URL and is not portable. Please re-attach so it becomes a data URL.");
      pdfFrame.src = "about:blank";
      currentPdfUrl = "";
      return;
    }

    pdfInfo.textContent = name;

    // data: → Blob URL (stabiler als data: direkt)
    if (resolved.startsWith("data:")){
      var bytes = dataUrlToBytes(resolved);
      if (!bytes){
        showPdfCard("Could not decode PDF data.");
        pdfFrame.src = "about:blank";
        return;
      }
      var blob = new Blob([bytes], { type: "application/pdf" });
      currentPdfBlob = blob;
      var url = URL.createObjectURL(blob);
      setPdfSrc(url, true);
      return;
    }

    // URL (online) – iframe kann blockiert sein → zeig card + Open
    currentPdfUrl = resolved;
    pdfFrame.src = "about:blank";
    showPdfCard("This PDF is an external link. If it does not appear inline, tap Open.");
    setTimeout(function(){ pdfFrame.src = currentPdfUrl; }, 0);
  }

  function closeOverlay(){
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden","true");
    fileList.innerHTML = "";
    modalEl.classList.remove("one");
    revokeObjectUrl();
    currentPdfUrl = "";
    currentPdfBlob = null;
    pdfFrame.src = "about:blank";
    showPdfCard("Select a PDF.");
  }

  btnClose.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", function(e){ if (e.target === overlay) closeOverlay(); });
  window.addEventListener("keydown", function(e){ if (e.key === "Escape") closeOverlay(); });

  function openFilesForNode(nodeId){
    var atts = (getAttachments(nodeId) || []).filter(function(a){
      var du = resolveAttachmentDataUrl(a);
      return !!du;
    });

    if (!atts || atts.length === 0) return;

    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden","false");

    var title = (nodeId === CENTER_ID) ? (DATA.projectTitle || "Project") : (((taskById.get(nodeId) || {}).title) || "Task");
    modalTitle.textContent = title;

    if (atts.length === 1) modalEl.classList.add("one");
    else modalEl.classList.remove("one");

    fileList.innerHTML = "";

    if (atts.length === 1){
      fileList.innerHTML = '<div style="padding:10px; color: rgba(255,255,255,0.72); font-size:12px;">1 PDF attached.</div>';
      openPdf(atts[0]);
      return;
    }

    var info = document.createElement("div");
    info.style.padding = "10px";
    info.style.color = "rgba(255,255,255,0.72)";
    info.style.fontSize = "12px";
    info.textContent = atts.length + " PDFs attached:";
    fileList.appendChild(info);

    for (var i=0;i<atts.length;i++){
      (function(att){
        var b = document.createElement("button");
        b.className = "fileItem";
        b.textContent = att.name || "attachment.pdf";
        b.addEventListener("click", function(){ openPdf(att); });
        fileList.appendChild(b);
      })(atts[i]);
    }

    openPdf(atts[0]);
  }

  // hide boot once JS is alive + centered
  try{
    centerView();
    if (boot) boot.style.display = "none";
  }catch(err){
    showBootError(err);
  }

})();
</script>
</body>
</html>`;

  const filenameBase = slugifyTitle(data.projectTitle) || "taskmap";
  const filename = `${filenameBase}.taskmap.html`;
  downloadBlob(filename, new Blob([html], { type: "text/html;charset=utf-8" }));
}
