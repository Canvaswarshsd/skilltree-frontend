import { encodeObjectPath, getSupabaseEnv, json, readJson, supabaseHeaders } from './_supabaseFetch'

function base64Url(bytes: Uint8Array): string {
  // Prefer Buffer when available (Node), otherwise fall back to btoa (Edge/web).
  const g: any = globalThis as any

  let b64 = ''
  if (typeof g.Buffer !== 'undefined') {
    b64 = g.Buffer.from(bytes).toString('base64')
  } else if (typeof g.btoa === 'function') {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    b64 = g.btoa(s)
  } else {
    // Very old runtime fallback: hex (not base64), still stable for ids.
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fillRandom(bytes: Uint8Array) {
  const g: any = globalThis as any
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(bytes)
    return
  }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
}

function makeShareId(): string {
  const bytes = new Uint8Array(16)
  fillRandom(bytes)
  // Short, url-safe id
  return base64Url(bytes).slice(0, 22)
}

function fnv1a64(str: string): string {
  // Non-cryptographic hash to avoid Node crypto imports (works in Edge too).
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function hashKey(key: string): string {
  // 32 hex chars, deterministic, short
  return (fnv1a64(key) + fnv1a64(key + '|2')).slice(0, 24)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'Method Not Allowed' })
  }

  try {
    const env = getSupabaseEnv()
    const body = await readJson(req)

    const items: Array<{ key: string }> = Array.isArray(body?.items) ? body.items : []
    if (!items.length) return json(res, 400, { error: 'Missing items[]' })

    const shareId = makeShareId()

    const uploads: Array<{ key: string; path: string; signedUrl: string }> = []

    for (const it of items) {
      const key = String(it?.key ?? '').trim()
      if (!key) continue

      const name = hashKey(key) + '.pdf'
      const path = `shares/${shareId}/${name}`

      // Storage API: generate a presigned url to upload an object
      // Endpoint: PUT /object/upload/sign/{bucketName}/{wildcard}
      const url = `${env.url}/storage/v1/object/upload/sign/${encodeURIComponent(env.bucket)}/${encodeObjectPath(path)}`
      const r = await fetch(url, {
        method: 'PUT',
        headers: supabaseHeaders(env, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 7200 }),
      })

      const data: any = await r.json().catch(() => null)
      if (!r.ok) {
        return json(res, 500, { error: 'Failed to create signed upload URL', details: data ?? null })
      }

      const signedURL = data?.signedURL || data?.signedUrl || data?.url
      if (!signedURL) return json(res, 500, { error: 'Signed upload URL missing in response' })

      // Some endpoints return relative URLs like "/object/upload/sign/..."
      const full =
        typeof signedURL === 'string' && signedURL.startsWith('http')
          ? signedURL
          : `${env.url}/storage/v1${signedURL}`

      uploads.push({ key, path, signedUrl: full })
    }

    return json(res, 200, { shareId, bucket: env.bucket, uploads })
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? 'Unknown error' })
  }
}
