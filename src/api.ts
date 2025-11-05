// Simple API-Wrapper für dein lokales Backend (Proxy auf /api -> 8787)

export type TaskMapData = {
  nodes: Array<any>;
  edges: Array<any>;
  meta: Record<string, any>;
};

export async function apiHealth(): Promise<{ ok: boolean }> {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error("health " + r.status);
  return r.json();
}

export async function loadMap(name: string): Promise<TaskMapData> {
  const r = await fetch(`/api/maps/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error("load " + r.status);
  return r.json();
}

export async function saveMap(name: string, data: TaskMapData): Promise<{ saved: true }> {
  const r = await fetch(`/api/maps/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? { nodes: [], edges: [], meta: {} }),
  });
  if (!r.ok) throw new Error("save " + r.status);
  return r.json();
}
