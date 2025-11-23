// frontend/src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import MapView, { MapApi, Task as MapTask } from "./MapView";

type Task = MapTask;

type SavedState = {
  v: 1;
  projectTitle: string;
  tasks: Task[];
  nodeOffset: Record<string, { x: number; y: number }>;
  pan: { x: number; y: number };
  scale: number;
  ts: number;
  branchColorOverride?: Record<string, string>;
  centerColor?: string;
};

const makeId = () => Math.random().toString(36).slice(2, 9);

const slugifyTitle = (t: string) =>
  t.trim().replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();

const buildFileName = (projectTitle: string) =>
  `${slugifyTitle(projectTitle) || "taskmap"}.taskmap.json`;

function downloadJSON(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const serializeState = (
  projectTitle: string,
  tasks: Task[],
  nodeOffset: Record<string, { x: number; y: number }>,
  pan: { x: number; y: number },
  scale: number,
  branchColorOverride: Record<string, string>,
  centerColor: string
): SavedState => ({
  v: 1,
  projectTitle,
  tasks,
  nodeOffset,
  pan,
  scale,
  ts: Date.now(),
  branchColorOverride,
  centerColor
});

function isDescendant(
  tasks: Task[],
  possibleDescendant: string,
  possibleAncestor: string
) {
  let cur = tasks.find((t) => t.id === possibleDescendant);
  while (cur && cur.parentId) {
    if (cur.parentId === possibleAncestor) return true;
    cur = tasks.find((t) => t.id === cur!.parentId);
  }
  return false;
}

export default function App() {
  const [projectTitle, setProjectTitle] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<"edit" | "map">("edit");

  // Map State
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [nodeOffset, setNodeOffset] = useState({});
  const [branchColorOverride, setBranchColorOverride] = useState({});
  const [centerColor, setCenterColor] = useState("#020617");

  const roots = useMemo(
    () => tasks.filter((t) => t.parentId === null),
    [tasks]
  );

  //
  // REMOVE MODE
  //
  const [removeMode, setRemoveMode] = useState(false);
  const [removeSelected, setRemoveSelected] = useState<Set<string>>(
    new Set()
  );

  const toggleRemoveMode = () => {
    if (removeMode) {
      if (removeSelected.size > 0) {
        const collectSubtreeIds = (list: Task[], rootId: string) => {
          const out = new Set<string>([rootId]);
          const q = [rootId];
          while (q.length) {
            const cur = q.shift()!;
            for (const t of list) {
              if (t.parentId === cur && !out.has(t.id)) {
                out.add(t.id);
                q.push(t.id);
              }
            }
          }
          return out;
        };

        const fullDelete = new Set<string>();
        removeSelected.forEach((id) => {
          collectSubtreeIds(tasks, id).forEach((x) => fullDelete.add(x));
        });

        setTasks((prev) => prev.filter((t) => !fullDelete.has(t.id)));
      }

      setRemoveSelected(new Set());
      setRemoveMode(false);
      return;
    }

    setRemoveMode(true);
  };

  const toggleRemoveSelect = (id: string) => {
    if (!removeMode) return;
    setRemoveSelected((prev) => {
      const out = new Set(prev);
      out.has(id) ? out.delete(id) : out.add(id);
      return out;
    });
  };

  //
  // DnD ORIGINAL
  //
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);

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
    if (removeMode) return;
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
    if (removeMode) return finishDrag();
    const src = draggingRef.current;
    if (!src || src === targetId) return finishDrag();
    setTasks((prev) =>
      isDescendant(prev, targetId, src)
        ? prev
        : prev.map((t) =>
            t.id === src ? { ...t, parentId: targetId } : t
          )
    );
    finishDrag();
  }

  function dropToRoot() {
    if (removeMode) return finishDrag();
    const src = draggingRef.current;
    if (!src) return finishDrag();
    setTasks((prev) =>
      prev.map((t) =>
        t.id === src ? { ...t, parentId: null } : t
      )
    );
    finishDrag();
  }

  useEffect(() => {
    const onPointerUp = (e: PointerEvent) => {
      if (
        editGesture.current &&
        e.pointerId === editGesture.current.pointerId &&
        !editGesture.current.started
      )
        editGesture.current = null;

      if (!draggingRef.current) return;
      hoverId ? dropOn(hoverId) : dropToRoot();
    };

    const onPointerCancel = () => {
      if (draggingRef.current) finishDrag();
    };

    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);

    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [hoverId, removeMode]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (view !== "edit" || removeMode) return;

      if (
        editGesture.current &&
        e.pointerId === editGesture.current.pointerId &&
        !editGesture.current.started
      ) {
        const dx = e.clientX - editGesture.current.startX;
        const dy = e.clientY - editGesture.current.startY;

        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          editGesture.current.rowEl.setPointerCapture?.(
            editGesture.current.pointerId
          );
          e.preventDefault();
          startDrag(editGesture.current.taskId);
          editGesture.current.started = true;
        }
      }

      if (!draggingRef.current) return;
      const el = document.elementFromPoint(
        e.clientX,
        e.clientY
      ) as HTMLElement | null;

      const row = el?.closest?.(".task-row") as HTMLElement | null;
      setHoverId(row?.dataset?.taskId || null);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [view, removeMode]);

  const addTask = () =>
    setTasks((prev) => [
      ...prev,
      {
        id: "t-" + makeId(),
        title: `Task ${prev.length + 1}`,
        parentId: null
      }
    ]);

  const renameTask = (id: string, title: string) =>
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, title } : t
      )
    );

  const removeLastTask = () => {};

  const openMap = () => {
    if (!projectTitle.trim()) setProjectTitle("Project");
    setView("map");
  };




