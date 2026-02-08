import { getSupabaseEnv, json, supabaseHeaders } from './_supabaseFetch.js'

type AnyObj = Record<string, any>

function collectPathsFromState(state: any): string[] {
  const paths = new Set<string>()
  const add = (v: any) => {
    if (typeof v === 'string' && v.startsWith('shares/')) paths.add(v)
  }
  if (Array.isArray(state?.centerAttachments)) {
    for (const a of state.centerAttachments) add(a?.dataUrl)
  }
  if (Array.isArray(state?.tasks)) {
    for (const t of state.tasks) {
      if (Array.isArray(t?.attachments)) for (const a of t.attachments) add(a?.dataUrl)
    }
  }
  return Array.from(paths)
}

export default async function handler(req: any, res: any) {
  // Vercel cron sends an Authorization header if you set CRON_SECRET
  const expected = (process.env.CRON_SECRET ?? '').trim()
  if (expected) {
    const auth = String(req.headers?.authorization ?? '')
    if (auth !== `Bearer ${expected}`) return json(res, 401, { error: 'Unauthorized' })
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return json(res, 405, { error: 'Method Not Allowed' })
  }

  try {
    const env = getSupabaseEnv()
    const capGb = Number(process.env.SHARE_CAP_GB ?? 100)
    const capBytes = Math.max(1, Math.floor(capGb * 1024 * 1024 * 1024))

    // Fetch all shares (MVP: fine). For large scale, replace with an aggregate SQL function.
    const url = `${env.url}/rest/v1/${encodeURIComponent(env.table)}?select=id,bytes_total,last_access_at,state`
    const r = await fetch(url, { headers: supabaseHeaders(env) })
    const rows: AnyObj[] = await r.json().catch(() => [])
    if (!r.ok) return json(res, 500, { error: 'Failed to list shares', details: rows ?? null })

    let total = 0
    for (const row of rows) total += Number(row?.bytes_total ?? 0) || 0

    if (total <= capBytes) return json(res, 200, { ok: true, capBytes, totalBytes: total, deleted: 0 })

    // Oldest first (LRU)
    rows.sort((a, b) => {
      const ta = new Date(a?.last_access_at ?? a?.created_at ?? 0).getTime()
      const tb = new Date(b?.last_access_at ?? b?.created_at ?? 0).getTime()
      return ta - tb
    })

    let deleted = 0
    for (const row of rows) {
      if (total <= capBytes) break
      const id = String(row?.id ?? '')
      if (!id) continue

      const bytes = Number(row?.bytes_total ?? 0) || 0
      const state = row?.state

      // delete storage objects
      const paths = collectPathsFromState(state)
      if (paths.length) {
        const delUrl = `${env.url}/storage/v1/object/${encodeURIComponent(env.bucket)}`
        await fetch(delUrl, {
          method: 'DELETE',
          headers: supabaseHeaders(env, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ prefixes: paths }),
        }).catch(() => null)
      }

      // delete db row
      const delRowUrl = `${env.url}/rest/v1/${encodeURIComponent(env.table)}?id=eq.${encodeURIComponent(id)}`
      await fetch(delRowUrl, { method: 'DELETE', headers: supabaseHeaders(env) })

      total -= bytes
      deleted += 1
    }

    return json(res, 200, { ok: true, capBytes, totalBytes: total, deleted })
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? 'Unknown error' })
  }
}
