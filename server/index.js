import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// 🔐 OBO + Graph: Wir fügen das gleich in Schritt 4 ein.
// Für jetzt: Fake-Speicher im Speicher (nur zum „läuft“-Testen)
const RAM_STORE = new Map();

// Map laden
app.get("/api/maps/:name", async (req, res) => {
  const key = req.params.name || "default";
  const content = RAM_STORE.get(key) ?? { nodes: [], edges: [], meta: {} };
  res.json(content);
});

// Map speichern
app.put("/api/maps/:name", async (req, res) => {
  const key = req.params.name || "default";
  RAM_STORE.set(key, req.body ?? {});
  res.json({ saved: true });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`TaskMap server running on :${PORT}`));
