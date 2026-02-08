import { encodeObjectPath, getSupabaseEnv, json, supabaseHeaders } from './_supabaseFetch'

type AnyObj = Record<string, any>

function collectAttachmentPaths(state: any): string[] {
  const paths = new Set<string>()
  const tryAdd = (v: any) => {
    if (typeof v !== 'string') return
    // We store storage paths inside dataUrl, like "shares/<id>/<file>.pdf"
    if (v.startsWith('shares/')) paths.add(v)
  }

  // centerAttachments
  const center = state?.centerAttachments
  if (Array.isArray(center)) {
    for (const a of center) tryAdd(a?.dataUrl)
  }
  // tasks[].attachments
  const tasks = state?.tasks
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      const atts = t?.attachments
      if (Array.isArray(atts)) for (const a of atts) tryAdd(a?.dataUrl)
    }
  }
  return Array.from(paths)
}

function replaceAttachmentUrls(state: any, map: Map<string, string>): any {
  const clone: AnyObj = { ...(state ?? {}) }

  if (Array.isArray(clone.centerAttachments)) {
    clone.centerAttachments = clone.centerAttachments.map((a: AnyObj) => {
      const p = a?.dataUrl
      if (typeof p === 'string' && map.has(p)) return { ...a, dataUrl: map.get(p) }
      return a
    })
  }

  if (Array.isArray(clone.tasks)) {
    clone.tasks = clone.tasks.map((t: AnyObj) => {
      if (!Array.isArray(t?.attachments)) return t
      return {
        ...t,
        attachments: t.attachments.map((a: AnyObj) => {
          const p = a?.dataUrl
          if (typeof p === 'string' && map.has(p)) return { ...a, dataUrl: map.get(p) }
          return a
        }),
      }
    })
  }

  return clone
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return json(res, 405, { error: 'Method Not Allowed' })
  }

  try {
    const env = getSupabaseEnv()
    const shareId = String(req.query?.id ?? '').trim()
    if (!shareId) return json(res, 400, { error: 'Missing id' })

    // Load state from DB
    const getUrl = `${env.url}/rest/v1/${encodeURIComponent(env.table)}?id=eq.${encodeURIComponent(shareId)}&select=state,access_count`
    const gr = await fetch(getUrl, { headers: supabaseHeaders(env) })
    const rows: any[] = await gr.json().catch(() => [])
    if (!gr.ok) return json(res, 500, { error: 'Failed to read share', details: rows ?? null })
    if (!Array.isArray(rows) || rows.length === 0) return json(res, 404, { error: 'Not found' })

    const state = rows[0]?.state
    const accessCount = Number(rows[0]?.access_count ?? 0)

    if (!state) return json(res, 404, { error: 'Not found' })

    // Create signed download URLs for all storage paths
    const paths = collectAttachmentPaths(state)
    const signedMap = new Map<string, string>()

    if (paths.length) {
      const signUrl = `${env.url}/storage/v1/object/sign/${encodeURIComponent(env.bucket)}`
      const sr = await fetch(signUrl, {
        method: 'POST',
        headers: supabaseHeaders(env, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 3600, paths }),
      })
      const signedArr: any[] = await sr.json().catch(() => [])
      if (!sr.ok) return json(res, 500, { error: 'Failed to sign attachments', details: signedArr ?? null })

      for (const item of signedArr) {
        const p = item?.path
        const s = item?.signedURL || item?.signedUrl
        if (!p || !s) continue
        const full = typeof s === 'string' && s.startsWith('http') ? s : `${env.url}/storage/v1${s}`
        signedMap.set(p, full)
      }
    }

    const hydrated = signedMap.size ? replaceAttachmentUrls(state, signedMap) : state

    // Update LRU metadata (best-effort)
    const nowIso = new Date().toISOString()
    const patchUrl = `${env.url}/rest/v1/${encodeURIComponent(env.table)}?id=eq.${encodeURIComponent(shareId)}`
    fetch(patchUrl, {
      method: 'PATCH',
      headers: supabaseHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ last_access_at: nowIso, access_count: Math.max(0, accessCount + 1) }),
    }).catch(() => null)

    return json(res, 200, { state: hydrated })
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? 'Unknown error' })
  }
}
