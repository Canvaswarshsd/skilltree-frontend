import React, { useMemo, useState } from "react";

type SendState = "idle" | "sending" | "success" | "error";

/**
 * 1) Placeholder-Farbe (Beispieltexte) einstellen:
 *    - höherer Alpha = heller / besser sichtbar
 *    - z.B. 0.55 (dunkler) bis 0.85 (sehr hell)
 */
const PLACEHOLDER_COLOR = "rgba(255,255,255,0.75)";

/**
 * 2) About-Hintergrundbild:
 *    Lege die Datei hier ab:
 *      frontend/public/about-bg.jpg
 *    Austausch = einfach Datei ersetzen (gleiches Filename).
 */
const ABOUT_BG_URL = "/about-bg.jpg";

export default function AboutView() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [hp, setHp] = useState(""); // honeypot
  const [state, setState] = useState<SendState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  const canSend = useMemo(() => {
    const e = email.trim();
    const m = message.trim();
    if (!e || !m) return false;
    if (!/^\S+@\S+\.\S+$/.test(e)) return false;
    if (m.length < 5) return false;
    return true;
  }, [email, message]);

  const resetForm = () => {
    setName("");
    setEmail("");
    setMessage("");
    setHp("");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === "sending") return;

    setErrorMsg("");
    setState("sending");

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          message: message.trim(),
          hp, // honeypot
        }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        const msg =
          (json && (json.error || json.message)) ||
          `Request failed (${res.status})`;
        throw new Error(msg);
      }

      setState("success");
      resetForm();
    } catch (err: any) {
      setState("error");
      setErrorMsg(err?.message || "Something went wrong. Please try again.");
    }
  };

  const styles = {
    page: {
      width: "100%",
      minHeight: "100vh",
      backgroundImage: `url(${ABOUT_BG_URL})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      // leichter Dark-Overlay, damit Text/Box auf hellen Bildern lesbar bleibt:
      backgroundColor: "rgba(2,6,23,1)",
      position: "relative",
      display: "flex",
      justifyContent: "center",
      padding: "24px 16px",
      // CSS-Variable für Placeholder:
      ["--ph" as any]: PLACEHOLDER_COLOR,
    } as React.CSSProperties,

    overlay: {
      position: "absolute",
      inset: 0,
      background:
        "linear-gradient(180deg, rgba(2,6,23,.55) 0%, rgba(2,6,23,.35) 35%, rgba(2,6,23,.55) 100%)",
      pointerEvents: "none",
    } as React.CSSProperties,

    card: {
      width: "100%",
      maxWidth: 920,
      borderRadius: 16,
      border: "1px solid rgba(148,163,184,.22)",
      background: "rgba(15,23,42,.40)",
      boxShadow: "0 12px 36px rgba(0,0,0,.10)",
      padding: "18px 18px 16px",
      position: "relative",
      zIndex: 1,
      backdropFilter: "blur(6px)",
    } as React.CSSProperties,

    grid: {
      display: "grid",
      gridTemplateColumns: "1.1fr .9fr",
      gap: 16,
      alignItems: "start",
    } as React.CSSProperties,

    col: { minWidth: 0 } as React.CSSProperties,

    h1: {
      margin: 0,
      fontSize: "1.15rem",
      fontWeight: 850,
      letterSpacing: ".1px",
    } as React.CSSProperties,

    p: {
      margin: "8px 0 0",
      opacity: 0.9,
      lineHeight: 1.55,
      fontSize: ".95rem",
    } as React.CSSProperties,

    label: {
      display: "block",
      fontSize: ".85rem",
      opacity: 0.9,
      margin: "10px 0 6px",
    } as React.CSSProperties,

    input: {
      width: "100%",
      borderRadius: 10,
      border: "1px solid rgba(148,163,184,.26)",
      background: "rgba(2,6,23,.35)",
      color: "inherit",
      padding: "10px 12px",
      outline: "none",
    } as React.CSSProperties,

    textarea: {
      width: "100%",
      minHeight: 120,
      resize: "vertical",
      borderRadius: 10,
      border: "1px solid rgba(148,163,184,.26)",
      background: "rgba(2,6,23,.35)",
      color: "inherit",
      padding: "10px 12px",
      outline: "none",
      lineHeight: 1.45,
    } as React.CSSProperties,

    row: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      marginTop: 12,
    } as React.CSSProperties,

    btn: {
      borderRadius: 10,
      border: "1px solid rgba(148,163,184,.22)",
      background: "rgba(59,130,246,.9)",
      color: "white",
      padding: "10px 14px",
      fontWeight: 800,
      cursor: "pointer",
      userSelect: "none",
      whiteSpace: "nowrap",
    } as React.CSSProperties,

    btnDisabled: {
      opacity: 0.55,
      cursor: "not-allowed",
      filter: "grayscale(15%)",
    } as React.CSSProperties,

    hint: {
      fontSize: ".85rem",
      opacity: 0.85,
      lineHeight: 1.4,
    } as React.CSSProperties,

    badgeOk: {
      display: "inline-block",
      padding: "8px 10px",
      borderRadius: 10,
      background: "rgba(34,197,94,.14)",
      border: "1px solid rgba(34,197,94,.28)",
      color: "rgba(220,252,231,1)",
      fontWeight: 750,
      fontSize: ".9rem",
    } as React.CSSProperties,

    badgeErr: {
      display: "inline-block",
      padding: "8px 10px",
      borderRadius: 10,
      background: "rgba(239,68,68,.12)",
      border: "1px solid rgba(239,68,68,.25)",
      color: "rgba(254,226,226,1)",
      fontWeight: 750,
      fontSize: ".9rem",
    } as React.CSSProperties,

    hpWrap: {
      position: "absolute",
      left: "-9999px",
      top: "auto",
      width: 1,
      height: 1,
      overflow: "hidden",
    } as React.CSSProperties,

    small: { marginTop: 8, fontSize: ".82rem", opacity: 0.75 } as React.CSSProperties,

    divider: {
      height: 1,
      background: "rgba(148,163,184,.14)",
      margin: "14px 0 12px",
    } as React.CSSProperties,
  };

  return (
    <div className="task-list">
      <div className="about-page" style={styles.page}>
        <div style={styles.overlay} />

        <div className="about-card" style={styles.card}>
          <style>{`
            @media (max-width: 860px){
              .about-grid { grid-template-columns: 1fr !important; }
            }

            /* Placeholder (Beispieltexte) Farbe: über --ph steuerbar */
            .about-card input::placeholder,
            .about-card textarea::placeholder {
              color: var(--ph);
              opacity: 1;
            }
          `}</style>

          <div className="about-grid" style={styles.grid}>
            <div style={styles.col}>
              <h1 style={styles.h1}>About</h1>
              <p style={styles.p}>
                Hi — I’m the developer of <b>OpenTaskMap</b>. If you found a bug, have an
                idea, or want to give quick feedback, send me a message here.
              </p>

              <div style={styles.divider} />

              <div style={styles.hint}>
                <b>PS:</b> If something broke, tell me what you clicked + what you expected
                to happen xD
              </div>

              <div style={styles.small}>
                This form sends an email to me. Your reply address is used only so I can answer you.
              </div>
            </div>

            <div style={styles.col}>
              <h1 style={{ ...styles.h1, fontSize: "1.05rem" }}>Send feedback</h1>

              <form onSubmit={onSubmit}>
                <label style={styles.label}>Name (optional)</label>
                <input
                  style={styles.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />

                <label style={styles.label}>Email *</label>
                <input
                  style={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  inputMode="email"
                />

                <label style={styles.label}>Message *</label>
                <textarea
                  style={styles.textarea}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Your feedback…"
                />

                {/* honeypot */}
                <div style={styles.hpWrap} aria-hidden="true">
                  <label>Leave this empty</label>
                  <input value={hp} onChange={(e) => setHp(e.target.value)} />
                </div>

                <div style={styles.row}>
                  <button
                    type="submit"
                    style={{
                      ...styles.btn,
                      ...(state === "sending" || !canSend ? styles.btnDisabled : {}),
                    }}
                    disabled={state === "sending" || !canSend}
                  >
                    {state === "sending" ? "Sending..." : "Send"}
                  </button>

                  <div style={styles.hint}>
                    {state === "idle" && !canSend ? (
                      <span>Enter a valid email + a message.</span>
                    ) : null}

                    {state === "success" ? (
                      <span style={styles.badgeOk}>Sent. Thank you!</span>
                    ) : null}

                    {state === "error" ? (
                      <span style={styles.badgeErr}>
                        Failed. {errorMsg || "Please try again."}
                      </span>
                    ) : null}
                  </div>
                </div>
              </form>

              <div style={styles.small}>
                Required fields are marked with *. No account needed.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
