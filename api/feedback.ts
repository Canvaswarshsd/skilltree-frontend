export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing RESEND_API_KEY" }));
    return;
  }

  let body: any = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const name = (body?.name ?? "").toString().trim();
  const email = (body?.email ?? "").toString().trim();
  const message = (body?.message ?? "").toString().trim();

  // Honeypot (optional): wenn gefüllt, tun wir so als wäre ok
  const hp = (body?.hp ?? "").toString().trim();
  if (hp) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!email || !message) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing email or message" }));
    return;
  }

  const from = "OpenTaskMap <feedback@mail.opentaskmap.com>";
  const to = "opentaskmap@gmail.com";
  const subject = `SkillTree Feedback${name ? ` — ${name}` : ""}`;

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.4">
      <h2 style="margin:0 0 12px 0">New Feedback</h2>
      <p style="margin:0 0 6px 0"><b>Name:</b> ${escapeHtml(name || "-")}</p>
      <p style="margin:0 0 6px 0"><b>Email:</b> ${escapeHtml(email)}</p>
      <p style="margin:12px 0 6px 0"><b>Message:</b></p>
      <pre style="white-space:pre-wrap;margin:0;padding:12px;border:1px solid #333;border-radius:8px;background:#111;color:#eee">${escapeHtml(
        message
      )}</pre>
    </div>
  `.trim();

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      reply_to: email,
      html,
    }),
  });

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  if (!resp.ok) {
    res.statusCode = resp.status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Resend error", data }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, data }));
}