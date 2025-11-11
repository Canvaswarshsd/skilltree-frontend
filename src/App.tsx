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
  t.trim().replace(/[^\w\-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase();

const buildFileName = (projectTitle: string) => `${slugifyTitle(projectTitle) || "taskmap"}.taskmap.json`;

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
  centerColor,
});

function isDescendant(tasks: Task[], possibleDescendant: string, possibleAncestor: string) {
  let cur = tasks.find(t => t.id === possibleDescendant);
  while (cur && cur.parentId) {
    if (cur.parentId === possibleAncestor) return true;
    cur = tasks.find(t => t.id === cur!.parentId);
  }
  return false;
}

/* ========= Pixelgenaue Zeilenumbruch-/Hyphen-Logik für Edit-Vorschau ========= */
const PREVIEW_NODE_W = 120;
const PREVIEW_NODE_PADDING_X = 12; // wie .skill-node/.circle-preview
const PREVIEW_MAX_LINE_W = PREVIEW_NODE_W - PREVIEW_NODE_PADDING_X * 2; // 96px
const PREVIEW_FONT = "700 0.9rem system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

let _measureCanvas: HTMLCanvasElement | null = null;
function measureTextPx(text: string): number {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d")!;
  ctx.font = PREVIEW_FONT;
  return ctx.measureText(text).width;
}

/** Teilt einen zu langen „Wort“-Chunk so, dass Teil + "-" noch in die Zeile passt. */
function splitWordWithHyphen(word: string, maxWidth: number): { head: string; tail: string } {
  // Sicherheitskappen (mind. 2 Zeichen vor/nach Bindestrich, falls möglich)
  const MIN_HEAD = Math.min(2, word.length);
  const MIN_TAIL = Math.min(2, word.length - MIN_HEAD);
  if (measureTextPx(word) + measureTextPx("-") <= maxWidth) return { head: word, tail: "" };

  let lo = MIN_HEAD, hi = word.length - MIN_TAIL, best = MIN_HEAD;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = measureTextPx(word.slice(0, mid) + "-");
    if (w <= maxWidth) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  const head = word.slice(0, best) + "-";
  const tail = word.slice(best);
  return { head, tail };
}

