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
  done?: boolean; // manueller Done-Status (Vererbung wie bei Farben)
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

  // für Child-Einzelfarben + Done:
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;

  // Remove-Modus (nur Visualize)
  removeMode: boolean;
  removeSelection: Set<string>;
  onToggleRemoveTarget: (id: string) => void;

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
const MAXLEN_CENTER = 12;
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

  // Done-Status für das Projekt (Zentrum) – vererbt sich wie eine Wurzel nach unten
  const [centerDone, setCenterDone] = useState<boolean>(false);

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

  // effektiver Done-Status einer Aufgabe (CSS-artige Vererbung: Projekt → Eltern → Kind)
  function computeEffectiveDoneForTaskId(taskId: string): boolean {
    const chain: Task[] = [];
    let cur: Task | undefined = getTask(taskId);
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? getTask(cur.parentId) : undefined;
    }
    let value = !!centerDone;
    // von oben nach unten laufen (Root zuerst, Node zuletzt)
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i];
      if (typeof t.done === "boolean") {
        value = t.done;
      }
    }
    return value;
  }

  // Fortschritt (Gamification HUD)
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

  /* ---------- Node-Drag (Visualize) ---------- */
  const vDrag = useRef<{
    id: string;
    startClient: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);
  const nodeDragging = useRef(false);

  function startNodeDrag(id: string, e: React.PointerEvent) {
    // Im Remove-Modus keine Node-Bewegung
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

  /* ---------- Kontextmenü: Farbe + Done ---------- */
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    taskId: string | null;
  }>({ open: false, x: 0, y: 0, taskId: null });

  const openColorMenu = (clientX: number, clientY: number, taskId: string) => {
    // Im Remove-Modus kein Farbdialog
    if (removeMode) return;
    setCtxMenu({ open: true, x: clientX, y: clientY, taskId });
  };
  const closeColorMenu = () =>
    setCtxMenu({ open: false, x: 0, y: 0, taskId: null });

  // Wenn Remove-Modus aktiviert wird, Kontextmenü schließen
  useEffect(() => {
    if (removeMode && ctxMenu.open) {
      closeColorMenu();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeMode]);

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

  const toggleDone = () => {
    if (!ctxMenu.taskId) return;

    // Projekt-Kreis (Center) toggeln: wirkt als globale "Root"-Vererbung
    if (ctxMenu.taskId === CENTER_ID) {
      setCenterDone((prev) => !prev);
      return;
    }

    const id = ctxMenu.taskId;
    const t = getTask(id);
    if (!t) return;

    const explicit = t.done;
    const effective = computeEffectiveDoneForTaskId(id);

    let nextExplicit: boolean;
    if (explicit === undefined) {
      // war bisher nur vererbt -> Klick invertiert den sichtbaren Zustand
      nextExplicit = !effective;
    } else if (explicit === true) {
      nextExplicit = false;
    } else {
      nextExplicit = true;
    }

    // Nur dieser Task bekommt einen expliziten Wert – Kinder erben wie bei Farben
    setTasks((prev) =>
      prev.map((x) => (x.id === id ? { ...x, done: nextExplicit } : x))
    );
  };

  const onNodeContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (removeMode) return; // im Remove-Modus keine Farbe/Done
    openColorMenu(e.clientX, e.clientY, id);
  };

  /* ---------- Export: Screenshot der Map (mit leichtem Auto-Zoom) ---------- */

  const captureMapAsDataUrl = async (
    format: "jpeg" | "png"
  ): Promise<string> => {
    const el = wrapperRef.current;
    if (!el) {
      throw new Error("Map wrapper not found");
    }

    const target = el as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      throw new Error("Map has zero size – cannot export image");
    }

    // HUD-Elemente (Progress etc.) für Export unsichtbar machen
    const exportHudNodes = Array.from(
      target.querySelectorAll<HTMLElement>(".map-export-hide")
    );
    const prevVisibility = exportHudNodes.map((n) => n.style.visibility);
    exportHudNodes.forEach((n) => {
      n.style.visibility = "hidden";
    });

    // 1) Aktuelle View merken
    const originalScale = scale;
    const originalPan = { ...pan };
    let viewAdjusted = false;

    // 2) Für Export leicht herauszoomen, damit oben/unten etwas Rand entsteht
    try {
      const factor = 0.85; // wie weit rauszoomen für den Export
      const desiredScale = Math.max(MIN_Z, originalScale * factor);

      if (desiredScale < originalScale) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        zoomAt(cx, cy, desiredScale);
        viewAdjusted = true;

        // DOM-Update abwarten (2 Frames, um sicherzugehen)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve())
          )
        );
      }

      // 3) Bild wirklich rendern
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const backgroundColor = "#ffffff";

      if (format === "jpeg") {
        const dataUrl = await htmlToImage.toJpeg(target, {
          quality: 0.95,
          backgroundColor,
          pixelRatio,
          cacheBust: true,
          useCORS: true,
        });
        if (!dataUrl || !dataUrl.startsWith("data:image/")) {
          throw new Error("Invalid JPEG data generated");
        }
        return dataUrl;
      } else {
        const dataUrl = await htmlToImage.toPng(target, {
          backgroundColor,
          pixelRatio,
          cacheBust: true,
          useCORS: true,
        });
        if (!dataUrl || !dataUrl.startsWith("data:image/")) {
          throw new Error("Invalid PNG data generated");
        }
        return dataUrl;
      }
    } catch (err) {
      console.error("Map export failed:", err);
      throw err instanceof Error
        ? err
        : new Error("Unknown error during map export");
    } finally {
      // HUD wiederherstellen
      exportHudNodes.forEach((n, i) => {
        n.style.visibility = prevVisibility[i];
      });

      // 4) View wieder auf ursprüngliche Werte zurücksetzen
      if (viewAdjusted) {
        setScale(originalScale);
        setPan(originalPan);
      }
    }
  };

  const doDownloadJPG = async () => {
    try {
      const dataUrl = await captureMapAsDataUrl("jpeg");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = buildImageFileName(projectTitle, "jpg");
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error("JPEG export failed:", err);
      window.alert(
        "Export as JPG failed. Please try again and check the console for details."
      );
    }
  };

  const doDownloadPDF = async () => {
    try {
      const imgData = await captureMapAsDataUrl("png");

      const img = new Image();
      img.src = imgData;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load failed"));
      });

      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      if (!width || !height) {
        throw new Error("Exported image has zero width/height");
      }

      const pdf = new jsPDF({
        orientation: width >= height ? "landscape" : "portrait",
        unit: "px",
        format: [width, height],
        compress: true,
      });

      pdf.addImage(imgData, "PNG", 0, 0, width, height);
      pdf.save(buildImageFileName(projectTitle, "pdf"));
    } catch (err) {
      console.error("PDF export failed:", err);
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
      const isDone =
        explicitDone !== undefined ? explicitDone : inheritedDone;

      const nColor = (() => {
        const t = getTask(kid.id);
        return t?.parentId ? t.color ?? rootColor : rootColor;
      })();

      const isSelectedForRemove =
        removeMode && removeSelection.has(kid.id);

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
            background: nColor,
            
          }}
          data-done={isDone ? "true" : "false"}
          data-remove-mode={removeMode ? "true" : "false"}
          data-remove-selected={isSelectedForRemove ? "true" : "false"}
          onPointerDown={(e) => {
            if (removeMode) {
              e.stopPropagation();
              e.preventDefault();
              onToggleRemoveTarget(kid.id);
              return;
            }
            startNodeDrag(kid.id, e);
          }}
          onContextMenu={(e) => onNodeContextMenu(e, kid.id)}
          lang={
            document.documentElement.lang || navigator.language || "en"
          }
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
          rootColor,
          px,
          py,
          isDone
        )
      );
    });

    return nodes;
  }

  /* ---------- JSX ---------- */
  return (
    <div
      className={
        "skillmap-wrapper" + (removeMode ? " skillmap-remove-mode" : "")
      }
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
            data-done={centerDone ? "true" : "false"}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (removeMode) return;
              openColorMenu(e.clientX, e.clientY, CENTER_ID);
            }}
            lang={
              document.documentElement.lang || navigator.language || "en"
            }
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
            const rootColor =
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
                    background: rootColor,
                   
                  }}
                  data-done={rootDone ? "true" : "false"}
                  data-remove-mode={removeMode ? "true" : "false"}
                  data-remove-selected={
                    isRootSelectedForRemove ? "true" : "false"
                  }
                  onPointerDown={(e) => {
                    if (removeMode) {
                      e.stopPropagation();
                      e.preventDefault();
                      onToggleRemoveTarget(root.id);
                      return;
                    }
                    startNodeDrag(root.id, e);
                  }}
                  onContextMenu={(e) => onNodeContextMenu(e, root.id)}
                  lang={
                    document.documentElement.lang ||
                    navigator.language ||
                    "en"
                  }
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
                  rootColor,
                  0,
                  0,
                  rootDone
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Progress-HUD rechts oben (nicht im Export sichtbar, wegen map-export-hide) */}
      {totalTasks > 0 && (
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

      {/* Kontextmenü */}
      {ctxMenu.open && ctxMenu.taskId && !removeMode && (
        <div
          className="ctxmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="ctxmenu-header">
            <div className="ctxmenu-title">Color</div>
            <button
              className={
                "ctxmenu-doneBtn" +
                ((ctxMenu.taskId === CENTER_ID
                  ? centerDone
                  : computeEffectiveDoneForTaskId(ctxMenu.taskId))
                  ? " ctxmenu-doneBtn-active"
                  : "")
              }
              onClick={toggleDone}
            >
              Done
            </button>
          </div>
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
