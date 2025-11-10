import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/* ---------- Types ---------- */
type Task = {
  id: string;
  title: string;
  parentId: string | null;
};

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

/* ----- SAVE/LOAD: Types & helpers ----- */
type SavedState = {
  v: 1;
  projectTitle: string;
  tasks: Task[];
  nodeOffset: Record<string, { x: number; y: number }>;
  pan: { x: number; y: number };
  scale: number;
  ts: number;
  /** pro Root-Task eine Farbüberschreibung */
  branchColorOverride?: Record<string, string>;
  /** Farbe des zentralen Projekt-Knotens */
  centerColor?: string;
};

function serializeState(
  projectTitle: string,
  tasks: Task[],
  nodeOffset: Record<string, { x: number; y: number }>,
  pan: { x: number; y: number },
  scale: number,
  branchColorOverride: Record<string, string>,
  centerColor: string
): SavedState {
  return {
    v: 1,
    projectTitle,
    tasks,
    nodeOffset,
    pan,
    scale,
    ts: Date.now(),
    branchColorOverride,
    centerColor
  };
}

function slugifyTitle(t: string) {
  return t
    .trim()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();
}

function buildFileName(projectTitle: string) {
  const base = slugifyTitle(projectTitle) || "taskmap";
  return `${base}.taskmap.json`;
}
function buildImageFileName(projectTitle: string, ext: "jpg" | "pdf") {
  const base = slugifyTitle(projectTitle) || "taskmap";
  return `${base}.${ext}`;
}

