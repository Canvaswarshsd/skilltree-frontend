import { createHash, randomBytes } from 'crypto'
import { encodeObjectPath, getSupabaseEnv, json, readJson, supabaseHeaders } from './_supabaseFetch'

function makeShareId(): string {
  // 12 bytes -> 16 chars base64url-ish
  return randomBytes(12).toString('base64url')
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24)
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
      // Endpoint (storage-api): PUT /object/upload/sign/{bucketName}/{wildcard}
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

      // Some endpoints return relative URLs like "/object/upload/sign/.."
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