function Row({
  task, depth, tasks,
  draggingId, hoverId, setHoverId,
  startDrag, renameTask,
  editGesture, LONGPRESS_MS,
  removeMode, removeSelected, toggleRemoveSelect
}: {
  task: Task;
  depth: number;
  tasks: Task[];
  draggingId: string | null;
  hoverId: string | null;
  setHoverId: (id: string | null) => void;
  startDrag: (id: string) => void;
  renameTask: (id: string, title: string) => void;
  editGesture: React.MutableRefObject<{
    pointerId: number; rowEl: HTMLElement;
    startX: number; startY: number;
    started: boolean; taskId: string;
  } | null>;
  LONGPRESS_MS: number;
  removeMode: boolean;
  removeSelected: Set<string>;
  toggleRemoveSelect: (id: string) => void;
}) {
  const children = tasks.filter(t => t.parentId === task.id);

  const isDroppable = (srcId: string | null) =>
    !!srcId &&
    srcId !== task.id &&
    !isDescendant(tasks, task.id, srcId);

  const longPressTimer = useRef<number | null>(null);

  const clearTimer = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  //
  // -----------------------------------------------------------------------------------
  // DRAG-ZONE (KORRIGIERT FÜR REMOVE MODE)
  // -----------------------------------------------------------------------------------
  //
  const handlePointerDownDragZone = (e: React.PointerEvent) => {
    // Remove-Mode → keine Drag-Initialisierung
    if (removeMode) return;

    const rowEl = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const id = rowEl.dataset.taskId!;

    editGesture.current = {
      pointerId: e.pointerId,
      rowEl,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      taskId: id
    };

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    clearTimer();
    longPressTimer.current = window.setTimeout(() => {
      if (!removeMode &&
        editGesture.current &&
        !editGesture.current.started
      ) {
        startDrag(id);
        editGesture.current.started = true;
      }
    }, LONGPRESS_MS);
  };

  const handlePointerUpAnywhere = (e: React.PointerEvent) => {
    clearTimer();
    if (
      editGesture.current &&
      e.pointerId === editGesture.current.pointerId &&
      !editGesture.current.started
    ) {
      editGesture.current = null;
    }
  };
  //
  // -----------------------------------------------------------------------------------
  // REMOVE-CLICK HANDLER (beide Maustasten)
  // -----------------------------------------------------------------------------------
  //
  const isMarked = removeSelected.has(task.id);

  const handleRemoveClick = (e: React.PointerEvent) => {
    if (!removeMode) return;
    e.stopPropagation();        // verhindert Drag-Start oder Text-Fokus
    toggleRemoveSelect(task.id);
  };

  //
  // -----------------------------------------------------------------------------------
  // RETURN
  // -----------------------------------------------------------------------------------
  //
  return (
    <>
      <div
        className={
          `task-row ${
            !removeMode &&
            isDroppable(draggingId) &&
            hoverId === task.id
              ? "drop-hover"
              : ""
          } ${
            draggingId === task.id ? "dragging-row" : ""
          }`
        }

        style={{ paddingLeft: depth * 28 }}
        data-task-id={task.id}

        onPointerDown={(e) => {
          const target = e.target as HTMLElement;

          // REMOVE-MODUS: Linksklick & Rechtsklick → auswählen
          if (removeMode) {
            handleRemoveClick(e);
            return;
          }

          // NORMALER EDIT-MODUS
          if (target.closest(".task-input")) return;

          if (e.pointerType === "mouse") {
            startDrag(task.id);
          }
        }}

        onClick={(e) => {
          if (removeMode) {
            handleRemoveClick(e);
          }
        }}

        onPointerEnter={() => {
          if (!removeMode && isDroppable(draggingId)) {
            setHoverId(task.id);
          }
        }}

        onPointerLeave={() => {
          if (hoverId === task.id) setHoverId(null);
        }}

        onPointerUp={handlePointerUpAnywhere}
      >
        {/* --------------------------------------- */}
        {/* DRAG HANDLE LEFT                       */}
        {/* --------------------------------------- */}
        <span
          className="drag-handle left"
          onPointerDown={(e) => {
            if (removeMode) {
              handleRemoveClick(e);
              return;
            }
            handlePointerDownDragZone(e);
          }}
        />

        {/* --------------------------------------- */}
        {/* BULLET — wird rot im Remove-Mode       */}
        {/* --------------------------------------- */}
        <span
          className="task-bullet"
          style={{
            backgroundColor: removeMode
              ? (isMarked ? "#dc2626" : "#000000")
              : "#000000"
          }}
          onPointerDown={(e) => {
            if (removeMode) {
              handleRemoveClick(e);
              return;
            }
            handlePointerDownDragZone(e);
          }}
        />

        {/* --------------------------------------- */}
        {/* TASK TITLE INPUT                       */}
        {/* --------------------------------------- */}
        <input
          className="task-input"
          value={task.title}
          onChange={(e) => renameTask(task.id, e.target.value)}
          placeholder="Task title…"
        />

        {/* --------------------------------------- */}
        {/* Child-Label                             */}
        {/* --------------------------------------- */}
        {task.parentId && (
          <span className="task-parent-label">child</span>
        )}

        {/* --------------------------------------- */}
        {/* DRAG HANDLE RIGHT                      */}
        {/* --------------------------------------- */}
        <span
          className="drag-handle right"
          onPointerDown={(e) => {
            if (removeMode) {
              handleRemoveClick(e);
              return;
            }
            handlePointerDownDragZone(e);
          }}
        />
      </div>

      {/* --------------------------------------- */}
      {/* CHILDREN                                */}
      {/* --------------------------------------- */}
      {children.map((c) => (
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
          removeMode={removeMode}
          removeSelected={removeSelected}
          toggleRemoveSelect={toggleRemoveSelect}
        />
      ))}
    </>
  );
}