/** Wrapt einen Titel in Zeilen. Nur wenn ein Wort nicht passt, wird mit „-“ getrennt. */
function wrapLabelToLines(title: string, maxWidth = PREVIEW_MAX_LINE_W): string[] {
  const lines: string[] = [];
  let current = "";

  const tokens = title.split(/\s+/); // Wortgrenzen
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (!word) continue;

    // passt das Wort (mit vorangestelltem Space falls nötig) in die aktuelle Zeile?
    const prefix = current.length ? " " : "";
    if (measureTextPx(current + prefix + word) <= maxWidth) {
      current = current + prefix + word;
      continue;
    }

    // Wort passt nicht – wir müssen umbrechen/hyphenieren
    if (current) {
      lines.push(current);
      current = "";
    }

    let rest = word;
    // Ein Wort kann über mehrere Zeilen hyphenisiert werden
    while (rest) {
      if (measureTextPx(rest) <= maxWidth) {
        current = rest;
        rest = "";
      } else {
        const { head, tail } = splitWordWithHyphen(rest, maxWidth);
        lines.push(head); // head endet mit "-"
        rest = tail;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* Optionale Sprachheuristik (falls du später noch brauchst) */
function detectLang(text: string): "de" | "en" {
  const s = (text || "").trim();
  if (!s) return "de";
  if (/[äöüÄÖÜß]/.test(s)) return "de";
  const deHits = (s.toLowerCase().match(/\b(und|oder|für|mit|ohne|nicht|zum|zur|ein|eine|der|die|das|den)\b/g) || []).length;
  const enHits = (s.toLowerCase().match(/\b(the|and|for|with|without|not|to|of|in|on|a|an)\b/g) || []).length;
  if (deHits > enHits) return "de";
  if (enHits > deHits) return "en";
  if (/^[\x00-\x7F]+$/.test(s)) return "en";
  return "de";
}

export default function App() {
  const [projectTitle, setProjectTitle] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<"edit" | "map">("edit");

  // Map-States (controlled)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [nodeOffset, setNodeOffset] = useState<Record<string, { x: number; y: number }>>({});
  const [branchColorOverride, setBranchColorOverride] = useState<Record<string, string>>({});
  const [centerColor, setCenterColor] = useState<string>("#020617");

  const roots = useMemo(() => tasks.filter(t => t.parentId === null), [tasks]);

  // Edit: Add/Rename/Remove
  const addTask = () => setTasks(prev => [...prev, { id: "t-" + makeId(), title: `Task ${prev.length + 1}`, parentId: null }]);
  const renameTask = (id: string, title: string) => setTasks(prev => prev.map(t => (t.id === id ? { ...t, title } : t)));
  const collectSubtreeIds = (list: Task[], rootId: string) => {
    const out = new Set<string>([rootId]);
    const q = [rootId];
    while (q.length) {
      const cur = q.shift()!;
      for (const t of list) if (t.parentId === cur && !out.has(t.id)) { out.add(t.id); q.push(t.id); }
    }
    return out;
  };
  const removeLastTask = () => {
    if (!tasks.length) return;
    const lastTask = tasks[tasks.length - 1];
    const toRemove = collectSubtreeIds(tasks, lastTask.id);
    setTasks(prev => prev.filter(t => !toRemove.has(t.id)));
  };

  // Edit: DnD in Liste (gleiches Verhalten wie vorher)
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
    if (!src || src === targetId) return finishDrag();
    setTasks(prev => (isDescendant(prev, targetId, src) ? prev : prev.map(t => (t.id === src ? { ...t, parentId: targetId } : t))));
    finishDrag();
  }
  function dropToRoot() {
    const src = draggingRef.current;
    if (!src) return finishDrag();
    setTasks(prev => prev.map(t => (t.id === src ? { ...t, parentId: null } : t)));
    finishDrag();
  }

  useEffect(() => {
    const onPointerUp = (e: PointerEvent) => {
      if (editGesture.current && e.pointerId === editGesture.current.pointerId && !editGesture.current.started) editGesture.current = null;
      if (!draggingRef.current) return;
      hoverId ? dropOn(hoverId) : dropToRoot();
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (editGesture.current && e.pointerId === editGesture.current.pointerId) editGesture.current = null;
      if (draggingRef.current) finishDrag();
    };
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
        const dx = e.clientX - editGesture.current.startX, dy = e.clientY - editGesture.current.startY;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          editGesture.current.rowEl.setPointerCapture?.(editGesture.current.pointerId);
          e.preventDefault();
          startDrag(editGesture.current.taskId);
          editGesture.current.started = true;
        }
      }
      if (!draggingRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const row = el?.closest?.(".task-row") as HTMLElement | null;
      setHoverId(row?.dataset?.taskId || null);
    };
    window.addEventListener("pointermove", onDocPointerMoveEdit, { passive: true });
    return () => window.removeEventListener("pointermove", onDocPointerMoveEdit);
  }, [view]);

  const openMap = () => { if (!projectTitle.trim()) setProjectTitle("Project"); setView("map"); };

  // Save / Open
  const [saveOpen, setSaveOpen] = useState(false);
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);
  const [savePos, setSavePos] = useState<{ top: number; left: number } | null>(null);

  const openSaveMenu = () => {
    const r = saveBtnRef.current?.getBoundingClientRect();
    if (!r) return setSaveOpen(v => !v);
    setSavePos({ top: r.bottom + 6, left: r.right });
    setSaveOpen(true);
  };
  const toggleSaveMenu = () => setSaveOpen(prev => (prev ? false : (openSaveMenu(), true)));

  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);

  const doSave = async () => {
    setSaveOpen(false);
    const state = serializeState(projectTitle, tasks, nodeOffset, pan, scale, branchColorOverride, centerColor);
    try {
      if (fileHandle && "createWritable" in fileHandle) {
        const writable = await (fileHandle as any).createWritable();
        await writable.write(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
        await writable.close();
        return;
      }
    } catch {}
    downloadJSON(buildFileName(projectTitle), state);
  };

  const doSaveAs = async () => {
    setSaveOpen(false);
    const state = serializeState(projectTitle, tasks, nodeOffset, pan, scale, branchColorOverride, centerColor);
    try {
      if ("showSaveFilePicker" in window) {
        const handle = await (window as any).showSaveFilePicker({
          id: "taskmap-saveas",
          suggestedName: buildFileName(projectTitle),
          startIn: "downloads",
          types: [{ description: "TaskMap Project", accept: { "application/json": [".taskmap.json"] } }],
        });
        setFileHandle(handle);
        const w = await handle.createWritable();
        await w.write(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
        await w.close();
        return;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
    }
    downloadJSON(buildFileName(projectTitle), state);
    setFileHandle(null);
  };

  function loadFromJSON(data: any) {
    const obj = data as Partial<SavedState>;
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.tasks)) {
      alert("Could not open file. Is this a valid .taskmap.json?");
      return;
    }
    setProjectTitle(String(obj.projectTitle ?? "Project"));
    setTasks(obj.tasks as Task[]);
    setPan(obj.pan ?? { x: 0, y: 0 });
    setScale(typeof obj.scale === "number" ? obj.scale : 1);
    setNodeOffset(obj.nodeOffset ?? {});
    setBranchColorOverride(obj.branchColorOverride ?? {});
    setCenterColor(obj.centerColor ?? "#020617");
    setView("map");
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
        loadFromJSON(JSON.parse(await file.text()));
        setFileHandle(handle as FileSystemFileHandle);
        return;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".taskmap.json,application/json";
    input.onchange = (ev: any) => {
      const f = ev.target.files?.[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { try { loadFromJSON(JSON.parse(String(reader.result))); } catch { alert("Could not open file."); } };
      reader.readAsText(f);
    };
    input.click();
  };

  // Download dropdown -> MapView API
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadBtnRef = useRef<HTMLButtonElement | null>(null);
  const [downloadPos, setDownloadPos] = useState<{ top: number; left: number } | null>(null);
  const openDownloadMenu = () => {
    const r = downloadBtnRef.current?.getBoundingClientRect();
    if (!r) return setDownloadOpen(v => !v);
    setDownloadPos({ top: r.bottom + 6, left: r.right });
    setDownloadOpen(true);
  };
  const toggleDownloadMenu = () => setDownloadOpen(prev => (prev ? false : (openDownloadMenu(), true)));

  const mapRef = useRef<MapApi>(null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-scroll">
          <input className="project-input" value={projectTitle} onChange={e => setProjectTitle(e.target.value)} placeholder="Project title..." />
          <button className="btn" onClick={addTask}>Add Task</button>
          <button className="btn btn-remove" onClick={removeLastTask} title="Remove last task (and its children)">Remove Task</button>
          <button className={view === "map" ? "view-btn active" : "view-btn"} onClick={openMap}>Visualize</button>

          <div className="save-wrap">
            <button ref={saveBtnRef} className="btn btn-save" onClick={toggleSaveMenu}>Save</button>
            {saveOpen && savePos && (
              <div className="save-menu" role="menu" style={{ top: savePos.top, left: savePos.left, transform: "translateX(-100%)" }} onMouseLeave={() => setSaveOpen(false)}>
                <button className="save-item" onClick={doSave}>Save</button>
                <button className="save-item" onClick={doSaveAs}>Save As…</button>
              </div>
            )}
          </div>

          <button className={view === "edit" ? "view-btn active" : "view-btn"} onClick={() => setView("edit")}>Edit</button>
          <button className="view-btn" onClick={doOpen}>Open</button>

          <div className="save-wrap">
            <button ref={downloadBtnRef} className="view-btn" onClick={toggleDownloadMenu}>Download</button>
            {downloadOpen && downloadPos && (
              <div className="save-menu" role="menu" style={{ top: downloadPos.top, left: downloadPos.left, transform: "translateX(-100%)" }} onMouseLeave={() => setDownloadOpen(false)}>
                <button className="save-item" onClick={() => mapRef.current?.exportPDF()}>PDF</button>
                <button className="save-item" onClick={() => mapRef.current?.exportJPG()}>JPG</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {view === "map" && (
        <button className="center-btn" onClick={() => mapRef.current?.resetView()} aria-label="Center">Center</button>
      )}

      <div className="body">
        {view === "edit" ? (
          <div className="task-list">
            <h2 className="section-title" />
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
                editGesture={editGesture}
                LONGPRESS_MS={LONGPRESS_MS}
              />
            ))}
          </div>
        ) : (
          <MapView
            ref={mapRef}
            active={view === "map"}
            projectTitle={projectTitle}
            tasks={tasks}
            setTasks={setTasks}
            nodeOffset={nodeOffset} setNodeOffset={setNodeOffset}
            pan={pan} setPan={setPan}
            scale={scale} setScale={setScale}
            branchColorOverride={branchColorOverride} setBranchColorOverride={setBranchColorOverride}
            centerColor={centerColor} setCenterColor={setCenterColor}
          />
        )}
      </div>
    </div>
  );
}

