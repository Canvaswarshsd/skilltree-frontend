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
  color?: string;
  done?: boolean;
};

export type MapApi = {
  exportJPG: () => Promise<void>;
  exportPDF: () => Promise<void>;
  resetView: () => void;
};

type MapViewProps = {
  projectTitle: string;
  tasks: Task[];

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

  // wichtig für Farben / Done
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;

  /* ---------- NEW: REMOVE-MODUS ---------- */
  removeMode: boolean;
  markedForRemoval: Set<string>;
  toggleMark: (id: string) => void;

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
  return {
    x1: c1x + ux * (r1 - overlap),
    y1: c1y + uy * (r1 - overlap),
    x2: c2x - ux * (r2 - overlap),
    y2: c2y - uy * (r2 - overlap),
  };
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
function buildImageFileName(projectTitle: string, ext: "jpg" | "pdf") {
  const base = slugifyTitle(projectTitle) || "taskmap";
  return `${base}.${ext}`;
}

/* ---------- NEW: Titel-Split unverändert ---------- */
function splitTitleLines(
  t: string,
  maxLen: number,
  maxLines: number = 3
): string[] {
  const s = String(t ?? "").trim();
  if (!s) return ["Project"];
  const hard = s.split(/\r?\n/);
  const out: string[] = [];
  for (let part of hard) {
    while (part.length > 0 && out.length < maxLines) {
      if (part.length <= maxLen) {
        out.push(part);
        part = "";
        break;
      }
      let at = part.lastIndexOf(" ", maxLen);
      if (at > 0) {
        out.push(part.slice(0, at));
        part = part.slice(at + 1);
      } else {
        const sl = Math.max(1, maxLen - 1);
        out.push(part.slice(0, sl) + "-");
        part = part.slice(sl);
      }
    }
  }
  return out.slice(0, maxLines);
}

/* =====================================================
      MAPVIEW START + REMOVE-MODUS-INTEGRATION
===================================================== */
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

    /* ---------- NEW ---------- */
    removeMode,
    markedForRemoval,
    toggleMark,

    active = true,
  } = props;

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  /* ---------- Done-Status Zentrum ---------- */
  const [centerDone, setCenterDone] = useState(false);

  const roots = useMemo(() => tasks.filter((t) => t.parentId === null), [tasks]);
  const childrenOf = (id: string) => tasks.filter((t) => t.parentId === id);
  const getTask = (id: string) => tasks.find((t) => t.id === id);

  const getOffset = (id: string) => nodeOffset[id] || { x: 0, y: 0 };
  const setOffset = (id: string, x: number, y: number) =>
    setNodeOffset((p) => ({ ...p, [id]: { x, y } }));

  /* ---------- Done-Vererbung ---------- */
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

  /* =====================================================
     NODE-DRAG — WICHTIG: im Remove-Modus deaktiviert!
  ===================================================== */
  const vDrag = useRef<{
    id: string;
    startClient: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);

  const nodeDragging = useRef(false);

  function startNodeDrag(id: string, e: React.PointerEvent) {
    if (removeMode) return; // <-- NEU: Drag blockiert
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
    if (removeMode) return; // <-- NEU
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






  /* ---------- Render Helpers ---------- */
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

  /* =====================================================
        CHILD NODE RENDERING + REMOVE-MODUS
  ===================================================== */
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

      /* ---------- NEW: Farbe bestimmen ---------- */
      const nColor = task?.color ?? rootColor;

      /* ---------- NEW: Remove-Modus Klick ---------- */
      const onClickNode = (e: React.PointerEvent) => {
        if (removeMode) {
          e.stopPropagation();
          toggleMark(kid.id);
        }
      };

      /* ---------- NEW: Kontextmenü blockieren ---------- */
      const onCtx = (e: React.MouseEvent) => {
        if (removeMode) {
          e.preventDefault();
          return;
        }
        onNodeContextMenu(e, kid.id);
      };

      /* ---------- NEW: Badge-Logik ---------- */
      const showDoneBadge = !removeMode && isDone;
      const showTrashBadge = removeMode && markedForRemoval.has(kid.id);

      nodes.push(
        <div
          key={`node-${parentId}-${kid.id}`}
          className="skill-node child-node"
          style={{
            transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%)`,
            background: nColor,
          }}
          onPointerDown={(e) => {
            if (!removeMode) startNodeDrag(kid.id, e);
          }}
          onClick={onClickNode}
          onContextMenu={onCtx}
          data-done={isDone ? "true" : "false"}
        >
          {/* DONE BADGE → bleibt im DOM, aber wird unsichtbar */}
          {showDoneBadge && (
            <div className="done-badge" aria-hidden="true">
              <span className="done-badge-check">✓</span>
            </div>
          )}

          {/* TRASH BADGE */}
          {showTrashBadge && (
            <div className="done-badge" aria-hidden="true">
              <span
                className="done-badge-check"
                style={{ fontSize: "18px" }}
              >
                🗑️
              </span>
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

  /* =====================================================
        ROOT NODE RENDERING + REMOVE-MODUS
  ===================================================== */
  function renderRootNode(root: Task, index: number, total: number) {
    const ang = (index / total) * Math.PI * 2;
    const rxBase = Math.cos(ang) * ROOT_RADIUS;
    const ryBase = Math.sin(ang) * ROOT_RADIUS;
    const ro = getOffset(root.id);
    const rx = rxBase + ro.x;
    const ry = ryBase + ro.y;

    const rootColor =
      branchColorOverride[root.id] ?? BRANCH_COLORS[index % BRANCH_COLORS.length];

    const explicitRootDone =
      typeof root.done === "boolean" ? root.done : undefined;

    const rootDone =
      explicitRootDone !== undefined ? explicitRootDone : centerDone;

    /* ---------- NEW: Badge-Logik ---------- */
    const showDoneBadge = !removeMode && rootDone;
    const showTrashBadge = removeMode && markedForRemoval.has(root.id);

    /* ---------- NEW: Klick ---------- */
    const onClickNode = (e: React.PointerEvent) => {
      if (removeMode) {
        e.stopPropagation();
        toggleMark(root.id);
      }
    };

    /* ---------- NEW: Kontextmenü blockiert ---------- */
    const onCtx = (e: React.MouseEvent) => {
      if (removeMode) {
        e.preventDefault();
        return;
      }
      onNodeContextMenu(e, root.id);
    };

    return (
      <React.Fragment key={`root-node-${root.id}`}>
        <div
          className="skill-node root-node"
          style={{
            transform: `translate(${rx}px, ${ry}px) translate(-50%, -50%)`,
            background: rootColor,
          }}
          data-done={rootDone ? "true" : "false"}
          onPointerDown={(e) => {
            if (!removeMode) startNodeDrag(root.id, e);
          }}
          onClick={onClickNode}
          onContextMenu={onCtx}
        >
          {showDoneBadge && (
            <div className="done-badge" aria-hidden="true">
              <span className="done-badge-check">✓</span>
            </div>
          )}

          {showTrashBadge && (
            <div className="done-badge" aria-hidden="true">
              <span className="done-badge-check" style={{ fontSize: "18px" }}>
                🗑️
              </span>
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
  }

  /* =====================================================
        CENTER NODE RENDERING + REMOVE-MODUS
  ===================================================== */
  function renderCenterNode() {
    const showDoneBadge = !removeMode && centerDone;
    const showTrashBadge = removeMode && markedForRemoval.has(CENTER_ID);

    const onClickCenter = (e: React.PointerEvent) => {
      if (removeMode) {
        e.stopPropagation();
        toggleMark(CENTER_ID);
      }
    };

    const onCtx = (e: React.MouseEvent) => {
      if (removeMode) {
        e.preventDefault();
        return;
      }
      openColorMenu(e.clientX, e.clientY, CENTER_ID);
    };

    return (
      <div
        className="skill-node center-node"
        style={{ background: centerColor }}
        data-done={centerDone ? "true" : "false"}
        onClick={onClickCenter}
        onContextMenu={onCtx}
      >
        {showDoneBadge && (
          <div className="done-badge" aria-hidden="true">
            <span className="done-badge-check">✓</span>
          </div>
        )}

        {showTrashBadge && (
          <div className="done-badge" aria-hidden="true">
            <span
              className="done-badge-check"
              style={{ fontSize: "18px" }}
            >
              🗑️
            </span>
          </div>
        )}

        {renderTitleAsSpans(projectTitle || "Project", MAXLEN_CENTER)}
      </div>
    );
  }




  /* =====================================================
        RENDER MAPVIEW JSX
  ===================================================== */
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
          {/* ----------------------------------------------------
               1) ROOT → CENTER LINE SVGs
          ---------------------------------------------------- */}
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

            {/* ----------------------------------------------------
                 2) CHILD-LINES rekursiv
            ---------------------------------------------------- */}
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

          {/* ----------------------------------------------------
               3) CENTER NODE
          ---------------------------------------------------- */}
          {renderCenterNode()}

          {/* ----------------------------------------------------
               4) ROOT & CHILD NODES
          ---------------------------------------------------- */}
          {roots.map((root, i) =>
            renderRootNode(root, i, Math.max(roots.length, 1))
          )}
        </div>
      </div>

      {/* ----------------------------------------------------
           5) PROGRESS HUD (nicht im Export sichtbar)
      ---------------------------------------------------- */}
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

      {/* ----------------------------------------------------
           6) FARBSWITCH / DONE-KONTEXTMENÜ 
           (im Remove-Modus komplett gesperrt!)
      ---------------------------------------------------- */}
      {ctxMenu.open && ctxMenu.taskId && !removeMode && (
        <div
          className="ctxmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
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

/* ---------- Export ---------- */
export default MapView;
