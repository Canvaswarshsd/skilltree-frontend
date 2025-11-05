import { useEffect, useRef, useState } from "react";
import { apiHealth, loadMap, saveMap, type TaskMapData } from "./api";

type Status = { kind: "idle" | "ok" | "err"; msg?: string };

export default function DevBar() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [mapName, setMapName] = useState<string>("demo");
  const [data, setData] = useState<TaskMapData>({ nodes: [], edges: [], meta: {} });
  const [autoSave, setAutoSave] = useState<boolean>(false);
  const autoTimer = useRef<number | null>(null);

  // optional: Autosave alle 3s, wenn aktiviert
  useEffect(() => {
    if (!autoSave) {
      if (autoTimer.current) window.clearInterval(autoTimer.current);
      autoTimer.current = null;
      return;
    }
    autoTimer.current = window.setInterval(() => {
      saveMap(mapName.trim() || "demo", data)
        .then(() => setStatus({ kind: "ok", msg: "autosaved" }))
        .catch((e) => setStatus({ kind: "err", msg: e?.message || String(e) }));
    }, 3000);
    return () => {
      if (autoTimer.current) window.clearInterval(autoTimer.current);
      autoTimer.current = null;
    };
  }, [autoSave, mapName, data]);

  async function onHealth() {
    try {
      const j = await apiHealth();
      setStatus({ kind: "ok", msg: JSON.stringify(j) });
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.message ?? String(e) });
    }
  }

  async function onSave() {
    try {
      const name = mapName.trim() || "demo";
      await saveMap(name, data);
      setStatus({ kind: "ok", msg: `saved: ${name}` });
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.message ?? String(e) });
    }
  }

  async function onLoad() {
    try {
      const name = mapName.trim() || "demo";
      const j = await loadMap(name);
      setData(j);
      setStatus({ kind: "ok", msg: `loaded: ${name}` });
      // 👉 HIER könntest du j in deine eigentliche Canvas/State übernehmen
      // z.B. dispatch({type:'LOAD_FROM_JSON', payload:j})
    } catch (e: any) {
      setStatus({ kind: "err", msg: e?.message ?? String(e) });
    }
  }

  // Demo: füge schnell einen Node hinzu, damit du Save/Load siehst
  function addDemoNode() {
    const n = { id: "n" + (data.nodes.length + 1), label: "Demo " + (data.nodes.length + 1) };
    setData({ ...data, nodes: [...data.nodes, n] });
    setStatus({ kind: "ok", msg: `node added (${n.id})` });
  }

  const badgeBg =
    status.kind === "ok" ? "#19c37d" : status.kind === "err" ? "#ef4444" : "#475569";

  return (
    <div
      className="devbar"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 9999,
        display: "flex",
        gap: 8,
        alignItems: "center",
        background: "#0f172a",
        padding: "10px 12px",
        borderRadius: 10,
        boxShadow: "0 6px 18px rgba(0,0,0,0.25)"
      }}
    >
      <input
        value={mapName}
        onChange={(e) => setMapName(e.target.value)}
        placeholder="map name"
        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #334155", background:"#0b1220", color:"#e2e8f0" }}
      />
      <button onClick={onHealth}>Health</button>
      <button onClick={addDemoNode}>+Node</button>
      <button onClick={onSave}>Save</button>
      <button onClick={onLoad}>Load</button>
      <label style={{ color:"#e2e8f0", display:"flex", gap:6, alignItems:"center", marginLeft:6 }}>
        <input type="checkbox" checked={autoSave} onChange={(e)=>setAutoSave(e.target.checked)} />
        AutoSave
      </label>
      <span style={{ padding: "6px 8px", borderRadius: 6, background: badgeBg, color: "#fff", marginLeft: 6, minWidth: 80, textAlign: "center" }}>
        {status.msg ?? status.kind}
      </span>
    </div>
  );
}
