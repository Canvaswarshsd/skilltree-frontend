// frontend/src/MapView.tsx
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

/* ---------- Types (lokal identisch zu App) ---------- */
export type Task = {
  id: string;
  title: string;
  parentId: string | null;
  color?: string; // individuelle Node-Farbe (nur Kreis)
};

export type MapApi = {
  exportJPG: () => Promise<void>;
  exportPDF: () => Promise<void>;
  resetView: () => void;
};

type MapViewProps = {
  projectTitle: string;
  tasks: Task[];

  // State aus App (controlled):
  nodeOffset: Record<string, { x: number; y: number }>;
  setNodeOffset: React.Dispatch<
    React.SetStateAction<Record<string, { x: number; y: number }>>
  >;

  pan: { x: number; y: number };
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;

  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;

  branchColorOverride: Record<string, string>;
  setBranchColorOverride: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;

  centerColor: string;
  setCenterColor: React.Dispatch<React.SetStateAction<string>>;

  // für Child-Einzelfarben:
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;

  // aktiviert Pointer-/Wheel-Handling nur wenn sichtbar
  active?: boolean;
};

/* ---------- Konstanten (nur Map) ---------- */
const BRANCH_COLORS = [
  "#f97316",
  "#6366f1",
  "#22c55e",
  "#eab308",
  "#0ea5e9",
  "#f43f5e",
];

const COLOR_SWATCHES = [
  "#f97316",
  "#fb923c",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#ef4444",
  "#f43f5e",
  "#ec4899",
  "#94a3b8",
  "#64748b",
  "#111827",
  "#020617",
];

const R_CENTER = 75;
const R_ROOT = 60;
const R_CHILD = 50;

const ROOT_RADIUS = 280;
const RING = 130;

const MIN_Z = 0.35;
const MAX_Z = 4;

const CENTER_ID = "__CENTER__";

