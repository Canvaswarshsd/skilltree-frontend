// frontend/src/MapView.tsx
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import * as htmlToImage from "html-to-image";
import { jsPDF } from "jspdf";

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

/* Einheitliche Textbreiten:
   - CENTER: größer
   - ROOT & CHILD: gleich, damit identischer Umbruch */
const MAXLEN_CENTER = 18;
const MAXLEN_ROOT_AND_CHILD = 12;

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

/* ---------- Kleine Utils ---------- */
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

/**
 * Einheitliche Zeilenaufteilung:
 * - maxLen: maximale Zeichen pro Zeile
 * - maxLines: maximale Zeilenanzahl (Default 3)
 * - normales Wort-Wrapping: bricht an Leerzeichen
 * - wenn innerhalb des Fensters kein Leerzeichen gefunden wird, hyphenieren wir (sichtbarer '-')
 * - mehrere Spaces werden berücksichtigt (zählen in die Länge); vorhandene \n werden respektiert
 */
function splitTitleLines(
  t: string,
  maxLen: number,
  maxLines: number = 3
): string[] {
  const s = String(t ?? "").trim();
  if (!s) return ["Project"];

  const hardParts = s.split(/\r?\n/); // respektiere manuelle Zeilenumbrüche
  const lines: string[] = [];

  for (let part of hardParts) {
    while (part.length > 0 && lines.length < maxLines) {
      if (part.length <= maxLen) {
        lines.push(part);
        part = "";
        break;
      }
      let breakAt = part.lastIndexOf(" ", maxLen);
      if (breakAt > 0) {
        const line = part.slice(0, breakAt);
        lines.push(line);
        part = part.slice(breakAt + 1);
      } else {
        const sliceLen = Math.max(1, maxLen - 1);
        const line = part.slice(0, sliceLen) + "-";
        lines.push(line);
        part = part.slice(sliceLen);
      }
    }
    if (lines.length >= maxLines) break;
  }

  return lines.slice(0, maxLines);
}

/* ---------- MapView ---------- */
const MapView = forwardRef<MapApi, MapViewProps>(function MapView(props, ref) {
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
    if (pt)
      activePointers.current.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });

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
      setTasks((prev) =>
        prev.map((x) => (x.id === t.id ? { ...x, color: hex } : x))
      );
    }
    closeColorMenu();
  };

  const onNodeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    openColorMenu(e.clientX, e.clientY, id);
  };

  /* ---------- Export: Screenshot der echten Map (html-to-image) ---------- */

  const captureMapAsDataUrl = async (
    format: "jpeg" | "png"
  ): Promise<string> => {
    const el = wrapperRef.current;
    if (!el) throw new Error("Map wrapper not found");

    const target =
      (el.querySelector(".map-origin") as HTMLElement | null) ?? el;

    const pixelRatio = window.devicePixelRatio || 2;
    const backgroundColor = "#ffffff";

    if (format === "jpeg") {
      return await htmlToImage.toJpeg(target, {
        quality: 0.95,
        backgroundColor,
        pixelRatio,
      });
    } else {
      return await htmlToImage.toPng(target, {
        backgroundColor,
        pixelRatio,
      });
    }
  };

  const doDownloadJPG = async () => {
    const dataUrl = await captureMapAsDataUrl("jpeg");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = buildImageFileName(projectTitle, "jpg");
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const doDownloadPDF = async () => {
    const imgData = await captureMapAsDataUrl("png");

    // Größe aus dem Bild auslesen
    const img = new Image();
    img.src = imgData;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image load failed"));
    });

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const pdf = new jsPDF({
      orientation: width >= height ? "landscape" : "portrait",
      unit: "px",
      format: [width, height],
      compress: true,
    });

    pdf.addImage(imgData, "PNG", 0, 0, width, height);
    pdf.save(buildImageFileName(projectTitle, "pdf"));
  };

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

      const { x1, y1, x2, y2 } = segmentBetweenCircles(
        px,
        py,
        pr,
        cx,
        cy,
        R_CHILD
      );
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
        ...renderChildLinesWithOffsets(
          kid.id,
          cx,
          cy,
          R_CHILD,
          rootColor,
          px,
          py
        )
      );
    });

    return lines;
  }

  function renderTitleAsSpans(title: string, maxLen: number): JSX.Element[] {
    const lines = splitTitleLines(title, maxLen, 3);
    return lines.map((ln, i) => (
      <span
        key={i}
        style={{ display: "block", whiteSpace: "nowrap", lineHeight: 1.1 }}
      >
        {ln}
      </span>
    ));
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
          lang={
            document.documentElement.lang || navigator.language || "en"
          }
        >
          {renderTitleAsSpans(kid.title, MAXLEN_ROOT_AND_CHILD)}
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
            lang={
              document.documentElement.lang || navigator.language || "en"
            }
          >
            {renderTitleAsSpans(projectTitle || "Project", MAXLEN_CENTER)}
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
                  lang={
                    document.documentElement.lang ||
                    navigator.language ||
                    "en"
                  }
                >
                  {renderTitleAsSpans(
                    root.title,
                    MAXLEN_ROOT_AND_CHILD
                  )}
                </div>
                {renderChildNodesWithOffsets(
                  root.id,
                  rx,
                  ry,
                  rootColor,
                  0,
                  0
                )}
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
