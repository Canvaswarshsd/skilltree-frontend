import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";

import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerSrc as unknown as string;

export type TaskAttachment = {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
};

type Props = {
  open: boolean;
  title: string;
  attachments: TaskAttachment[];
  selectedAttachmentId: string | null;
  onSelectAttachment: (id: string) => void;
  onClose: () => void;
};

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const parts = dataUrl.split(",");
  const b64 = parts[1] || "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// PDF-MIME erzwingen, damit Browser das als PDF rendert (nicht als "download me")
function attachmentToPdfBlob(att: TaskAttachment): Blob {
  const bytes = dataUrlToUint8Array(att.dataUrl);
  return new Blob([bytes], { type: "application/pdf" });
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "attachment.pdf";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export default function PdfPreviewOverlay(props: Props) {
  const {
    open,
    title,
    attachments,
    selectedAttachmentId,
    onSelectAttachment,
    onClose,
  } = props;

  const selected = useMemo(() => {
    if (!attachments.length) return null;
    if (!selectedAttachmentId) return attachments[attachments.length - 1];
    return (
      attachments.find((a) => a.id === selectedAttachmentId) ??
      attachments[attachments.length - 1]
    );
  }, [attachments, selectedAttachmentId]);

  const pagesHostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [containerW, setContainerW] = useState(0);

  // Body scroll lock + ESC to close
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Measure viewport width (ResizeObserver)
  useEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (!el) return;

    let raf = 0;

    const update = () => {
      const w = el.clientWidth || 0;
      setContainerW((prev) => (Math.abs(prev - w) >= 1 ? w : prev));
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };

    schedule();

    const ro = new ResizeObserver(() => schedule());
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [open]);

  // Render PDF with PDF.js
  useEffect(() => {
    if (!open) return;
    if (!selected) return;
    if (!containerW) return;

    let cancelled = false;
    const renderTasks: any[] = [];
    let loadingTask: any = null;

    const render = async () => {
      setErr(null);
      setLoading(true);
      setNumPages(0);

      const host = pagesHostRef.current;
      if (host) host.innerHTML = "";

      try {
        const data = dataUrlToUint8Array(selected.dataUrl);

        loadingTask = getDocument({ data });
        const pdf: PDFDocumentProxy = await loadingTask.promise;
        if (cancelled) return;

        setNumPages(pdf.numPages);

        // scale to fit width (with padding)
        const innerW = Math.max(240, containerW - 24);

        const first = await pdf.getPage(1);
        const vp1 = first.getViewport({ scale: 1 });
        const baseScale = innerW / (vp1.width || 1);
        const scaleCss = clamp(baseScale, 0.55, 1.6);

        const dpr = clamp(window.devicePixelRatio || 1, 1, 2);

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;

          const page = i === 1 ? first : await pdf.getPage(i);

          const vpCss = page.getViewport({ scale: scaleCss });
          const vpRender = page.getViewport({ scale: scaleCss * dpr });

          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(vpRender.width));
          canvas.height = Math.max(1, Math.floor(vpRender.height));
          canvas.style.width = `${Math.floor(vpCss.width)}px`;
          canvas.style.height = `${Math.floor(vpCss.height)}px`;
          canvas.style.borderRadius = "10px";
          canvas.style.boxShadow = "0 10px 30px rgba(0,0,0,0.12)";
          canvas.style.background = "#fff";

          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) throw new Error("Canvas not supported");

          const wrap = document.createElement("div");
          wrap.style.display = "flex";
          wrap.style.justifyContent = "center";
          wrap.style.padding = "10px 0";
          wrap.appendChild(canvas);
          host?.appendChild(wrap);

          const rt = page.render({ canvasContext: ctx, viewport: vpRender });
          renderTasks.push(rt);

          try {
            await rt.promise;
          } catch (e: any) {
            if (e?.name === "RenderingCancelledException") return;
            throw e;
          }
        }
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Failed to render PDF.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    render();

    return () => {
      cancelled = true;
      for (const rt of renderTasks) {
        try {
          rt?.cancel?.();
        } catch {}
      }
      try {
        loadingTask?.destroy?.();
      } catch {}
    };
  }, [open, selected?.id, containerW]);

  // If open but no attachments -> auto close (defensive)
  useEffect(() => {
    if (!open) return;
    if (!attachments.length) onClose();
  }, [open, attachments.length, onClose]);

  const onDownloadSelected = () => {
    if (!selected) return;
    try {
      const blob = attachmentToPdfBlob(selected);
      downloadBlob(selected.name || "attachment.pdf", blob);
    } catch {
      window.alert("Download failed. Please try again.");
    }
  };

  // IMPORTANT: Kein Download-Fallback. Entweder Tab geht auf, oder wir sagen "Popup blocked".
  const onOpenSelectedInNewTab = () => {
    if (!selected) return;

    let url: string | null = null;

    try {
      const blob = attachmentToPdfBlob(selected);
      url = URL.createObjectURL(blob);

      // Popup-Blocker umgehen: sofort leeren Tab öffnen (User-Gesture), dann URL setzen
      const w = window.open("", "_blank");
      if (!w) {
        if (url) URL.revokeObjectURL(url);
        window.alert(
          "Could not open a new tab (popup blocked). Please allow popups for this site."
        );
        return;
      }

      try {
        // best-effort security
        // @ts-ignore
        w.opener = null;
      } catch {}

      w.location.href = url;
      w.focus?.();

      window.setTimeout(() => {
        if (url) URL.revokeObjectURL(url);
      }, 60_000);
    } catch {
      if (url) URL.revokeObjectURL(url);
      window.alert("Open in New Tab failed. Please try again.");
    }
  };

  if (!open) return null;

  const headerBtnStyle: React.CSSProperties = {
    appearance: "none",
    border: "none",
    background: "rgba(255,255,255,0.10)",
    color: "#e5e7eb",
    borderRadius: 12,
    padding: "8px 12px",
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={() => onClose()}
      onTouchStart={() => onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000000,
        background: "rgba(2,6,23,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 14,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        style={{
          width: "min(980px, 94vw)",
          height: "min(780px, 86vh)",
          background: "rgba(15, 23, 42, 0.92)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 18,
          boxShadow: "0 20px 70px rgba(0,0,0,0.35)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                color: "#e5e7eb",
                fontWeight: 900,
                fontSize: 13,
                letterSpacing: "0.2px",
                opacity: 0.9,
              }}
            >
              {title || "PDF"}
            </div>
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>
              {selected?.name || "attachment.pdf"}
              {numPages ? ` • ${numPages} page${numPages === 1 ? "" : "s"}` : ""}
            </div>
          </div>

          <button
            onClick={onOpenSelectedInNewTab}
            style={headerBtnStyle}
            disabled={!selected}
            title="Open the selected PDF in a new tab"
          >
            Open in New Tab
          </button>

          <button
            onClick={onDownloadSelected}
            style={headerBtnStyle}
            disabled={!selected}
            title="Download the selected PDF"
          >
            Download
          </button>

          <button onClick={onClose} style={headerBtnStyle}>
            Close
          </button>
        </div>

        {/* Attachment switcher */}
        {attachments.length > 1 && (
          <div
            style={{
              padding: "10px 12px",
              display: "flex",
              gap: 8,
              overflowX: "auto",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {attachments.map((a) => {
              const active = a.id === selected?.id;
              return (
                <button
                  key={a.id}
                  onClick={() => onSelectAttachment(a.id)}
                  style={{
                    flex: "0 0 auto",
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: active
                      ? "rgba(255,255,255,0.14)"
                      : "rgba(255,255,255,0.07)",
                    color: "#e5e7eb",
                    borderRadius: 12,
                    padding: "7px 10px",
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    opacity: active ? 1 : 0.82,
                  }}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
        )}

        {/* Content */}
        <div
          ref={viewportRef}
          style={{
            flex: 1,
            overflowY: "scroll", // Windows-Flacker-Fix
            overflowX: "hidden",
            WebkitOverflowScrolling: "touch",
            padding: 12,
            touchAction: "pan-y",
          }}
        >
          {loading && (
            <div style={{ color: "#e5e7eb", padding: 12, fontWeight: 800 }}>
              Rendering PDF…
            </div>
          )}
          {err && (
            <div style={{ color: "#fecaca", padding: 12, fontWeight: 800 }}>
              {err}
            </div>
          )}
          <div ref={pagesHostRef} />
        </div>
      </div>
    </div>
  );
}
