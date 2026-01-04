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

export type TaskAttachment = {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
};

export type Task = {
  id: string;
  title: string;
  parentId: string | null;
  color?: string; // individuelle Node-Farbe (nur Kreis)
  done?: boolean; // manueller Done-Status (Vererbung wie bei Farben)
  attachments?: TaskAttachment[]; // PDFs pro Task
};

export type MapApi = {
  // PNG ist jetzt das Primärformat
  exportPNG: () => Promise<void>;

  // Kompatibilität: alte Aufrufer, die noch exportJPG nutzen, funktionieren weiter.
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

  // für Child-Einzelfarben + Done + Attachments:
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;

  // Remove-Modus (nur Visualize)
  removeMode: boolean;
  removeSelection: Set<string>;
  onToggleRemoveTarget: (id: string) => void;

  // aktiviert Pointer-/Wheel-Handling nur wenn sichtbar
  active?: boolean;
};

/* ---------- Konstanten ---------- */
const BRANCH_COLORS = [
  "#f97316",
  "#6366f1",
  "#22c55e",
  "#eab308",
  "#0ea5e9",
  "#f43f5e",
];

const COLOR_SWATCHES = [
  "#fb923c",
  "#f97316",
  "#fbbf24",
  "#f59e0b",
  "#fb7185",
  "#f43f5e",
  "#ef4444",
  "#dc2626",
  "#facc15",
  "#eab308",
  "#a3e635",
  "#84cc16",
  "#4ade80",
  "#22c55e",
  "#10b981",
  "#059669",
  "#2dd4bf",
  "#14b8a6",
  "#22d3ee",
  "#06b6d4",
  "#38bdf8",
  "#0ea5e9",
  "#3b82f6",
  "#2563eb",
  "#818cf8",
  "#6366f1",
  "#a78bfa",
  "#8b5cf6",
  "#c084fc",
  "#a855f7",
  "#f472b6",
  "#ec4899",
  "#e5e7eb",
  "#d1d5db",
  "#9ca3af",
  "#6b7280",
  "#4b5563",
  "#374151",
  "#1f2937",
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

const MAXLEN_CENTER = 12;
const MAXLEN_ROOT_AND_CHILD = 12;

/* Long-Press-Einstellungen für Touch */
const TOUCH_LONGPRESS_DELAY_MS = 450;
const TOUCH_LONGPRESS_MOVE_CANCEL_PX = 12;

/* Export: Minimaler Weißrand + Shadow-Sicherheitsrand */
const EXPORT_MIN_PADDING_PX = 18;

// Box-shadow in App.css: 0 12px 36px
// Horizontal ~36px, oben ~24px, unten ~48px (Blur +/- Offset)
const EXPORT_SHADOW_PAD_X = 36;
const EXPORT_SHADOW_PAD_TOP = 24;
const EXPORT_SHADOW_PAD_BOTTOM = 48;

const EXPORT_MAX_PIXELS_ON_LONG_SIDE = 12000; // dynamische pixelRatio-Bremse

/* ---------- Geometrie ---------- */
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

/* ---------- Utils ---------- */
function slugifyTitle(t: string) {
  return t
    .trim()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();
}
function buildImageFileName(projectTitle: string, ext: "png" | "pdf") {
  const base = slugifyTitle(projectTitle) || "taskmap";
  return `${base}.${ext}`;
}

function splitTitleLines(
  t: string,
  maxLen: number,
  maxLines: number = 3
): string[] {
  const s = String(t ?? "").trim();
  if (!s) return ["Project"];

  const hardParts = s.split(/\r?\n/);
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

/* Edge-Key für einzelne Verbindungsstriche */
const edgeKey = (parentId: string, childId: string) =>
  `${parentId}__${childId}`;

/* ID-Helfer für Attachments */
function makeId() {
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/* ---------- Export Layout Types ---------- */
type ExportNode = {
  id: string;
  kind: "center" | "root" | "child";
  x: number;
  y: number;
  r: number;
  bubbleColor: string;
  title: string;
  done: boolean;
  removeSelected: boolean;
};

type ExportEdge = {
  parentId: string;
  childId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
};

type ExportLayout = {
  width: number;
  height: number;
  originX: number;
  originY: number;
  nodes: ExportNode[];
  edges: ExportEdge[];
};

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
    removeMode,
    removeSelection,
    onToggleRemoveTarget,
    active = true,
  } = props;

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Done-Status für das Projekt
  const [centerDone, setCenterDone] = useState<boolean>(false);

  // Attachments für den Center-Node (Project)
  const [centerAttachments, setCenterAttachments] = useState<TaskAttachment[]>(
    []
  );

  // Linien-Farben:
  const [branchEdgeColorOverride, setBranchEdgeColorOverride] = useState<
    Record<string, string>
  >({});
  const [edgeColorOverride, setEdgeColorOverride] = useState<
    Record<string, string>
  >({});

  /* ----- Helper ----- */
  const roots = useMemo(
    () => tasks.filter((t) => t.parentId === null),
    [tasks]
  );
  const childrenOf = (id: string) => tasks.filter((t) => t.parentId === id);
  const getTask = (id: string) => tasks.find((t) => t.id === id);
  const getOffset = (id: string) => nodeOffset[id] || { x: 0, y: 0 };
  const setOffset = (id: string, x: number, y: number) =>
    setNodeOffset((prev) => ({ ...prev, [id]: { x, y } }));

  function computeEffectiveDoneForTaskId(taskId: string): boolean {
    const chain: Task[] = [];
    let cur: Task | undefined = getTask(taskId);
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? getTask(cur.parentId) : undefined;
    }
    let value = !!centerDone;
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i];
      if (typeof t.done === "boolean") value = t.done;
    }
    return value;
  }

  const totalTasks = tasks.length;
  const doneCount = useMemo(() => {
    if (!totalTasks) return 0;
    return tasks.reduce(
      (acc, t) => acc + (computeEffectiveDoneForTaskId(t.id) ? 1 : 0),
      0
    );
  }, [tasks, centerDone, totalTasks]);
  const progressPercent =
    totalTasks === 0 ? 0 : Math.round((doneCount / totalTasks) * 100);

  /* ---------- Attachments Helper ---------- */

  const getAttachmentsForNode = (nodeId: string): TaskAttachment[] => {
    if (nodeId === CENTER_ID) return centerAttachments;
    const t = getTask(nodeId);
    return t?.attachments ?? [];
  };

  const setAttachmentsForNode = (
    nodeId: string,
    updater: (prev: TaskAttachment[]) => TaskAttachment[]
  ) => {
    if (nodeId === CENTER_ID) {
      setCenterAttachments((prev) => updater(prev));
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.id === nodeId ? { ...t, attachments: updater(t.attachments ?? []) } : t
      )
    );
  };

  /* ---------- Long-Press für Touch (Nodes & Edges) ---------- */

  const touchLongPressTimer = useRef<number | null>(null);
  const touchLongPressTarget = useRef<
    | {
        kind: "node";
        nodeId: string;
        clientX: number;
        clientY: number;
      }
    | {
        kind: "edge";
        parentId: string;
        childId: string;
        clientX: number;
        clientY: number;
      }
    | null
  >(null);

  const clearTouchLongPress = () => {
    if (touchLongPressTimer.current !== null) {
      window.clearTimeout(touchLongPressTimer.current);
      touchLongPressTimer.current = null;
    }
    touchLongPressTarget.current = null;
  };

  const startTouchLongPressForNode = (
    nodeId: string,
    clientX: number,
    clientY: number
  ) => {
    clearTouchLongPress();
    touchLongPressTarget.current = {
      kind: "node",
      nodeId,
      clientX,
      clientY,
    };
    touchLongPressTimer.current = window.setTimeout(() => {
      const t = touchLongPressTarget.current;
      if (!t || t.kind !== "node") return;
      openColorMenuForNode(t.clientX, t.clientY, t.nodeId);
      clearTouchLongPress();
    }, TOUCH_LONGPRESS_DELAY_MS);
  };

  const startTouchLongPressForEdge = (
    parentId: string,
    childId: string,
    clientX: number,
    clientY: number
  ) => {
    clearTouchLongPress();
    touchLongPressTarget.current = {
      kind: "edge",
      parentId,
      childId,
      clientX,
      clientY,
    };
    touchLongPressTimer.current = window.setTimeout(() => {
      const t = touchLongPressTarget.current;
      if (!t || t.kind !== "edge") return;
      openColorMenuForEdge(t.clientX, t.clientY, t.parentId, t.childId);
      clearTouchLongPress();
    }, TOUCH_LONGPRESS_DELAY_MS);
  };

  /* ---------- Node-Drag (Desktop / Maus + Touch) ---------- */
  const vDrag = useRef<{
    id: string;
    startClient: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);
  const nodeDragging = useRef(false);

  function startNodeDrag(id: string, e: React.PointerEvent) {
    if (removeMode) return;
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
    if (
      e.pointerType === "touch" &&
      touchLongPressTimer.current !== null &&
      touchLongPressTarget.current
    ) {
      const t = touchLongPressTarget.current;
      const dx0 = e.clientX - t.clientX;
      const dy0 = e.clientY - t.clientY;
      if (Math.hypot(dx0, dy0) > TOUCH_LONGPRESS_MOVE_CANCEL_PX) {
        clearTouchLongPress();
      }
    }

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

  /* ---------- Pan/Zoom ---------- */
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

  const skipClearLongPressOnNextPointerDown = useRef(false);

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

  // ✅ macOS Fix: Right-Click (button=2) und Ctrl/Meta-Click dürfen NICHT
  // durch preventDefault + PointerCapture "geschluckt" werden, sonst feuert
  // onContextMenu nicht zuverlässig.
  if (e.pointerType === "mouse") {
    const wantsContextMenu =
      e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey));
    if (wantsContextMenu) return;
  }

  if (skipClearLongPressOnNextPointerDown.current) {
    skipClearLongPressOnNextPointerDown.current = false;
  } else {
    clearTouchLongPress();
  }

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

    if (
      e.pointerType === "touch" &&
      touchLongPressTimer.current !== null &&
      touchLongPressTarget.current
    ) {
      const t = touchLongPressTarget.current;
      const dx0 = e.clientX - t.clientX;
      const dy0 = e.clientY - t.clientY;
      if (Math.hypot(dx0, dy0) > TOUCH_LONGPRESS_MOVE_CANCEL_PX) {
        clearTouchLongPress();
      }
    }

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
    clearTouchLongPress();
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

  // Global-Zoom blocken
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

  // Native Wheel Listener
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

  /* ---------- Kontextmenü: Nodes & Edges ---------- */

  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    kind: "node" | "edge";
    nodeId: string | null;
    edgeParentId: string | null;
    edgeChildId: string | null;
    tab: "color" | "files";
  }>({
    open: false,
    x: 0,
    y: 0,
    kind: "node",
    nodeId: null,
    edgeParentId: null,
    edgeChildId: null,
    tab: "color",
  });

  const [fileMenu, setFileMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    nodeId: string | null;
    attachmentId: string | null;
  }>({
    open: false,
    x: 0,
    y: 0,
    nodeId: null,
    attachmentId: null,
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputTargetNodeId = useRef<string | null>(null);

  const openColorMenuForNode = (
    clientX: number,
    clientY: number,
    taskId: string
  ) => {
    if (removeMode) return;
    setFileMenu((m) => ({ ...m, open: false }));
    setCtxMenu({
      open: true,
      x: clientX,
      y: clientY,
      kind: "node",
      nodeId: taskId,
      edgeParentId: null,
      edgeChildId: null,
      tab: "color",
    });
  };

  const openColorMenuForEdge = (
    clientX: number,
    clientY: number,
    parentId: string,
    childId: string
  ) => {
    if (removeMode) return;
    setFileMenu((m) => ({ ...m, open: false }));
    setCtxMenu({
      open: true,
      x: clientX,
      y: clientY,
      kind: "edge",
      nodeId: null,
      edgeParentId: parentId,
      edgeChildId: childId,
      tab: "color",
    });
  };

  const closeColorMenu = () => {
    setCtxMenu((prev) => ({
      ...prev,
      open: false,
      tab: "color",
    }));
    setFileMenu((m) => ({ ...m, open: false }));
  };

  // wichtig: wenn MapView offscreen (active=false), dürfen keine fixed Menüs/HUD sichtbar bleiben
  useEffect(() => {
    if (!active) {
      closeColorMenu();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (removeMode && ctxMenu.open) closeColorMenu();
  }, [removeMode, ctxMenu.open]);

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

  useEffect(() => {
    if (!fileMenu.open) return;

    const onDown = (ev: PointerEvent) => {
      const path = (ev.composedPath && ev.composedPath()) || [];
      const clickedInside = path.some((el) =>
        (el as HTMLElement)?.classList?.contains?.("filemenu")
      );
      if (!clickedInside) setFileMenu((m) => ({ ...m, open: false }));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFileMenu((m) => ({ ...m, open: false }));
    };

    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [fileMenu.open]);

  const applyColor = (hex: string) => {
    if (!ctxMenu.open) return;

    if (ctxMenu.kind === "node") {
      if (!ctxMenu.nodeId) return;

      if (ctxMenu.nodeId === CENTER_ID) {
        setCenterColor(hex);
        closeColorMenu();
        return;
      }
      const t = getTask(ctxMenu.nodeId);
      if (!t) {
        closeColorMenu();
        return;
      }

      if (t.parentId === null) {
        setBranchColorOverride((prev) => ({ ...prev, [t.id]: hex }));
      } else {
        setTasks((prev) =>
          prev.map((x) => (x.id === t.id ? { ...x, color: hex } : x))
        );
      }
      closeColorMenu();
      return;
    }

    if (ctxMenu.kind === "edge") {
      const parentId = ctxMenu.edgeParentId;
      const childId = ctxMenu.edgeChildId;
      if (!parentId || !childId) {
        closeColorMenu();
        return;
      }

      if (parentId === CENTER_ID) {
        setBranchEdgeColorOverride((prev) => ({
          ...prev,
          [childId]: hex,
        }));
      } else {
        const key = edgeKey(parentId, childId);
        setEdgeColorOverride((prev) => ({ ...prev, [key]: hex }));
      }

      closeColorMenu();
    }
  };

  const toggleDone = () => {
    if (!ctxMenu.open || ctxMenu.kind !== "node") return;
    if (!ctxMenu.nodeId) return;

    if (ctxMenu.nodeId === CENTER_ID) {
      setCenterDone((prev) => !prev);
      return;
    }

    const id = ctxMenu.nodeId;
    const t = getTask(id);
    if (!t) return;

    const explicit = t.done;
    const effective = computeEffectiveDoneForTaskId(id);

    let nextExplicit: boolean;
    if (explicit === undefined) nextExplicit = !effective;
    else if (explicit === true) nextExplicit = false;
    else nextExplicit = true;

    setTasks((prev) =>
      prev.map((x) => (x.id === id ? { ...x, done: nextExplicit } : x))
    );
  };

  const onNodeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (removeMode) return;
    openColorMenuForNode(e.clientX, e.clientY, id);
  };

  const onEdgeContextMenu = (
    e: React.MouseEvent<SVGLineElement, MouseEvent>,
    parentId: string,
    childId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (removeMode) return;
    openColorMenuForEdge(e.clientX, e.clientY, parentId, childId);
  };

  /* ---------- Attachments: Add / Download / Delete ---------- */

  const handleAddPdfClick = (nodeId: string) => {
    if (!fileInputRef.current) return;
    fileInputTargetNodeId.current = nodeId;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    const nodeId = fileInputTargetNodeId.current;
    if (!file || !nodeId) return;

    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      window.alert("Only PDF files are supported right now.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) return;

      const attachment: TaskAttachment = {
        id: makeId(),
        name: file.name || "attachment.pdf",
        mime: file.type || "application/pdf",
        dataUrl,
      };

      setAttachmentsForNode(nodeId, (prev) => [...prev, attachment]);
    };
    reader.readAsDataURL(file);
  };

  const openFileContextMenu = (
    clientX: number,
    clientY: number,
    nodeId: string,
    attachmentId: string
  ) => {
    setFileMenu((prev) => {
      if (
        prev.open &&
        prev.nodeId === nodeId &&
        prev.attachmentId === attachmentId
      ) {
        return { ...prev, open: false };
      }
      return {
        open: true,
        x: clientX,
        y: clientY,
        nodeId,
        attachmentId,
      };
    });
  };

  const handleDownloadAttachment = () => {
    const { nodeId, attachmentId } = fileMenu;
    if (!nodeId || !attachmentId) return;
    const att = getAttachmentsForNode(nodeId).find((a) => a.id === attachmentId);
    if (!att) return;

    const a = document.createElement("a");
    a.href = att.dataUrl;
    a.download = att.name || "attachment.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setFileMenu((m) => ({ ...m, open: false }));
  };

  const handleDeleteAttachment = () => {
    const { nodeId, attachmentId } = fileMenu;
    if (!nodeId || !attachmentId) return;

    setAttachmentsForNode(nodeId, (prev) =>
      prev.filter((a) => a.id !== attachmentId)
    );
    setFileMenu((m) => ({ ...m, open: false }));
  };

  /* ---------- Render-Helpers ---------- */

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

  // Eine Edge = sichtbare Linie + dicke unsichtbare Hit-Line
  function renderEdgeLine(
    keyBase: string,
    parentId: string,
    childId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    baseColor: string
  ): JSX.Element {
    const id = edgeKey(parentId, childId);
    const lineColor = edgeColorOverride[id] ?? baseColor;

    return (
      <React.Fragment key={keyBase}>
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="transparent"
          strokeWidth="18"
          strokeLinecap="round"
          style={{ pointerEvents: "stroke" }}
          onContextMenu={(e) => onEdgeContextMenu(e, parentId, childId)}
          onPointerDown={(e) => {
            if (e.pointerType === "touch") {
              if (removeMode) return;
              e.stopPropagation();
              e.preventDefault();
              startTouchLongPressForEdge(parentId, childId, e.clientX, e.clientY);
            }
          }}
          onPointerUp={() => clearTouchLongPress()}
          onPointerCancel={() => clearTouchLongPress()}
        />
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={lineColor}
          strokeWidth="3"
          strokeLinecap="round"
          style={{ pointerEvents: "none" }}
        />
      </React.Fragment>
    );
  }

  function renderChildLinesWithOffsets(
    parentId: string,
    px: number,
    py: number,
    pr: number,
    edgeBaseColor: string,
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

      const seg = segmentBetweenCircles(px, py, pr, cx, cy, R_CHILD);

      lines.push(
        renderEdgeLine(
          `line-${parentId}-${kid.id}`,
          parentId,
          kid.id,
          seg.x1,
          seg.y1,
          seg.x2,
          seg.y2,
          edgeBaseColor
        )
      );

      lines.push(
        ...renderChildLinesWithOffsets(kid.id, cx, cy, R_CHILD, edgeBaseColor, px, py)
      );
    });

    return lines;
  }

  function renderChildNodesWithOffsets(
    parentId: string,
    px: number,
    py: number,
    rootBubbleColor: string,
    gpx: number,
    gpy: number,
    inheritedDone: boolean
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

      const task = getTask(kid.id);
      const explicitDone =
        typeof task?.done === "boolean" ? task.done : undefined;
      const isDone = explicitDone !== undefined ? explicitDone : inheritedDone;

      const bubbleColor = (() => {
        const t = getTask(kid.id);
        return t?.parentId ? t.color ?? rootBubbleColor : rootBubbleColor;
      })();

      const isSelectedForRemove = removeMode && removeSelection.has(kid.id);

      nodes.push(
        <div
          key={`node-${parentId}-${kid.id}`}
          className={
            "skill-node child-node" +
            (removeMode ? " node-remove-mode" : "") +
            (isSelectedForRemove ? " node-remove-selected" : "")
          }
          style={{
            transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%)`,
            background: bubbleColor,
          }}
          data-done={isDone ? "true" : "false"}
          data-remove-mode={removeMode ? "true" : "false"}
          data-remove-selected={isSelectedForRemove ? "true" : "false"}
          onPointerDown={(e) => {
  // ✅ macOS: Right-Click / Ctrl-Click soll Menü öffnen, nicht Drag starten
  if (e.pointerType === "mouse") {
    const wantsContextMenu =
      e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey));
    if (wantsContextMenu) return;
  }

  if (removeMode) {
    e.stopPropagation();
    e.preventDefault();
    onToggleRemoveTarget(kid.id);
    return;
  }

  if (e.pointerType === "touch") {
    e.stopPropagation();
    e.preventDefault();
    startNodeDrag(kid.id, e);
    startTouchLongPressForNode(kid.id, e.clientX, e.clientY);
    return;
  }

  startNodeDrag(kid.id, e);
}}

     
          onPointerUp={() => clearTouchLongPress()}
          onPointerCancel={() => clearTouchLongPress()}
          onContextMenu={(e) => onNodeContextMenu(e, kid.id)}
          lang={document.documentElement.lang || navigator.language || "en"}
        >
          {removeMode && (
            <div className="remove-checkbox" aria-hidden="true">
              {isSelectedForRemove && (
                <div className="remove-checkbox-mark">✕</div>
              )}
            </div>
          )}
          {isDone && (
            <div className="done-badge" aria-hidden="true">
              <span className="done-badge-check">✓</span>
            </div>
          )}
          {renderTitleAsSpans(kid.title, MAXLEN_ROOT_AND_CHILD)}
        </div>
      );

      nodes.push(
        ...renderChildNodesWithOffsets(
          kid.id,
          cx,
          cy,
          rootBubbleColor,
          px,
          py,
          isDone
        )
      );
    });

    return nodes;
  }

  /* ---------- Export: "echte Map" (ohne pan/scale Screenshot) ---------- */

  const exportRootRef = useRef<HTMLDivElement | null>(null);
  const [exportLayout, setExportLayout] = useState<ExportLayout | null>(null);
  const exportBusy = useRef(false);

  const wait2Frames = async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  };

  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

  const computeExportLayout = (): ExportLayout => {
    const nodes: ExportNode[] = [];
    const edges: ExportEdge[] = [];

    // Center node
    nodes.push({
      id: CENTER_ID,
      kind: "center",
      x: 0,
      y: 0,
      r: R_CENTER,
      bubbleColor: centerColor,
      title: projectTitle || "Project",
      done: !!centerDone,
      removeSelected: false,
    });

    const totalRoots = Math.max(roots.length, 1);

    const addChildRec = (
      parentId: string,
      px: number,
      py: number,
      pr: number,
      gpx: number,
      gpy: number,
      rootBubbleColor: string,
      edgeBaseColor: string,
      inheritedDone: boolean
    ) => {
      const kids = childrenOf(parentId);
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

        const cxBase = px + Math.cos(ang) * RING;
        const cyBase = py + Math.sin(ang) * RING;

        const ko = getOffset(kid.id);
        const cx = cxBase + ko.x;
        const cy = cyBase + ko.y;

        const t = getTask(kid.id);
        const explicitDone = typeof t?.done === "boolean" ? t.done : undefined;
        const isDone = explicitDone !== undefined ? explicitDone : inheritedDone;

        const bubbleColor = t?.color ?? rootBubbleColor;
        const isSelectedForRemove = removeMode && removeSelection.has(kid.id);

        nodes.push({
          id: kid.id,
          kind: "child",
          x: cx,
          y: cy,
          r: R_CHILD,
          bubbleColor,
          title: kid.title,
          done: isDone,
          removeSelected: isSelectedForRemove,
        });

        const seg = segmentBetweenCircles(px, py, pr, cx, cy, R_CHILD);
        const key = edgeKey(parentId, kid.id);
        const lineColor = edgeColorOverride[key] ?? edgeBaseColor;

        edges.push({
          parentId,
          childId: kid.id,
          x1: seg.x1,
          y1: seg.y1,
          x2: seg.x2,
          y2: seg.y2,
          color: lineColor,
        });

        addChildRec(kid.id, cx, cy, R_CHILD, px, py, rootBubbleColor, edgeBaseColor, isDone);
      });
    };

    // Roots + their subtrees
    roots.forEach((root, i) => {
      const ang = (i / totalRoots) * Math.PI * 2;
      const rxBase = Math.cos(ang) * ROOT_RADIUS;
      const ryBase = Math.sin(ang) * ROOT_RADIUS;
      const ro = getOffset(root.id);
      const rx = rxBase + ro.x;
      const ry = ryBase + ro.y;

      const baseBubbleColor =
        branchColorOverride[root.id] ?? BRANCH_COLORS[i % BRANCH_COLORS.length];
      const baseEdgeColor = branchEdgeColorOverride[root.id] ?? baseBubbleColor;

      const rootTask = getTask(root.id);
      const explicitRootDone =
        typeof rootTask?.done === "boolean" ? rootTask.done : undefined;
      const rootDone = explicitRootDone !== undefined ? explicitRootDone : !!centerDone;

      const isRootSelectedForRemove = removeMode && removeSelection.has(root.id);

      nodes.push({
        id: root.id,
        kind: "root",
        x: rx,
        y: ry,
        r: R_ROOT,
        bubbleColor: baseBubbleColor,
        title: root.title,
        done: rootDone,
        removeSelected: isRootSelectedForRemove,
      });

      // Center -> Root edge
      const seg = segmentBetweenCircles(0, 0, R_CENTER, rx, ry, R_ROOT);
      edges.push({
        parentId: CENTER_ID,
        childId: root.id,
        x1: seg.x1,
        y1: seg.y1,
        x2: seg.x2,
        y2: seg.y2,
        color: baseEdgeColor,
      });

      // Children edges + nodes
      addChildRec(root.id, rx, ry, R_ROOT, 0, 0, baseBubbleColor, baseEdgeColor, rootDone);
    });

    // Bounds (nur Nodes reichen – Edges liegen innerhalb)
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }

    // Shadow + Weißrand
    minX -= EXPORT_SHADOW_PAD_X + EXPORT_MIN_PADDING_PX;
    maxX += EXPORT_SHADOW_PAD_X + EXPORT_MIN_PADDING_PX;
    minY -= EXPORT_SHADOW_PAD_TOP + EXPORT_MIN_PADDING_PX;
    maxY += EXPORT_SHADOW_PAD_BOTTOM + EXPORT_MIN_PADDING_PX;

    const width = Math.max(1, Math.ceil(maxX - minX));
    const height = Math.max(1, Math.ceil(maxY - minY));

    const originX = -minX;
    const originY = -minY;

    return { width, height, originX, originY, nodes, edges };
  };

  const pickPixelRatio = (w: number, h: number) => {
    const dpr = window.devicePixelRatio || 1;
    const base = clamp(dpr * 2, 2, 4);
    const longSide = Math.max(w, h);
    const maxRatioBySize = EXPORT_MAX_PIXELS_ON_LONG_SIDE / Math.max(1, longSide);
    return clamp(Math.min(base, maxRatioBySize), 1, 4);
  };

type ExportCapture = {
  dataUrl: string;
  layout: ExportLayout;
  pixelRatio: number;
};

const captureExport = async (): Promise<ExportCapture> => {
  if (exportBusy.current) throw new Error("Export already in progress");
  exportBusy.current = true;

  try {
    const layout = computeExportLayout();
    setExportLayout(layout);
    await wait2Frames();

    const el = exportRootRef.current;
    if (!el) throw new Error("Export root not mounted");

    const pixelRatio = pickPixelRatio(layout.width, layout.height);

    const dataUrl = await htmlToImage.toPng(el, {
      backgroundColor: "#ffffff",
      pixelRatio,
      cacheBust: true,
      useCORS: true,
      style: { opacity: "1" },
    });

    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      throw new Error("Invalid PNG data generated");
    }

    return { dataUrl, layout, pixelRatio };
  } finally {
    setExportLayout(null);
    exportBusy.current = false;
  }
};


 const doDownloadPNG = async () => {
  try {
    const { dataUrl } = await captureExport();
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = buildImageFileName(projectTitle, "png");
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    window.alert(
      "Export as PNG failed. Please try again and check the console for details."
    );
  }
};


  const doDownloadPDF = async () => {
  try {
    const { dataUrl, layout } = await captureExport();

    // PDF-Seite = unskalierte Layout-Größe (nicht Bildpixel!)
    const pageW = layout.width;
    const pageH = layout.height;

    const pdf = new jsPDF({
      orientation: pageW >= pageH ? "landscape" : "portrait",
      unit: "px",
      format: [pageW, pageH],
      compress: true,
    });

    // Bild wird (hochaufgelöst) in die kleinere Seite skaliert => mehr "DPI" => sichtbar schärfer
    pdf.addImage(dataUrl, "PNG", 0, 0, pageW, pageH);

    pdf.save(buildImageFileName(projectTitle, "pdf"));
  } catch {
    window.alert(
      "Export as PDF failed. Please try again and check the console for details."
    );
  }
};


  /* ---------- Ref-API ---------- */
  const resetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  useImperativeHandle(ref, () => ({
    exportPNG: doDownloadPNG,
    exportJPG: doDownloadPNG, // Alias
    exportPDF: doDownloadPDF,
    resetView,
  }));

  /* ---------- JSX ---------- */
  return (
    <>
      <div
        className={
          "skillmap-wrapper" + (removeMode ? " skillmap-remove-mode" : "")
        }
        ref={wrapperRef}
        style={{
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
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
              {/* Center -> Root Edges */}
              {roots.map((root, i) => {
                const total = Math.max(roots.length, 1);
                const ang = (i / total) * Math.PI * 2;
                const rxBase = Math.cos(ang) * ROOT_RADIUS;
                const ryBase = Math.sin(ang) * ROOT_RADIUS;
                const ro = getOffset(root.id);
                const rx = rxBase + ro.x;
                const ry = ryBase + ro.y;
                const seg = segmentBetweenCircles(0, 0, R_CENTER, rx, ry, R_ROOT);

                const baseBubbleColor =
                  branchColorOverride[root.id] ??
                  BRANCH_COLORS[i % BRANCH_COLORS.length];
                const baseEdgeColor =
                  branchEdgeColorOverride[root.id] ?? baseBubbleColor;

                return renderEdgeLine(
                  `root-line-${root.id}`,
                  CENTER_ID,
                  root.id,
                  seg.x1,
                  seg.y1,
                  seg.x2,
                  seg.y2,
                  baseEdgeColor
                );
              })}

              {/* Child-Edges */}
              {roots.flatMap((root, i) => {
                const total = Math.max(roots.length, 1);
                const ang = (i / total) * Math.PI * 2;
                const rxBase = Math.cos(ang) * ROOT_RADIUS;
                const ryBase = Math.sin(ang) * ROOT_RADIUS;
                const ro = getOffset(root.id);
                const rx = rxBase + ro.x;
                const ry = ryBase + ro.y;

                const baseBubbleColor =
                  branchColorOverride[root.id] ??
                  BRANCH_COLORS[i % BRANCH_COLORS.length];
                const baseEdgeColor =
                  branchEdgeColorOverride[root.id] ?? baseBubbleColor;

                return renderChildLinesWithOffsets(
                  root.id,
                  rx,
                  ry,
                  R_ROOT,
                  baseEdgeColor,
                  0,
                  0
                );
              })}
            </svg>

            {/* Center Node */}
            <div
              className="skill-node center-node"
              style={{ background: centerColor }}
              data-done={centerDone ? "true" : "false"}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (removeMode) return;
                openColorMenuForNode(e.clientX, e.clientY, CENTER_ID);
              }}
              onPointerDown={(e) => {
                if (removeMode) return;
                if (e.pointerType === "touch") {
                  e.preventDefault();
                  skipClearLongPressOnNextPointerDown.current = true;
                  startTouchLongPressForNode(CENTER_ID, e.clientX, e.clientY);
                }
              }}
              onPointerUp={() => clearTouchLongPress()}
              onPointerCancel={() => clearTouchLongPress()}
              lang={document.documentElement.lang || navigator.language || "en"}
            >
              {centerDone && (
                <div className="done-badge" aria-hidden="true">
                  <span className="done-badge-check">✓</span>
                </div>
              )}
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

              const rootBubbleColor =
                branchColorOverride[root.id] ??
                BRANCH_COLORS[i % BRANCH_COLORS.length];

              const rootTask = getTask(root.id);
              const explicitRootDone =
                typeof rootTask?.done === "boolean" ? rootTask.done : undefined;
              const rootDone =
                explicitRootDone !== undefined ? explicitRootDone : centerDone;

              const isRootSelectedForRemove =
                removeMode && removeSelection.has(root.id);

              return (
                <React.Fragment key={`root-node-${root.id}`}>
                  <div
                    className={
                      "skill-node root-node" +
                      (removeMode ? " node-remove-mode" : "") +
                      (isRootSelectedForRemove ? " node-remove-selected" : "")
                    }
                    style={{
                      transform: `translate(${rx}px, ${ry}px) translate(-50%, -50%)`,
                      background: rootBubbleColor,
                    }}
                    data-done={rootDone ? "true" : "false"}
                    data-remove-mode={removeMode ? "true" : "false"}
                    data-remove-selected={isRootSelectedForRemove ? "true" : "false"}
                   onPointerDown={(e) => {
  // ✅ macOS: Right-Click / Ctrl-Click soll Menü öffnen, nicht Drag starten
  if (e.pointerType === "mouse") {
    const wantsContextMenu =
      e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey));
    if (wantsContextMenu) return;
  }

  if (removeMode) {
    e.stopPropagation();
    e.preventDefault();
    onToggleRemoveTarget(root.id);
    return;
  }

  if (e.pointerType === "touch") {
    e.stopPropagation();
    e.preventDefault();
    startNodeDrag(root.id, e);
    startTouchLongPressForNode(root.id, e.clientX, e.clientY);
    return;
  }

  startNodeDrag(root.id, e);
}}
	
                    
                    onPointerUp={() => clearTouchLongPress()}
                    onPointerCancel={() => clearTouchLongPress()}
                    onContextMenu={(e) => onNodeContextMenu(e, root.id)}
                    lang={document.documentElement.lang || navigator.language || "en"}
                  >
                    {removeMode && (
                      <div className="remove-checkbox" aria-hidden="true">
                        {isRootSelectedForRemove && (
                          <div className="remove-checkbox-mark">✕</div>
                        )}
                      </div>
                    )}
                    {rootDone && (
                      <div className="done-badge" aria-hidden="true">
                        <span className="done-badge-check">✓</span>
                      </div>
                    )}
                    {renderTitleAsSpans(root.title, MAXLEN_ROOT_AND_CHILD)}
                  </div>

                  {renderChildNodesWithOffsets(
                    root.id,
                    rx,
                    ry,
                    rootBubbleColor,
                    0,
                    0,
                    rootDone
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* Progress-HUD: nur wenn Map sichtbar (sonst fixed overlay im Edit) */}
        {active && totalTasks > 0 && (
          <div className="map-progress map-export-hide">
            <div className="map-progress-label">Progress</div>
            <div className="map-progress-row">
              <div className="map-progress-bar" aria-hidden="true">
                <div
                  className="map-progress-bar-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="map-progress-value">{progressPercent}%</div>
            </div>
          </div>
        )}

        {/* Kontextmenü (Color / Files) */}
        {active && ctxMenu.open && !removeMode && (
          <div
            className="ctxmenu"
            style={{
              left: ctxMenu.x,
              top: ctxMenu.y,
              minWidth: 260,
              minHeight: 190,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="ctxmenu-header">
              {ctxMenu.kind === "node" ? (
                <div className="ctxmenu-tabRow" style={{ display: "flex", gap: 10 }}>
                  <button
                    className={
                      "ctxmenu-doneBtn ctxmenu-tabBtn" +
                      (ctxMenu.tab === "color" ? " ctxmenu-tabBtn-active" : "")
                    }
                    onClick={() => setCtxMenu((prev) => ({ ...prev, tab: "color" }))}
                  >
                    Color
                  </button>
                  <button
                    className={
                      "ctxmenu-doneBtn ctxmenu-tabBtn" +
                      (ctxMenu.tab === "files" ? " ctxmenu-tabBtn-active" : "")
                    }
                    onClick={() => setCtxMenu((prev) => ({ ...prev, tab: "files" }))}
                  >
                    Files
                  </button>
                </div>
              ) : (
                <div className="ctxmenu-title">Color</div>
              )}

              {ctxMenu.kind === "node" && ctxMenu.nodeId && (
                <button
                  className={
                    "ctxmenu-doneBtn" +
                    ((ctxMenu.nodeId === CENTER_ID
                      ? centerDone
                      : computeEffectiveDoneForTaskId(ctxMenu.nodeId))
                      ? " ctxmenu-doneBtn-active"
                      : "")
                  }
                  onClick={toggleDone}
                >
                  Done
                </button>
              )}
            </div>

            <div className="ctxmenu-body">
              {ctxMenu.kind === "node" && ctxMenu.tab === "files" && ctxMenu.nodeId ? (
                <div className="ctxmenu-filesView">
                  <button
                    className="ctxmenu-doneBtn ctxmenu-addPdfBtn"
                    onClick={() => handleAddPdfClick(ctxMenu.nodeId!)}
                  >
                    + Add PDF
                  </button>
                  {getAttachmentsForNode(ctxMenu.nodeId).length === 0 ? (
                    <div className="ctxmenu-filesEmpty">No PDFs attached yet.</div>
                  ) : (
                    <ul
                      className="ctxmenu-fileList"
                      style={{ listStyle: "none", padding: 0, margin: "10px 0 0 0" }}
                    >
                      {getAttachmentsForNode(ctxMenu.nodeId).map((att) => (
                        <li key={att.id} className="ctxmenu-fileItem">
                          <button
                            className="ctxmenu-fileButton"
                            style={{ background: "transparent", border: "none" }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openFileContextMenu(e.clientX, e.clientY, ctxMenu.nodeId!, att.id);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openFileContextMenu(e.clientX, e.clientY, ctxMenu.nodeId!, att.id);
                            }}
                          >
                            <span className="ctxmenu-fileBullet">•</span>
                            <span className="ctxmenu-fileIcon" aria-hidden="true">
                              📄
                            </span>
                            <span className="ctxmenu-fileName" style={{ color: "#e5e7eb" }}>
                              {att.name}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
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
              )}
            </div>
          </div>
        )}

        {/* Kontextmenü für einzelne Attachments (Download / Delete) */}
        {active && fileMenu.open && (
          <div
            className="ctxmenu filemenu"
            style={{
              left: fileMenu.x,
              top: fileMenu.y,
              padding: "4px 0",
              minWidth: 140,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="filemenu-item-plain"
              style={{
                display: "block",
                width: "100%",
                padding: "6px 14px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                color: "#e5e7eb",
                fontSize: 13,
                cursor: "pointer",
              }}
              onClick={handleDownloadAttachment}
            >
              Download
            </button>
            <button
              className="filemenu-item-plain"
              style={{
                display: "block",
                width: "100%",
                padding: "6px 14px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                color: "#fecaca",
                fontSize: 13,
                cursor: "pointer",
              }}
              onClick={handleDeleteAttachment}
            >
              Delete
            </button>
          </div>
        )}

        {/* Hidden File Input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: "none" }}
          onChange={onFileInputChange}
        />
      </div>

      {/* Export-only DOM (unsichtbar, keine pan/scale transforms, gleiche CSS) */}
      {exportLayout && (
        <div
          ref={exportRootRef}
          style={{
  position: "fixed",
  left: 0,
  top: 0,
  width: exportLayout.width,
  height: exportLayout.height,
  background: "#ffffff",
  overflow: "hidden",

  // wichtig: NICHT offscreen verschieben (sonst weißer Export)
  // stattdessen "unsichtbar", aber html-to-image setzt beim Export opacity wieder auf 1
  opacity: 0,
  pointerEvents: "none",
}}

          aria-hidden="true"
        >
          {/* Edges */}
          <svg
            width={exportLayout.width}
            height={exportLayout.height}
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
          >
            {exportLayout.edges.map((e, idx) => (
              <line
                key={`${e.parentId}-${e.childId}-${idx}`}
                x1={exportLayout.originX + e.x1}
                y1={exportLayout.originY + e.y1}
                x2={exportLayout.originX + e.x2}
                y2={exportLayout.originY + e.y2}
                stroke={e.color}
                strokeWidth={3}
                strokeLinecap="round"
              />
            ))}
          </svg>

          {/* Nodes */}
          <div style={{ position: "absolute", inset: 0 }}>
            {exportLayout.nodes.map((n) => {
              const isCenter = n.kind === "center";
              const isRoot = n.kind === "root";
              const isChild = n.kind === "child";

              const cls =
                "skill-node " +
                (isCenter ? "center-node" : isChild ? "child-node" : "root-node") +
                (removeMode ? " node-remove-mode" : "") +
                (n.removeSelected ? " node-remove-selected" : "");

              return (
                <div
                  key={n.id}
                  className={cls}
                  style={{
                    left: exportLayout.originX + n.x,
                    top: exportLayout.originY + n.y,
                    transform: "translate(-50%, -50%)",
                    background: n.bubbleColor,
                    position: "absolute",
                  }}
                  data-done={n.done ? "true" : "false"}
                  data-remove-mode={removeMode ? "true" : "false"}
                  data-remove-selected={n.removeSelected ? "true" : "false"}
                >
                  {removeMode && (
                    <div className="remove-checkbox" aria-hidden="true">
                      {n.removeSelected && (
                        <div className="remove-checkbox-mark">✕</div>
                      )}
                    </div>
                  )}
                  {n.done && (
                    <div className="done-badge" aria-hidden="true">
                      <span className="done-badge-check">✓</span>
                    </div>
                  )}
                  {renderTitleAsSpans(
                    n.title,
                    isCenter ? MAXLEN_CENTER : MAXLEN_ROOT_AND_CHILD
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
});

export default MapView;
