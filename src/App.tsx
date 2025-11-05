import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import DevBar from "./DevBar";

/* ---------- Types ---------- */
type Task = {
  id: string;
  title: string;
  parentId: string | null;
};

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

/* Colors for root branches (inherited by descendants) */
const BRANCH_COLORS = ["#f97316", "#6366f1", "#22c55e", "#eab308", "#0ea5e9", "#f43f5e"];

/* Node radii (match visual sizes incl. slight border overlap) */
const R_CENTER = 75;  // 150px center circle
const R_ROOT   = 60;  // 120px root circle
const R_CHILD  = 50;  // 100px child circle

/* Layout distances */
const ROOT_RADIUS = 280; // Abstand Root-Knoten vom Zentrum
const RING        = 130; // Abstand Kinder vom Parent

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

  /* ---------- Edit: Pointer-basierte DnD-State ---------- */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);

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

  /* Global pointer-up für Edit-DnD */
  useEffect(() => {
    function onPointerUp() {
      if (!draggingRef.current) return;
      if (hoverId) dropOn(hoverId);
      else dropToRoot();
    }
    function onPointerCancel() { if (draggingRef.current) finishDrag(); }
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [hoverId]);

  /* ---------- Visualize: manuelle Node-Offsets + Node-Drag ---------- */
  const [nodeOffset, setNodeOffset] = useState<Record<string, { x: number; y: number }>>({});
  const getOffset = (id: string) => nodeOffset[id] || { x: 0, y: 0 };
  const setOffset = (id: string, x: number, y: number) =>
    setNodeOffset(prev => ({ ...prev, [id]: { x, y } }));

  // Node-Drag-Session
  const vDrag = useRef<{
    id: string;
    startClient: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);
  const nodeDragging = useRef(false);

  function startNodeDrag(id: string, e: React.PointerEvent) {
    // Verhindert, dass das Map-Panning startet
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

  /* View toggle */
  const openMap = () => {
    if (!projectTitle.trim()) { alert("Please enter a project title first."); return; }
    setView("map");
  };

  /* Panning handlers (Visualize) */
  const onDown = (e: React.MouseEvent) => {
    // Panning nur starten, wenn NICHT gerade auf einem Node gedrückt wurde
    if (nodeDragging.current) return;
    panning.current = true;
    last.current = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: React.MouseEvent) => {
    if (!panning.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  };
  const onUp = () => { panning.current = false; };

  /* Zoom unter Cursor (Mausrad/Pinch) */
  function zoomAt(clientX: number, clientY: number, nextScale: number) {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) { setScale(nextScale); return; }

    const cx = clientX - rect.left;
    const cy = clientY - rect.top;

    // Weltkoords vor Zoom
    const wx = (cx - pan.x) / scale;
    const wy = (cy - pan.y) / scale;

    // Neues Pan, damit der gleiche Weltpunkt unterm Cursor bleibt
    const newPanX = cx - wx * nextScale;
    const newPanY = cy - wy * nextScale;

    setScale(nextScale);
    setPan({ x: newPanX, y: newPanY });
  }

  const onWheel = (e: React.WheelEvent) => {
    if (view !== "map") return;
    e.preventDefault();                 // Browser-Scroll unterbinden (innerhalb der Map)

    // Unterstützt normales Mausrad UND Pinch (Chrome/Edge: ctrlKey=true, deltaY je Richtung)
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const target = Math.min(MAX_Z, Math.max(MIN_Z, scale * factor));
    zoomAt(e.clientX, e.clientY, target);
  };

  /* Safari-Pinch zu Map-Zoom mappen */
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

  /* ---------- GLOBAL: Website-Zoom deaktivieren (außerhalb der Map) ---------- */
  useEffect(() => {
    const onGlobalWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      // Nur verhindern, wenn NICHT über der Map
      const path = (ev.composedPath && ev.composedPath()) || [];
      const insideMap = path.some((el) => (el as HTMLElement)?.classList?.contains?.("skillmap-wrapper"));
      if (!insideMap) ev.preventDefault();
      // Wenn insideMap: nicht blocken -> local onWheel verarbeitet Pinch als Map-Zoom
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "+" || ev.key === "-" || ev.key === "=" || ev.key === "0")) {
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

  /* Center: Zoom + Pan zurücksetzen (Standardansicht) */
  const resetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="app">
      <header className="topbar">
        <input
          className="project-input"
          value={projectTitle}
          onChange={(e) => setProjectTitle(e.target.value)}
          placeholder="Project title..."
        />
        <button className="btn" onClick={addTask}>Add Task</button>
        <div className="view-switch">
          <button className={view === "edit" ? "view-btn active" : "view-btn"} onClick={() => setView("edit")}>Edit</button>
        </div>
        <div className="view-switch">
          <button className={view === "map" ? "view-btn active" : "view-btn"} onClick={openMap}>Visualize</button>
        </div>
      </header>

      {/* Center-Button fest über der Map (nicht skaliert) */}
      {view === "map" && (
        <button
          className="center-btn"
          onClick={resetView}
          aria-label="Center"
        >
          Center
        </button>
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
                startDrag={startDrag}
                renameTask={renameTask}
              />
            ))}
          </div>
        ) : (
          <div
            className="skillmap-wrapper"
            ref={wrapperRef}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onWheel={onWheel}
          >
            {/* Skaliert und gepannt: nur die Map selbst */}
            <div
              className="map-pan"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                transformOrigin: "0 0"
              }}
            >
              <div className="map-origin">
                {/* ----- LINES (SVG) ----- */}
                <svg className="map-svg" viewBox="-2000 -2000 4000 4000">
                  {/* roots -> center (mit individuellen Offsets) */}
                  {roots.map((root, i) => {
                    const total = Math.max(roots.length, 1);
                    const ang = (i / total) * Math.PI * 2;
                    const rxBase = Math.cos(ang) * ROOT_RADIUS;
                    const ryBase = Math.sin(ang) * ROOT_RADIUS;
                    const ro = getOffset(root.id);
                    const rx = rxBase + ro.x;
                    const ry = ryBase + ro.y;
                    const { x1, y1, x2, y2 } = segmentBetweenCircles(0, 0, R_CENTER, rx, ry, R_ROOT);
                    const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
                    return (
                      <line key={`root-line-${root.id}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="3" strokeLinecap="round"/>
                    );
                  })}

                  {/* recursive children lines — Fächer-Layout + Offsets */}
                  {roots.flatMap((root, i) => {
                    const total = Math.max(roots.length, 1);
                    const ang = (i / total) * Math.PI * 2;
                    const rxBase = Math.cos(ang) * ROOT_RADIUS;
                    const ryBase = Math.sin(ang) * ROOT_RADIUS;
                    const ro = getOffset(root.id);
                    const rx = rxBase + ro.x;
                    const ry = ryBase + ro.y;
                    const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
                    return renderChildLinesWithOffsets(root.id, rx, ry, R_ROOT, color, childrenOf, 0, 0, getOffset);
                  })}
                </svg>

                {/* ----- NODES (DIVs) ----- */}
                <div className="skill-node center-node" lang={document.documentElement.lang || navigator.language || "en"}>
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
                  const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
                  return (
                    <React.Fragment key={`root-node-${root.id}`}>
                      <div
                        className="skill-node root-node"
                        style={{ transform: `translate(${rx}px, ${ry}px) translate(-50%, -50%)`, background: color }}
                        onPointerDown={(e) => startNodeDrag(root.id, e)}
                        lang={document.documentElement.lang || navigator.language || "en"}
                      >
                        {root.title}
                      </div>
                      {renderChildNodesWithOffsets(
                        root.id, rx, ry, color, childrenOf, 0, 0, getOffset, startNodeDrag
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Debug/Dev-Leiste für Health/Save/Load */}
      <DevBar />
    </div>
  );
}

/* ----- Edit row (recursive) ----- */
function Row({
  task, depth, tasks, draggingId, hoverId, setHoverId, startDrag, renameTask,
}: {
  task: Task; depth: number; tasks: Task[];
  draggingId: string | null;
  hoverId: string | null;
  setHoverId: (id: string | null) => void;
  startDrag: (id: string) => void;
  renameTask: (id: string, title: string) => void;
}) {
  const children = tasks.filter(t => t.parentId === task.id);

  const isDroppable = (srcId: string | null) =>
    !!srcId && srcId !== task.id && !isDescendant(tasks, task.id, srcId);

  return (
    <>
      <div
        className={`task-row ${isDroppable(draggingId) && hoverId === task.id ? "drop-hover" : ""} ${draggingId === task.id ? "dragging-row" : ""}`}
        style={{ paddingLeft: depth * 28 + "px" }}
        onPointerEnter={() => { if (isDroppable(draggingId)) setHoverId(task.id); }}
        onPointerLeave={() => { if (hoverId === task.id) setHoverId(null); }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const inInput = (e.target as HTMLElement).closest(".task-input");
          if (inInput) return;
          e.preventDefault();
          startDrag(task.id);
        }}
      >
        <span className="task-bullet" />
        <input
          className="task-input"
          value={task.title}
          onChange={(e) => renameTask(task.id, e.target.value)}
        />
        {task.parentId && <span className="task-parent-label">child</span>}
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
        />
      ))}
    </>
  );
}

/* ---------- Visualize: rekursives Zeichnen (LINES) mit Offsets ---------- */
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

/* ---------- Visualize: rekursives Zeichnen (NODES) mit Offsets ---------- */
function renderChildNodesWithOffsets(
  parentId: string,
  px: number, py: number,
  color: string,
  childrenOf: (id: string) => Task[],
  gpx: number, gpy: number,
  getOffset: (id: string) => { x: number; y: number },
  startNodeDrag: (id: string, e: React.PointerEvent) => void
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
        lang={document.documentElement.lang || navigator.language || "en"}
      >
        {kid.title}
      </div>
    );

    nodes.push(...renderChildNodesWithOffsets(kid.id, cx, cy, color, childrenOf, px, py, getOffset, startNodeDrag));
  });

  return nodes;
}