/* ---------- Geometrie-Helper ---------- */
function segmentBetweenCircles(
  c1x: number,
  c1y: number,
  r1: number,
  c2x: number,
  c2y: number,
  r2: number,
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

/* ---------- Kleine Utils für Export ---------- */
function slugifyTitle(t: string) {
  return t
    .trim()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();
}
function buildImageFileName(projectTitle: string, ext: "jpg" | "pdf") {
  const base = slugifyTitle(projectTitle) || "taskmap";
  return `${base}.${ext}`;
}
function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/* ---------- MapView ---------- */
const MapView = forwardRef<MapApi, MapViewProps>(function MapView(
  props,
  ref
) {
  const {
    projectTitle,
    tasks,
    nodeOffset,
    setNodeOffset,
    pan,
    setPan,
    scale,
    setScale,
    branchColorOverride,
    setBranchColorOverride,
    centerColor,
    setCenterColor,
    setTasks,
    active = true,
  } = props;

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Derive helpers
  const roots = useMemo(
    () => tasks.filter((t) => t.parentId === null),
    [tasks]
  );
  const childrenOf = (id: string) => tasks.filter((t) => t.parentId === id);
  const getTask = (id: string) => tasks.find((t) => t.id === id);
  const getOffset = (id: string) => nodeOffset[id] || { x: 0, y: 0 };
  const setOffset = (id: string, x: number, y: number) =>
    setNodeOffset((prev) => ({ ...prev, [id]: { x, y } }));

  /* ---------- Node-Drag (Visualize) ---------- */
  const vDrag = useRef<{
    id: string;
    startClient: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);
  const nodeDragging = useRef(false);

  function startNodeDrag(id: string, e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    vDrag.current = {
      id,
      startClient: { x: e.clientX, y: e.clientY },
      startOffset: getOffset(id),
    };
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

  /* ---------- Pan/Pinch/Zoom ---------- */
  const panning = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const activePointers = useRef<Map<number, { x: number; y: number }>>(
    new Map()
  );
  const pinching = useRef(false);
  const pinchStart = useRef<{
    dist: number;
    cx: number;
    cy: number;
    startScale: number;
  } | null>(null);

  function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = a.x - b.x,
      dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }
  function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function zoomAt(clientX: number, clientY: number, nextScale: number) {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) {
      setScale(nextScale);
      return;
    }
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const wx = (cx - pan.x) / scale;
    const wy = (cy - pan.y) / scale;
    const newPanX = cx - wx * nextScale;
    const newPanY = cy - wy * nextScale;
    setScale(nextScale);
    setPan({ x: newPanX, y: newPanY });
  }

  const onPointerDownMap = (e: React.PointerEvent) => {
    if (!active) return;
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
    if (!active) return;
    const pt = activePointers.current.get(e.pointerId);
    if (pt) activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinching.current && activePointers.current.size >= 2) {
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

    if (panning.current) {
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
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

  const onWheel = (e: React.WheelEvent) => {
    if (!active) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const target = Math.min(MAX_Z, Math.max(MIN_Z, scale * factor));
    zoomAt(e.clientX, e.clientY, target);
  };

  // Safari gesture fallback
  useEffect(() => {
    if (!active) return;
    const onGestureChange = (ev: any) => {
      ev.preventDefault();
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const factor = ev.scale > 1 ? 1.12 : 1 / 1.12;
      const next = Math.min(MAX_Z, Math.max(MIN_Z, scale * factor));
      zoomAt(cx, cy, next);
    };
    window.addEventListener("gesturechange", onGestureChange, {
      passive: false,
    });
    return () => window.removeEventListener("gesturechange", onGestureChange);
  }, [scale, active, pan.x, pan.y]);

  // Global: Website-Zoom blocken (Ctrl+Wheel etc.) – nur wenn aktiv
  useEffect(() => {
    if (!active) return;
    const onGlobalWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      const path = (ev.composedPath && ev.composedPath()) || [];
      const insideMap = path.some((el) =>
        (el as HTMLElement)?.classList?.contains?.("skillmap-wrapper")
      );
      if (!insideMap) ev.preventDefault();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (
        (ev.ctrlKey || ev.metaKey) &&
        (ev.key === "+" ||
          ev.key === "-" ||
          ev.key === "0" ||
          ev.key === "=")
      ) {
        ev.preventDefault();
      }
    };
    window.addEventListener("wheel", onGlobalWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onGlobalWheel as any);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active]);

  // Native Wheel Listener (Teams) – nur wenn aktiv
  useEffect(() => {
    if (!active) return;
    const el = wrapperRef.current;
    if (!el) return;

    const handler = (ev: WheelEvent) => {
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
  }, [scale, active]);

  /* ---------- Kontextmenü: Farbe ---------- */
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    taskId: string | null;
  }>({ open: false, x: 0, y: 0, taskId: null });

  const openColorMenu = (clientX: number, clientY: number, taskId: string) => {
    setCtxMenu({ open: true, x: clientX, y: clientY, taskId });
  };
  const closeColorMenu = () =>
    setCtxMenu({ open: false, x: 0, y: 0, taskId: null });

  useEffect(() => {
    if (!ctxMenu.open) return;

    const onDown = (ev: PointerEvent) => {
      const path = (ev.composedPath && ev.composedPath()) || [];
      const clickedInside = path.some((el) =>
        (el as HTMLElement)?.classList?.contains?.("ctxmenu")
      );
      if (!clickedInside) closeColorMenu();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeColorMenu();
    };

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
    const t = getTask(ctxMenu.taskId);
    if (!t) {
      closeColorMenu();
      return;
    }
    if (t.parentId === null) {
      // Root-Farbe (Linien + Root-Kreis)
      setBranchColorOverride((prev) => ({ ...prev, [t.id]: hex }));
    } else {
      // Child: nur dieser Node
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, color: hex } : x)));
    }
    closeColorMenu();
  };

  const onNodeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    openColorMenu(e.clientX, e.clientY, id);
  };

  /* ---------- Export (SVG → Canvas → JPG/PDF) ---------- */
  type NodeGeom = {
    id: string;
    title: string;
    x: number;
    y: number;
    r: number;
    color: string;
    fontSize: number;
  };
  type EdgeGeom = { x1: number; y1: number; x2: number; y2: number; color: string };

  const getChildren = (id: string) => tasks.filter((t) => t.parentId === id);

  function nodeColor(taskId: string, rootColor: string): string {
    const t = getTask(taskId);
    if (!t) return rootColor;
    if (t.parentId === null) return rootColor;
    return t.color ?? rootColor;
  }

  function computeExportLayout(): {
    nodes: NodeGeom[];
    edges: EdgeGeom[];
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
  } {
    const nodes: NodeGeom[] = [];
    const edges: EdgeGeom[] = [];

    nodes.push({
      id: "CENTER",
      title: projectTitle || "Project",
      x: 0,
      y: 0,
      r: R_CENTER,
      color: centerColor,
      fontSize: 20,
    });

    const rootsList = tasks.filter((t) => t.parentId === null);
    const total = Math.max(rootsList.length, 1);
    const getOff = (id: string) => nodeOffset[id] || { x: 0, y: 0 };

    function placeChildren(
      parentId: string,
      px: number,
      py: number,
      pr: number,
      rootColor: string,
      gpx: number,
      gpy: number
    ) {
      const kids = getChildren(parentId);
      if (kids.length === 0) return;

      const base = Math.atan2(py - gpy, px - gpx);
      const SPREAD = Math.min(
        Math.PI,
        Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6))
      );
      const step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
      const start = base - SPREAD / 2;

      kids.forEach((kid, idx) => {
        const ang = start + idx * step;
        const ko = getOff(kid.id);
        const cx = px + Math.cos(ang) * RING + ko.x;
        const cy = py + Math.sin(ang) * RING + ko.y;

        const seg = segmentBetweenCircles(px, py, pr, cx, cy, R_CHILD);
        edges.push({
          x1: seg.x1,
          y1: seg.y1,
          x2: seg.x2,
          y2: seg.y2,
          color: rootColor,
        });

        const nColor = nodeColor(kid.id, rootColor);
        nodes.push({
          id: kid.id,
          title: kid.title,
          x: cx,
          y: cy,
          r: R_CHILD,
          color: nColor,
          fontSize: 16,
        });

        placeChildren(kid.id, cx, cy, R_CHILD, rootColor, px, py);
      });
    }

    rootsList.forEach((root, i) => {
      const ang = (i / total) * Math.PI * 2;
      const ro = getOff(root.id);
      const rx = Math.cos(ang) * ROOT_RADIUS + ro.x;
      const ry = Math.sin(ang) * ROOT_RADIUS + ro.y;
      const rootColor =
        branchColorOverride?.[root.id] ??
        BRANCH_COLORS[i % BRANCH_COLORS.length];

      const seg = segmentBetweenCircles(0, 0, R_CENTER, rx, ry, R_ROOT);
      edges.push({
        x1: seg.x1,
        y1: seg.y1,
        x2: seg.x2,
        y2: seg.y2,
        color: rootColor,
      });

      nodes.push({
        id: root.id,
        title: root.title,
        x: rx,
        y: ry,
        r: R_ROOT,
        color: rootColor,
        fontSize: 18,
      });

      placeChildren(root.id, rx, ry, R_ROOT, rootColor, 0, 0);
    });

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
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
    minX -= PAD;
    minY -= PAD;
    maxX += PAD;
    maxY += PAD;

    return { nodes, edges, bbox: { minX, minY, maxX, maxY } };
  }

  function buildSVGForExport(): { svg: string; width: number; height: number } {
    const { nodes, edges, bbox } = computeExportLayout();
    const width = Math.ceil(bbox.maxX - bbox.minX);
    const height = Math.ceil(bbox.maxY - bbox.minY);

    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bbox.minX} ${bbox.minY} ${width} ${height}">`,
      `<defs><style>.lbl{font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-weight:700; fill:#fff; text-anchor:middle; dominant-baseline:middle;}</style></defs>`,
      `<rect x="${bbox.minX}" y="${bbox.minY}" width="${width}" height="${height}" fill="#ffffff"/>`
    );

    for (const e of edges) {
      parts.push(
        `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${e.color}" stroke-width="6" stroke-linecap="round"/>`
      );
    }

    for (const n of nodes) {
      parts.push(
        `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${n.color}" />`
      );
      const maxLen = n.id === "CENTER" ? 18 : n.r === R_ROOT ? 14 : 12;
      const fs = n.fontSize;
      const lines = splitTitleLines(n.title, maxLen);
      const total = lines.length;
      lines.forEach((ln, idx) => {
        const dy = (idx - (total - 1) / 2) * (fs * 1.1);
        parts.push(
          `<text class="lbl" x="${n.x}" y="${n.y + dy}" font-size="${fs}">${esc(
            ln
          )}</text>`
        );
      });
    }

    parts.push(`</svg>`);
    return { svg: parts.join(""), width, height };
  }

  async function svgToCanvas(
    svg: string,
    width: number,
    height: number,
    scaleMul = 2
  ): Promise<HTMLCanvasElement> {
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
      canvas.width = Math.max(1, Math.round(width * scaleMul));
      canvas.height = Math.max(1, Math.round(height * scaleMul));
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

  async function doDownloadJPG() {
    const { svg, width, height } = buildSVGForExport();
    const canvas = await svgToCanvas(svg, width, height, 2);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = buildImageFileName(projectTitle, "jpg");
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function doDownloadPDF() {
    const { svg, width, height } = buildSVGForExport();
    const canvas = await svgToCanvas(svg, width, height, 2);
    const imgData = canvas.toDataURL("image/jpeg", 0.95);

    const jsPDF = await loadJsPDF();
    const pdf = new jsPDF({
      orientation: width >= height ? "landscape" : "portrait",
      unit: "px",
      format: [width, height],
      compress: true,
    });
    pdf.addImage(imgData, "JPEG", 0, 0, width, height);
    pdf.save(buildImageFileName(projectTitle, "pdf"));
  }

  /* ---------- Ref-API ---------- */
  const resetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  useImperativeHandle(ref, () => ({
    exportJPG: doDownloadJPG,
    exportPDF: doDownloadPDF,
    resetView,
  }));

  /* ---------- Render-Helpers ---------- */
  function renderChildLinesWithOffsets(
    parentId: string,
    px: number,
    py: number,
    pr: number,
    rootColor: string,
    gpx: number,
    gpy: number
  ): JSX.Element[] {
    const kids = childrenOf(parentId);
    if (kids.length === 0) return [];
    const lines: JSX.Element[] = [];

    const base = Math.atan2(py - gpy, px - gpx);
    const SPREAD = Math.min(
      Math.PI,
      Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6))
    );
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
        <line
          key={`line-${parentId}-${kid.id}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={rootColor}
          strokeWidth="3"
          strokeLinecap="round"
        />
      );

      lines.push(
        ...renderChildLinesWithOffsets(kid.id, cx, cy, R_CHILD, rootColor, px, py)
      );
    });

    return lines;
  }

  function renderChildNodesWithOffsets(
    parentId: string,
    px: number,
    py: number,
    rootColor: string,
    gpx: number,
    gpy: number
  ): JSX.Element[] {
    const kids = childrenOf(parentId);
    if (kids.length === 0) return [];
    const nodes: JSX.Element[] = [];

    const base = Math.atan2(py - gpy, px - gpx);
    const SPREAD = Math.min(
      Math.PI,
      Math.max(Math.PI * 0.6, (kids.length - 1) * (Math.PI / 6))
    );
    const step = kids.length === 1 ? 0 : SPREAD / (kids.length - 1);
    const start = base - SPREAD / 2;

    kids.forEach((kid, idx) => {
      const ang = start + idx * step;
      const cxBase = px + Math.cos(ang) * RING;
      const cyBase = py + Math.sin(ang) * RING;
      const ko = getOffset(kid.id);
      const cx = cxBase + ko.x;
      const cy = cyBase + ko.y;

      const nColor = (() => {
        const t = getTask(kid.id);
        return t?.parentId ? t.color ?? rootColor : rootColor;
      })();

      nodes.push(
        <div
          key={`node-${parentId}-${kid.id}`}
          className="skill-node child-node"
          style={{
            transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%)`,
            background: nColor,
          }}
          onPointerDown={(e) => startNodeDrag(kid.id, e)}
          onContextMenu={(e) => onNodeContextMenu(e, kid.id)}
          lang={document.documentElement.lang || navigator.language || "en"}
        >
          {kid.title}
        </div>
      );

      nodes.push(
        ...renderChildNodesWithOffsets(kid.id, cx, cy, rootColor, px, py)
      );
    });

    return nodes;
  }

  /* ---------- JSX ---------- */
  return (
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
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: "0 0",
        }}
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
              const { x1, y1, x2, y2 } = segmentBetweenCircles(
                0,
                0,
                R_CENTER,
                rx,
                ry,
                R_ROOT
              );
              const color =
                branchColorOverride[root.id] ??
                BRANCH_COLORS[i % BRANCH_COLORS.length];
              return (
                <line
                  key={`root-line-${root.id}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                />
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
              const color =
                branchColorOverride[root.id] ??
                BRANCH_COLORS[i % BRANCH_COLORS.length];
              return renderChildLinesWithOffsets(
                root.id,
                rx,
                ry,
                R_ROOT,
                color,
                0,
                0
              );
            })}
          </svg>

          {/* Center */}
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

          {/* Roots + Children */}
          {roots.map((root, i) => {
            const total = Math.max(roots.length, 1);
            const ang = (i / total) * Math.PI * 2;
            const rxBase = Math.cos(ang) * ROOT_RADIUS;
            const ryBase = Math.sin(ang) * ROOT_RADIUS;
            const ro = getOffset(root.id);
            const rx = rxBase + ro.x;
            const ry = ryBase + ro.y;
            const rootColor =
              branchColorOverride[root.id] ??
              BRANCH_COLORS[i % BRANCH_COLORS.length];

            return (
              <React.Fragment key={`root-node-${root.id}`}>
                <div
                  className="skill-node root-node"
                  style={{
                    transform: `translate(${rx}px, ${ry}px) translate(-50%, -50%)`,
                    background: rootColor,
                  }}
                  onPointerDown={(e) => startNodeDrag(root.id, e)}
                  onContextMenu={(e) => onNodeContextMenu(e, root.id)}
                  lang={document.documentElement.lang || navigator.language || "en"}
                >
                  {root.title}
                </div>
                {renderChildNodesWithOffsets(root.id, rx, ry, rootColor, 0, 0)}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Kontextmenü */}
      {ctxMenu.open && ctxMenu.taskId && (
        <div
          className="ctxmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="ctxmenu-title">Color</div>
          <div className="ctxmenu-swatches">
            {COLOR_SWATCHES.map((hex) => (
              <button
                key={hex}
                className="ctxmenu-swatch"
                style={{ background: hex }}
                onClick={() => applyColor(hex)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  applyColor(hex);
                }}
                aria-label={`Color ${hex}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default MapView;