function downloadJSON(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Colors for root branches (inherited by descendants) */
const BRANCH_COLORS = ["#f97316", "#6366f1", "#22c55e", "#eab308", "#0ea5e9", "#f43f5e"];

/* Zusatz-Palette fürs Kontextmenü (angenehme UI-Farben) */
const COLOR_SWATCHES = [
  "#f97316", "#fb923c", "#f59e0b", "#eab308",
  "#22c55e", "#10b981", "#14b8a6", "#06b6d4",
  "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6",
  "#a855f7", "#ef4444", "#f43f5e", "#ec4899",
  "#94a3b8", "#64748b", "#111827", "#020617"
];

/* Node radii */
const R_CENTER = 75;
const R_ROOT   = 60;
const R_CHILD  = 50;

/* Layout distances */
const ROOT_RADIUS = 280;
const RING        = 130;

/* ---------- Geometry helpers ---------- */
function segmentBetweenCircles(
  c1x: number, c1y: number, r1: number,
  c2x: number, c2y: number, r2: number,
  overlap = 0
) {
  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = c1x + ux * (r1 - overlap);
  const y1 = c1y + uy * (r1 - overlap);
  const x2 = c2x - ux * (r2 - overlap);
  const y2 = c2y - uy * (r2 - overlap);
  return { x1, y1, x2, y2 };
}

function isDescendant(tasks: Task[], possibleDescendant: string, possibleAncestor: string) {
  let cur = tasks.find(t => t.id === possibleDescendant);
  while (cur && cur.parentId) {
    if (cur.parentId === possibleAncestor) return true;
    cur = tasks.find(t => t.id === cur!.parentId);
  }
  return false;
}

/* ---------- App ---------- */
export default function App() {
  const [projectTitle, setProjectTitle] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<"edit" | "map">("edit");

  /* Panning (Visualize) */
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panning = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  /* Zoom (Mausrad/Pinch) */
  const [scale, setScale] = useState(1);
  const MIN_Z = 0.35;
  const MAX_Z = 4;
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const roots = useMemo(() => tasks.filter(t => t.parentId === null), [tasks]);
  const childrenOf = (id: string) => tasks.filter(t => t.parentId === id);

  const addTask = () => {
    const n = tasks.length + 1;
    setTasks(prev => [...prev, { id: "t-" + makeId(), title: "Task " + n, parentId: null }]);
  };
  const renameTask = (id: string, title: string) => {
    setTasks(prev => prev.map(t => (t.id === id ? { ...t, title } : t)));
  };

  /* ---- Remove Task ---- */
  function collectSubtreeIds(list: Task[], rootId: string): Set<string> {
    const out = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const t of list) {
        if (t.parentId === cur && !out.has(t.id)) {
          out.add(t.id);
          queue.push(t.id);
        }
      }
    }
    return out;
  }
  const removeLastTask = () => {
    if (tasks.length === 0) return;
    const lastTask = tasks[tasks.length - 1];
    const toRemove = collectSubtreeIds(tasks, lastTask.id);
    setTasks(prev => prev.filter(t => !toRemove.has(t.id)));
  };

  /* ---------- Edit: Pointer-DnD ---------- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);

  // Gesten-Vorbereitung
  const editGesture = useRef<{
    pointerId: number;
    rowEl: HTMLElement;
    startX: number;
    startY: number;
    started: boolean;
    taskId: string;
  } | null>(null);
  const DRAG_THRESHOLD = 8;
  const LONGPRESS_MS = 300;

  function startDrag(id: string) {
    draggingRef.current = id;
    setDraggingId(id);
    setHoverId(null);
    document.documentElement.classList.add("dragging-global");
  }
  function finishDrag() {
    draggingRef.current = null;
    setDraggingId(null);
    setHoverId(null);
    document.documentElement.classList.remove("dragging-global");
  }
  function dropOn(targetId: string) {
    const src = draggingRef.current;
    if (!src || src === targetId) { finishDrag(); return; }
    setTasks(prev => {
      if (isDescendant(prev, targetId, src)) return prev;
      return prev.map(t => (t.id === src ? { ...t, parentId: targetId } : t));
    });
    finishDrag();
  }
  function dropToRoot() {
    const src = draggingRef.current;
    if (!src) { finishDrag(); return; }
    setTasks(prev => prev.map(t => (t.id === src ? { ...t, parentId: null } : t)));
    finishDrag();
  }

  useEffect(() => {
    function onPointerUp(e: PointerEvent) {
      if (editGesture.current && e.pointerId === editGesture.current.pointerId && !editGesture.current.started) {
        editGesture.current = null;
      }
      if (!draggingRef.current) return;
      if (hoverId) dropOn(hoverId);
      else dropToRoot();
    }
    function onPointerCancel(e: PointerEvent) {
      if (editGesture.current && e.pointerId === editGesture.current.pointerId) {
        editGesture.current = null;
      }
      if (draggingRef.current) finishDrag();
    }
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [hoverId]);

  useEffect(() => {
    const onDocPointerMoveEdit = (e: PointerEvent) => {
      if (view !== "edit") return;

      if (editGesture.current && e.pointerId === editGesture.current.pointerId && !editGesture.current.started) {
        const dx = e.clientX - editGesture.current.startX;
        const dy = e.clientY - editGesture.current.startY;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          editGesture.current.rowEl.setPointerCapture?.(editGesture.current.pointerId);
          e.preventDefault();
          startDrag(editGesture.current.taskId);
          editGesture.current.started = true;
        }
      }

      if (!draggingRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el) { setHoverId(null); return; }
      const row = el.closest?.(".task-row") as HTMLElement | null;
      const targetId = row?.dataset?.taskId || null;
      setHoverId(targetId);
    };

    window.addEventListener("pointermove", onDocPointerMoveEdit, { passive: true });
    return () => window.removeEventListener("pointermove", onDocPointerMoveEdit);
  }, [view]);

  /* ---------- Visualize: Node-Drag ---------- */
  const [nodeOffset, setNodeOffset] = useState<Record<string, { x: number; y: number }>>({});
  const getOffset = (id: string) => nodeOffset[id] || { x: 0, y: 0 };
  const setOffset = (id: string, x: number, y: number) =>
    setNodeOffset(prev => ({ ...prev, [id]: { x, y } }));

  const vDrag = useRef<{ id: string; startClient: { x: number; y: number }; startOffset: { x: number; y: number } } | null>(null);
  const nodeDragging = useRef(false);

  function startNodeDrag(id: string, e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    vDrag.current = { id, startClient: { x: e.clientX, y: e.clientY }, startOffset: getOffset(id) };
    nodeDragging.current = true;
    document.documentElement.classList.add("dragging-global");
  }
  function onNodePointerMove(e: PointerEvent) {
    const d = vDrag.current;
    if (!d) return;
    const dx = e.clientX - d.startClient.x;
    const dy = e.clientY - d.startClient.y;
    setOffset(d.id, d.startOffset.x + dx, d.startOffset.y + dy);
  }
  function onNodePointerUp() {
    if (!vDrag.current) return;
    vDrag.current = null;
    nodeDragging.current = false;
    document.documentElement.classList.remove("dragging-global");
  }
  useEffect(() => {
    window.addEventListener("pointermove", onNodePointerMove);
    window.addEventListener("pointerup", onNodePointerUp);
    window.addEventListener("pointercancel", onNodePointerUp);
    return () => {
      window.removeEventListener("pointermove", onNodePointerMove);
      window.removeEventListener("pointerup", onNodePointerUp);
      window.removeEventListener("pointercancel", onNodePointerUp);
    };
  }, []);

  /* View toggle */
  const openMap = () => {
    if (!projectTitle.trim()) { alert("Please enter a project title first."); return; }
    setView("map");
  };

  /* ---------- Map: Pan/Pinch ---------- */
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinching = useRef(false);
  const pinchStart = useRef<{ dist: number; cx: number; cy: number; startScale: number } | null>(null);

  function distance(a:{x:number;y:number}, b:{x:number;y:number}) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }
  function midpoint(a:{x:number;y:number}, b:{x:number;y:number}) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  const onPointerDownMap = (e: React.PointerEvent) => {
    if (nodeDragging.current) return;
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.current.size === 2) {
      const [p1, p2] = Array.from(activePointers.current.values());
      const dist = distance(p1, p2);
      const m = midpoint(p1, p2);
      pinching.current = true;
      pinchStart.current = { dist, cx: m.x, cy: m.y, startScale: scale };
      panning.current = false;
    } else if (activePointers.current.size === 1) {
      panning.current = true;
      last.current = { x: e.clientX, y: e.clientY };
    }

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMoveMap = (e: React.PointerEvent) => {
    const pt = activePointers.current.get(e.pointerId);
    if (pt) activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinching.current && activePointers.current.size >= 2 && view === "map") {
      const [p1, p2] = Array.from(activePointers.current.values());
      const distNow = distance(p1, p2);
      const m = midpoint(p1, p2);
      const start = pinchStart.current!;
      if (!start) return;
      const raw = start.startScale * (distNow / (start.dist || 1));
      const next = Math.min(MAX_Z, Math.max(MIN_Z, raw));
      zoomAt(m.x, m.y, next);
      e.preventDefault();
      return;
    }

    if (panning.current && view === "map") {
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      e.preventDefault();
    }
  };

  const onPointerUpMap = (e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) {
      pinching.current = false;
      pinchStart.current = null;
    }
    if (activePointers.current.size === 0) {
      panning.current = false;
    }
  };

  function zoomAt(clientX: number, clientY: number, nextScale: number) {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) { setScale(nextScale); return; }
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const wx = (cx - pan.x) / scale;
    const wy = (cy - pan.y) / scale;
    const newPanX = cx - wx * nextScale;
    const newPanY = cy - wy * nextScale;
    setScale(nextScale);
    setPan({ x: newPanX, y: newPanY });
  }

  const onWheel = (e: React.WheelEvent) => {
    if (view !== "map") return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const target = Math.min(MAX_Z, Math.max(MIN_Z, scale * factor));
    zoomAt(e.clientX, e.clientY, target);
  };

  /* Safari-Pinch Fallback */
  useEffect(() => {
    const onGestureChange = (ev: any) => {
      if (view !== "map") return;
      ev.preventDefault();
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const factor = ev.scale > 1 ? 1.12 : 1 / 1.12;
      const next = Math.min(MAX_Z, Math.max(MIN_Z, scale * factor));
      zoomAt(cx, cy, next);
    };
    window.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => window.removeEventListener("gesturechange", onGestureChange);
  }, [scale, view, pan]);

  /* ---------- Website-Zoom blocken ---------- */
  useEffect(() => {
    const onGlobalWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      const path = (ev.composedPath && ev.composedPath()) || [];
      const insideMap = path.some((el) => (el as HTMLElement)?.classList?.contains?.("skillmap-wrapper"));
      if (!insideMap) ev.preventDefault();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "+" || ev.key === "-" || ev.key === "0" || ev.key === "=")) {
        ev.preventDefault();
      }
    };
    window.addEventListener("wheel", onGlobalWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onGlobalWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const resetView = () => { setScale(1); setPan({ x: 0, y: 0 }); };

  /* Save dropdown */
  const [saveOpen, setSaveOpen] = useState(false);
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);
  const [savePos, setSavePos] = useState<{ top: number; left: number } | null>(null);

  const openSaveMenu = () => {
    const btn = saveBtnRef.current;
    if (!btn) { setSaveOpen(v => !v); return; }
    const r = btn.getBoundingClientRect();
    setSavePos({ top: r.bottom + 6, left: r.right });
    setSaveOpen(true);
  };
  const toggleSaveMenu = () => {
    setSaveOpen(prev => {
      if (prev) return false;
      openSaveMenu();
      return true;
    });
  };

  /* File System Access handle */
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);

  const [branchColorOverride, setBranchColorOverride] = useState<Record<string, string>>({});
  const [centerColor, setCenterColor] = useState<string>("#020617");

  const doSave   = async () => {
    setSaveOpen(false);
    const state = serializeState(projectTitle, tasks, nodeOffset, pan, scale, branchColorOverride, centerColor);

    try {
      if (fileHandle && "createWritable" in fileHandle) {
        const writable = await (fileHandle as any).createWritable();
        await writable.write(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
        await writable.close();
        return;
      }
    } catch (err) {
      console.warn("File handle save failed, falling back to download", err);
    }

    downloadJSON(buildFileName(projectTitle), state);
  };

  const doSaveAs = async () => {
    setSaveOpen(false);
    const state = serializeState(projectTitle, tasks, nodeOffset, pan, scale, branchColorOverride, centerColor);
    const supportsPicker = "showSaveFilePicker" in window;

    if (supportsPicker) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          id: "taskmap-saveas",
          suggestedName: buildFileName(projectTitle),
          startIn: "downloads",
          types: [{ description: "TaskMap Project", accept: { "application/json": [".taskmap.json"] } }],
        });
        setFileHandle(handle);
        const writable = await handle.createWritable();
        await writable.write(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
        await writable.close();
        return;
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        console.warn("showSaveFilePicker failed, falling back to download", e);
      }
    }

    downloadJSON(buildFileName(projectTitle), state);
    setFileHandle(null);
  };

  /* ---------- OPEN ---------- */
  function loadFromJSON(data: any) {
    try {
      const obj = data as Partial<SavedState>;
      if (!obj || typeof obj !== "object") throw new Error("Invalid file");
      if (!Array.isArray(obj.tasks)) throw new Error("Missing tasks");
      setProjectTitle(String(obj.projectTitle ?? "Project"));
      setTasks(obj.tasks as Task[]);
      setPan(obj.pan ?? { x: 0, y: 0 });
      setScale(typeof obj.scale === "number" ? obj.scale : 1);
      setNodeOffset(obj.nodeOffset ?? {});
      setBranchColorOverride(obj.branchColorOverride ?? {});
      setCenterColor(obj.centerColor ?? "#020617");
      setView("map");
    } catch (err) {
      alert("Could not open file. Is this a valid .taskmap.json?");
      console.error(err);
    }
  }

  const doOpen = async () => {
    try {
      if ("showOpenFilePicker" in window) {
        const [handle] = await (window as any).showOpenFilePicker({
          id: "taskmap-open",
          startIn: "downloads",
          multiple: false,
          types: [{ description: "TaskMap Project", accept: { "application/json": [".taskmap.json", ".json"] } }],
          excludeAcceptAllOption: true,
        });
        const file = await handle.getFile();
        const text = await file.text();
        const json = JSON.parse(text);
        loadFromJSON(json);
        setFileHandle(handle as FileSystemFileHandle);
        return;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      console.warn("showOpenFilePicker failed, falling back to input[type=file]", e);
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".taskmap.json,application/json";
    input.onchange = (ev: any) => {
      const f = ev.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          loadFromJSON(JSON.parse(String(reader.result)));
        } catch (err) {
          alert("Could not open file. Is this a valid .taskmap.json?");
          console.error(err);
        }
      };
      reader.readAsText(f);
    };
    input.click();
  };

  /* ---------- DOWNLOAD: Dropdown + Export (SVG-basiert, unabh. vom Zoom) ---------- */
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadBtnRef = useRef<HTMLButtonElement | null>(null);
  const [downloadPos, setDownloadPos] = useState<{ top: number; left: number } | null>(null);

  const openDownloadMenu = () => {
    const btn = downloadBtnRef.current;
    if (!btn) { setDownloadOpen(v => !v); return; }
    const r = btn.getBoundingClientRect();
    setDownloadPos({ top: r.bottom + 6, left: r.right });
    setDownloadOpen(true);
  };
  const toggleDownloadMenu = () => {
    setDownloadOpen(prev => {
      if (prev) return false;
      openDownloadMenu();
      return true;
    });
  };

  /* ----- Layout für Export unabhängig vom UI-Zustand ----- */

  const getChildren = (id: string) => tasks.filter(t => t.parentId === id);

  type NodeGeom = { id: string; title: string; x: number; y: number; r: number; color: string; fontSize: number; };
  type EdgeGeom = { x1: number; y1: number; x2: number; y2: number; color: string; };

  // Root-Helper (für Menü & Farbe)
  const getRootId = (id: string): string => {
    let cur = tasks.find(t => t.id === id);
    if (!cur) return id;
    while (cur && cur.parentId) {
      cur = tasks.find(t => t.id === cur!.parentId);
    }
    return cur?.id ?? id;
  };
  const colorForRoot = (rootId: string): string => {
    const idx = roots.findIndex(r => r.id === rootId);
    const base = BRANCH_COLORS[idx >= 0 ? idx % BRANCH_COLORS.length : 0];
    return branchColorOverride[rootId] ?? base;
  };

  function computeExportLayout(): { nodes: NodeGeom[]; edges: EdgeGeom[]; bbox: {minX:number;minY:number;maxX:number;maxY:number} } {
    const nodes: NodeGeom[] = [];
    const edges: EdgeGeom[] = [];

    // Center node (mit frei wählbarer Farbe)
    nodes.push({ id: "CENTER", title: projectTitle || "Project", x: 0, y: 0, r: R_CENTER, color: centerColor, fontSize: 20 });

    const rootsList = tasks.filter(t => t.parentId === null);
    const total = Math.max(rootsList.length, 1);

    const getOff = (id: string) => nodeOffset[id] || { x: 0, y: 0 };

    // Helper: recurse children
    function placeChildren(parentId: string, px: number, py: number, pr: number, color: string, gpx: number, gpy: number) {
      const kids = getChildren(parentId);
      if (kids.length === 0) return;

      const base = Math.atan2(py - gpy, px - gpx);
      const SPREAD = Math.min(Math.PI, Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6)));
      const step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
      const start = base - SPREAD / 2;

      kids.forEach((kid, idx) => {
        const ang = start + idx * step;
        const ko = getOff(kid.id);
        const cx = px + Math.cos(ang) * RING + ko.x;
        const cy = py + Math.sin(ang) * RING + ko.y;

        // Edge
        const seg = segmentBetweenCircles(px, py, pr, cx, cy, R_CHILD);
        edges.push({ x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, color });

        // Node
        nodes.push({ id: kid.id, title: kid.title, x: cx, y: cy, r: R_CHILD, color, fontSize: 16 });

        placeChildren(kid.id, cx, cy, R_CHILD, color, px, py);
      });
    }

    rootsList.forEach((root, i) => {
      const ang = (i / total) * Math.PI * 2;
      const ro = getOff(root.id);
      const rx = Math.cos(ang) * ROOT_RADIUS + ro.x;
      const ry = Math.sin(ang) * ROOT_RADIUS + ro.y;
      const color = branchColorOverride?.[root.id] ?? BRANCH_COLORS[i % BRANCH_COLORS.length];

      // Edge center -> root
      const seg = segmentBetweenCircles(0, 0, R_CENTER, rx, ry, R_ROOT);
      edges.push({ x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, color });

      // Root node
      nodes.push({ id: root.id, title: root.title, x: rx, y: ry, r: R_ROOT, color, fontSize: 18 });

      // Children of root
      placeChildren(root.id, rx, ry, R_ROOT, color, 0, 0);
    });

    // Bounding box (inkl. Kreise)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    for (const e of edges) {
      minX = Math.min(minX, e.x1, e.x2);
      minY = Math.min(minY, e.y1, e.y2);
      maxX = Math.max(maxX, e.x1, e.x2);
      maxY = Math.max(maxY, e.y1, e.y2);
    }

    const PAD = 140;
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;

    return { nodes, edges, bbox: {minX, minY, maxX, maxY} };
  }

  function esc(s: string) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function splitTitleLines(t: string, maxLen: number): string[] {
    const s = (t || "").trim();
    if (!s) return ["Project"];
    if (s.length <= maxLen) return [s];
    const words = s.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > maxLen) {
        if (cur) lines.push(cur);
        cur = w;
      } else {
        cur = (cur ? cur + " " : "") + w;
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }

  function buildSVGForExport(): { svg: string; width: number; height: number } {
    const { nodes, edges, bbox } = computeExportLayout();
    const width = Math.ceil(bbox.maxX - bbox.minX);
    const height = Math.ceil(bbox.maxY - bbox.minY);

    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bbox.minX} ${bbox.minY} ${width} ${height}">`,
      `<defs><style>
        .lbl{font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-weight:700; fill:#fff; text-anchor:middle; dominant-baseline:middle;}
      </style></defs>`,
      `<rect x="${bbox.minX}" y="${bbox.minY}" width="${width}" height="${height}" fill="#ffffff"/>`
    );

    for (const e of edges) {
      parts.push(`<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${e.color}" stroke-width="6" stroke-linecap="round"/>`);
    }

    for (const n of nodes) {
      parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${n.color}" />`);
      const maxLen = n.id === "CENTER" ? 18 : (n.r === R_ROOT ? 14 : 12);
      const fs = n.fontSize;
      const lines = splitTitleLines(n.title, maxLen);
      const total = lines.length;
      lines.forEach((ln, idx) => {
        const dy = (idx - (total-1)/2) * (fs * 1.1);
        parts.push(`<text class="lbl" x="${n.x}" y="${n.y + dy}" font-size="${fs}">${esc(ln)}</text>`);
      });
    }

    parts.push(`</svg>`);
    return { svg: parts.join(""), width, height };
  }

  async function svgToCanvas(svg: string, width: number, height: number, scale = 2): Promise<HTMLCanvasElement> {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = "sync";
      const loaded = new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("SVG image load failed"));
      });
      img.src = url;
      await loaded;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function doDownloadJPG() {
    try {
      setDownloadOpen(false);
      const { svg, width, height } = buildSVGForExport();
      const canvas = await svgToCanvas(svg, width, height, 2);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = buildImageFileName(projectTitle, "jpg");
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert("Export JPG failed: " + (err?.message || err));
    }
  }

  async function loadJsPDF() {
    if ((window as any).jspdf?.jsPDF) return (window as any).jspdf.jsPDF;
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load jsPDF"));
      document.head.appendChild(s);
    });
    return (window as any).jspdf.jsPDF;
  }

  async function doDownloadPDF() {
    try {
      setDownloadOpen(false);
      const { svg, width, height } = buildSVGForExport();
      const canvas = await svgToCanvas(svg, width, height, 2);
      const imgData = canvas.toDataURL("image/jpeg", 0.95);

      const jsPDF = await loadJsPDF();
      const pdf = new jsPDF({
        orientation: width >= height ? "landscape" : "portrait",
        unit: "px",
        format: [width, height],
        compress: true
      });
      pdf.addImage(imgData, "JPEG", 0, 0, width, height);
      pdf.save(buildImageFileName(projectTitle, "pdf"));
    } catch (err: any) {
      console.error(err);
      alert("Export PDF failed: " + (err?.message || err));
    }
  }

  /* ---------- Native Wheel Listener (Teams) ---------- */
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const handler = (ev: WheelEvent) => {
      if (view !== "map") return;
      ev.preventDefault();
      ev.stopPropagation();

      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const target = Math.min(MAX_Z, Math.max(MIN_Z, scale * factor));
      zoomAt(ev.clientX, ev.clientY, target);
    };

    el.addEventListener("wheel", handler, { passive: false, capture: true });
    return () => {
      el.removeEventListener("wheel", handler, { capture: true } as any);
    };
  }, [scale, view]);

  /* ---------- Kontextmenü: Farbe ---------- */
  const [ctxMenu, setCtxMenu] = useState<{ open: boolean; x: number; y: number; taskId: string | null }>({
    open: false, x: 0, y: 0, taskId: null
  });

  const CENTER_ID = "__CENTER__";

  const openColorMenu = (clientX: number, clientY: number, taskId: string) => {
    setCtxMenu({ open: true, x: clientX, y: clientY, taskId });
  };
  const closeColorMenu = () => setCtxMenu({ open: false, x: 0, y: 0, taskId: null });

  useEffect(() => {
    if (!ctxMenu.open) return;

    // Schließt nur, wenn außerhalb der .ctxmenu geklickt wurde
    const onDown = (ev: PointerEvent) => {
      const path = (ev.composedPath && ev.composedPath()) || [];
      const clickedInside = path.some(
        (el) => (el as HTMLElement)?.classList?.contains?.("ctxmenu")
      );
      if (!clickedInside) closeColorMenu();
    };

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeColorMenu();
    };

    // kein capture!
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onEsc);

    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [ctxMenu.open]);

  const applyColor = (hex: string) => {
    if (!ctxMenu.taskId) return;
    if (ctxMenu.taskId === CENTER_ID) {
      setCenterColor(hex);
      closeColorMenu();
      return;
    }
    const rootId = getRootId(ctxMenu.taskId);
    setBranchColorOverride(prev => ({ ...prev, [rootId]: hex }));
    closeColorMenu();
  };

  const onNodeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    openColorMenu(e.clientX, e.clientY, id);
  };

  return (
    <div className="app">
      <header className="topbar">
        {/* Horizontaler Scroller */}
        <div className="topbar-scroll">
          <input
            className="project-input"
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            placeholder="Project title..."
          />

          <button className="btn" onClick={addTask}>Add Task</button>
          <button className="btn btn-remove" onClick={removeLastTask} title="Remove last task (and its children)">
            Remove Task
          </button>
          <button className={view === "map" ? "view-btn active" : "view-btn"} onClick={openMap}>Visualize</button>

          <div className="save-wrap">
            <button ref={saveBtnRef} className="btn btn-save" onClick={toggleSaveMenu}>Save</button>
            {saveOpen && savePos && (
              <div
                className="save-menu"
                role="menu"
                style={{ top: savePos.top, left: savePos.left, transform: "translateX(-100%)" }}
                onMouseLeave={() => setSaveOpen(false)}
              >
                <button className="save-item" onClick={doSave}>Save</button>
                <button className="save-item" onClick={doSaveAs}>Save As…</button>
              </div>
            )}
          </div>

          <button className={view === "edit" ? "view-btn active" : "view-btn"} onClick={() => setView("edit")}>Edit</button>

          <button className="view-btn" onClick={doOpen}>Open</button>

          {/* Download neben Open */}
          <div className="save-wrap">
            <button ref={downloadBtnRef} className="view-btn" onClick={toggleDownloadMenu}>Download</button>
            {downloadOpen && downloadPos && (
              <div
                className="save-menu"
                role="menu"
                style={{ top: downloadPos.top, left: downloadPos.left, transform: "translateX(-100%)" }}
                onMouseLeave={() => setDownloadOpen(false)}
              >
                <button className="save-item" onClick={doDownloadPDF}>PDF</button>
                <button className="save-item" onClick={doDownloadJPG}>JPG</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {view === "map" && (
        <button className="center-btn" onClick={resetView} aria-label="Center">Center</button>
      )}

      <div className="body">
        {view === "edit" ? (
          <div className="task-list">
            <h2 className="section-title"></h2>
            {roots.map(r => (
              <Row
                key={r.id}
                task={r}
                depth={0}
                tasks={tasks}
                draggingId={draggingId}
                hoverId={hoverId}
                setHoverId={setHoverId}
                startDrag={(id) => { startDrag(id); }}
                renameTask={renameTask}
                editGesture={editGesture}
                LONGPRESS_MS={LONGPRESS_MS}
              />
            ))}
          </div>
        ) : (
          <div
            className="skillmap-wrapper"
            ref={wrapperRef}
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDownMap}
            onPointerMove={onPointerMoveMap}
            onPointerUp={onPointerUpMap}
            onPointerCancel={onPointerUpMap}
            onWheel={onWheel}
          >
            <div
              className="map-pan"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: "0 0" }}
            >
              <div className="map-origin">
                <svg className="map-svg" viewBox="-2000 -2000 4000 4000">
                  {roots.map((root, i) => {
                    const total = Math.max(roots.length, 1);
                    const ang = (i / total) * Math.PI * 2;
                    const rxBase = Math.cos(ang) * ROOT_RADIUS;
                    const ryBase = Math.sin(ang) * ROOT_RADIUS;
                    const ro = getOffset(root.id);
                    const rx = rxBase + ro.x;
                    const ry = ryBase + ro.y;
                    const { x1, y1, x2, y2 } = segmentBetweenCircles(0, 0, R_CENTER, rx, ry, R_ROOT);
                    const color = branchColorOverride[root.id] ?? BRANCH_COLORS[i % BRANCH_COLORS.length];
                    return (
                      <line key={`root-line-${root.id}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="3" strokeLinecap="round"/>
                    );
                  })}
                  {roots.flatMap((root, i) => {
                    const total = Math.max(roots.length, 1);
                    const ang = (i / total) * Math.PI * 2;
                    const rxBase = Math.cos(ang) * ROOT_RADIUS;
                    const ryBase = Math.sin(ang) * ROOT_RADIUS;
                    const ro = getOffset(root.id);
                    const rx = rxBase + ro.x;
                    const ry = ryBase + ro.y;
                    const color = branchColorOverride[root.id] ?? BRANCH_COLORS[i % BRANCH_COLORS.length];
                    return renderChildLinesWithOffsets(root.id, rx, ry, R_ROOT, color, childrenOf, 0, 0, getOffset);
                  })}
                </svg>

                <div
                  className="skill-node center-node"
                  style={{ background: centerColor }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openColorMenu(e.clientX, e.clientY, CENTER_ID);
                  }}
                  lang={document.documentElement.lang || navigator.language || "en"}
                >
                  {projectTitle || "Project"}
                </div>

                {roots.map((root, i) => {
                  const total = Math.max(roots.length, 1);
                  const ang = (i / total) * Math.PI * 2;
                  const rxBase = Math.cos(ang) * ROOT_RADIUS;
                  const ryBase = Math.sin(ang) * ROOT_RADIUS;
                  const ro = getOffset(root.id);
                  const rx = rxBase + ro.x;
                  const ry = ryBase + ro.y;
                  const color = branchColorOverride[root.id] ?? BRANCH_COLORS[i % BRANCH_COLORS.length];
                  return (
                    <React.Fragment key={`root-node-${root.id}`}>
                      <div
                        className="skill-node root-node"
                        style={{ transform: `translate(${rx}px, ${ry}px) translate(-50%, -50%)`, background: color }}
                        onPointerDown={(e) => startNodeDrag(root.id, e)}
                        onContextMenu={(e) => onNodeContextMenu(e, root.id)}
                        lang={document.documentElement.lang || navigator.language || "en"}
                      >
                        {root.title}
                      </div>
                      {renderChildNodesWithOffsets(
                        root.id, rx, ry, color, childrenOf, 0, 0, getOffset, startNodeDrag, onNodeContextMenu
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            {/* Kontextmenü Overlay */}
            {ctxMenu.open && ctxMenu.taskId && (
              <div
                className="ctxmenu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onPointerDown={(e) => { e.stopPropagation(); }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className="ctxmenu-title">Farbe</div>
                <div className="ctxmenu-swatches">
                  {COLOR_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      className="ctxmenu-swatch"
                      style={{ background: hex }}
                      onClick={() => applyColor(hex)}
                      onContextMenu={(e) => { e.preventDefault(); applyColor(hex); }}
                      aria-label={`Farbe ${hex}`}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----- Edit row (recursive) ----- */
function Row({
  task, depth, tasks, draggingId, hoverId, setHoverId, startDrag, renameTask, editGesture, LONGPRESS_MS
}: {
  task: Task; depth: number; tasks: Task[];
  draggingId: string | null;
  hoverId: string | null;
  setHoverId: (id: string | null) => void;
  startDrag: (id: string) => void;
  renameTask: (id: string, title: string) => void;
  editGesture: React.MutableRefObject<{
    pointerId: number; rowEl: HTMLElement; startX: number; startY: number; started: boolean; taskId: string;
  } | null>;
  LONGPRESS_MS: number;
}) {
  const children = tasks.filter(t => t.parentId === task.id);
  const isDroppable = (srcId: string | null) =>
    !!srcId && srcId !== task.id && !isDescendant(tasks, task.id, srcId);

  const longPressTimer = useRef<number | null>(null);
  const clearTimer = () => { if (longPressTimer.current !== null) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; } };

  const handlePointerDownDragZone = (e: React.PointerEvent) => {
    const rowEl = (e.currentTarget as HTMLElement).parentElement as HTMLElement; // .task-row
    const id = rowEl.dataset.taskId!;
    editGesture.current = { pointerId: e.pointerId, rowEl, startX: e.clientX, startY: e.clientY, started: false, taskId: id };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    clearTimer();
    longPressTimer.current = window.setTimeout(() => {
      if (editGesture.current && !editGesture.current.started) {
        startDrag(id);
        editGesture.current.started = true;
      }
    }, LONGPRESS_MS);
  };

  const handlePointerUpAnywhere = (e: React.PointerEvent) => {
    clearTimer();
    if (editGesture.current && e.pointerId === editGesture.current.pointerId && !editGesture.current.started) {
      editGesture.current = null;
    }
  };

  return (
    <>
      <div
        className={`task-row ${isDroppable(draggingId) && hoverId === task.id ? "drop-hover" : ""} ${draggingId === task.id ? "dragging-row" : ""}`}
        style={{ paddingLeft: depth * 28 + "px" }}
        data-task-id={task.id}
        onPointerEnter={() => { if (isDroppable(draggingId)) setHoverId(task.id); }}
        onPointerLeave={() => { if (hoverId === task.id) setHoverId(null); }}

        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          const inInput = target.closest(".task-input");
          if (inInput) return;

          if (e.pointerType === "mouse") {
            startDrag(task.id);
          }
        }}

        onPointerUp={handlePointerUpAnywhere}
      >
        <span className="drag-handle left" onPointerDown={handlePointerDownDragZone} />
        <span className="task-bullet" onPointerDown={handlePointerDownDragZone} />
        <input
          className="task-input"
          value={task.title}
          onChange={(e) => renameTask(task.id, e.target.value)}
          placeholder="Task title…"
        />
        {task.parentId && <span className="task-parent-label">child</span>}
        <span className="drag-handle right" onPointerDown={handlePointerDownDragZone} />
      </div>

      {children.map(c => (
        <Row
          key={c.id}
          task={c}
          depth={depth + 1}
          tasks={tasks}
          draggingId={draggingId}
          hoverId={hoverId}
          setHoverId={setHoverId}
          startDrag={startDrag}
          renameTask={renameTask}
          editGesture={editGesture}
          LONGPRESS_MS={LONGPRESS_MS}
        />
      ))}
    </>
  );
}

/* ---------- Visualize helpers ---------- */
function renderChildLinesWithOffsets(
  parentId: string,
  px: number, py: number, pr: number,
  color: string,
  childrenOf: (id: string) => Task[],
  gpx: number, gpy: number,
  getOffset: (id: string) => { x: number; y: number }
): JSX.Element[] {
  const kids = childrenOf(parentId);
  if (kids.length === 0) return [];
  const lines: JSX.Element[] = [];

  const base = Math.atan2(py - gpy, px - gpx);
  const SPREAD = Math.min(Math.PI, Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6)));
  const step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
  const start = base - SPREAD / 2;

  kids.forEach((kid, idx) => {
    const ang = start + idx * step;

    const cxBase = px + Math.cos(ang) * RING;
    const cyBase = py + Math.sin(ang) * RING;
    const ko = getOffset(kid.id);
    const cx = cxBase + ko.x;
    const cy = cyBase + ko.y;

    const { x1, y1, x2, y2 } = segmentBetweenCircles(px, py, pr, cx, cy, R_CHILD);
    lines.push(
      <line key={`line-${parentId}-${kid.id}`} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={color} strokeWidth="3" strokeLinecap="round"/>
    );

    lines.push(...renderChildLinesWithOffsets(kid.id, cx, cy, R_CHILD, color, childrenOf, px, py, getOffset));
  });

  return lines;
}

function renderChildNodesWithOffsets(
  parentId: string,
  px: number, py: number,
  color: string,
  childrenOf: (id: string) => Task[],
  gpx: number, gpy: number,
  getOffset: (id: string) => { x: number; y: number },
  startNodeDrag: (id: string, e: React.PointerEvent) => void,
  onNodeContextMenu: (e: React.MouseEvent, id: string) => void
): JSX.Element[] {
  const kids = childrenOf(parentId);
  if (kids.length === 0) return [];
  const nodes: JSX.Element[] = [];

  const base = Math.atan2(py - gpy, px - gpx);
  const SPREAD = Math.min(Math.PI, Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6)));
  const step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
  const start = base - SPREAD / 2;

  kids.forEach((kid, idx) => {
    const ang = start + idx * step;

    const cxBase = px + Math.cos(ang) * RING;
    const cyBase = py + Math.sin(ang) * RING;
    const ko = getOffset(kid.id);
    const cx = cxBase + ko.x;
    const cy = cyBase + ko.y;

    nodes.push(
      <div
        key={`node-${parentId}-${kid.id}`}
        className="skill-node child-node"
        style={{ transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%)`, background: color }}
        onPointerDown={(e) => startNodeDrag(kid.id, e)}
        onContextMenu={(e) => onNodeContextMenu(e, kid.id)}
        lang={document.documentElement.lang || navigator.language || "en"}
      >
        {kid.title}
      </div>
    );

    nodes.push(...renderChildNodesWithOffsets(kid.id, cx, cy, color, childrenOf, px, py, getOffset, startNodeDrag, onNodeContextMenu));
  });

  return nodes;
}