function Row({
  task, depth, tasks, draggingId, hoverId, setHoverId, startDrag, renameTask, editGesture, LONGPRESS_MS
}: {
  task: Task; depth: number; tasks: Task[];
  draggingId: string | null; hoverId: string | null;
  setHoverId: (id: string | null) => void;
  startDrag: (id: string) => void;
  renameTask: (id: string, title: string) => void;
  editGesture: React.MutableRefObject<{
    pointerId: number; rowEl: HTMLElement; startX: number; startY: number; started: boolean; taskId: string;
  } | null>;
  LONGPRESS_MS: number;
}) {
  const children = tasks.filter(t => t.parentId === task.id);
  const isDroppable = (srcId: string | null) => !!srcId && srcId !== task.id && !isDescendant(tasks, task.id, srcId);

  const longPressTimer = useRef<number | null>(null);
  const clearTimer = () => { if (longPressTimer.current !== null) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; } };

  const handlePointerDownDragZone = (e: React.PointerEvent) => {
    const rowEl = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
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

  const previewLines = useMemo(() => wrapLabelToLines(task.title), [task.title]);

  return (
    <>
      <div
        className={`task-row ${isDroppable(draggingId) && hoverId === task.id ? "drop-hover" : ""} ${draggingId === task.id ? "dragging-row" : ""}`}
        style={{ paddingLeft: depth * 28 }}
        data-task-id={task.id}
        onPointerEnter={() => { if (isDroppable(draggingId)) setHoverId(task.id); }}
        onPointerLeave={() => { if (hoverId === task.id) setHoverId(null); }}
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest(".task-input")) return;
          if (e.pointerType === "mouse") startDrag(task.id);
        }}
        onPointerUp={handlePointerUpAnywhere}
      >
        <span className="drag-handle left" onPointerDown={handlePointerDownDragZone} />
        <span className="task-bullet" onPointerDown={handlePointerDownDragZone} />
        <input
          className="task-input"
          value={task.title}
          onChange={e => renameTask(task.id, e.target.value)}
          placeholder="Task title…"
          lang={detectLang(task.title)}
        />
        {task.parentId && <span className="task-parent-label">child</span>}
        <span className="drag-handle right" onPointerDown={handlePointerDownDragZone} />
      </div>

      {/* Kreis-Vorschau direkt unter der Zeile */}
      <div className="preview-wrap" style={{ paddingLeft: depth * 28 }}>
        <div className="circle-preview">
          <div className="preview-label" aria-hidden>
            {previewLines.map((ln, i) => (
              <div key={i}>{ln}</div>
            ))}
          </div>
        </div>
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
