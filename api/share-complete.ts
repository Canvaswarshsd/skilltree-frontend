import { getSupabaseEnv, json, readJson, supabaseHeaders } from './_supabaseFetch.js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'Method Not Allowed' })
  }

  try {
    const env = getSupabaseEnv()
    const body = await readJson(req)

    const shareId = String(body?.shareId ?? '').trim()
    const state = body?.state ?? null
    const bytesTotal = Number(body?.bytesTotal ?? 0)

    if (!shareId || !state) return json(res, 400, { error: 'Missing shareId/state' })

    const nowIso = new Date().toISOString()

    const record = {
      id: shareId,
      state,
      bytes_total: Number.isFinite(bytesTotal) ? Math.max(0, Math.floor(bytesTotal)) : 0,
      last_access_at: nowIso,
      access_count: 0,
    }

    const url = `${env.url}/rest/v1/${encodeURIComponent(env.table)}?on_conflict=id`
    const r = await fetch(url, {
      method: 'POST',
      headers: supabaseHeaders(env, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      }),
      body: JSON.stringify(record),
    })

    const data: any = await r.json().catch(() => null)
    if (!r.ok) return json(res, 500, { error: 'Failed to store share', details: data ?? null })

    return json(res, 200, { ok: true, shareId })
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? 'Unknown error' })
  }
}
