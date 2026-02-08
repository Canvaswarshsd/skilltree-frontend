type SupabaseEnv = {
  url: string
  secret: string
  bucket: string
  table: string
}

function pickEnv(name: string): string {
  const v = process.env[name]
  return (v ?? '').trim()
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = pickEnv('SUPABASE_URL')
  const secret =
    pickEnv('SUPABASE_SECRET_KEY') ||
    pickEnv('SUPABASE_SERVICE_ROLE_KEY') ||
    pickEnv('SUPABASE_SERVICE_KEY') ||
    pickEnv('SUPABASE_SECRET_K') ||
    pickEnv('SUPABASE_SECRET')

  const bucket =
    pickEnv('SUPABASE_STORAGE_BUCKET') ||
    pickEnv('TASKMAP_STORAGE_BUCKET') ||
    'taskmap-shares'

  const table =
    pickEnv('TASKMAP_SHARES_TABLE') ||
    pickEnv('SHARES_TABLE') ||
    'taskmap_shares'

  if (!url || !secret) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY in environment variables.'
    )
  }

  return { url, secret, bucket, table }
}

export function supabaseHeaders(env: SupabaseEnv, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: env.secret,
    Authorization: `Bearer ${env.secret}`,
    ...(extra ?? {}),
  }
}

export function json(res: any, status: number, data: any) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

export async function readJson(req: any): Promise<any> {
  if (!req) return null
  if (req.body && typeof req.body === 'object') return req.body
  const chunks: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Uint8Array) => chunks.push(c))
    req.on('end', () => resolve())
    req.on('error', (e: any) => reject(e))
  })
  if (!chunks.length) return null
  const raw = Buffer.concat(chunks).toString('utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function encodeObjectPath(path: string): string {
  // Keep slashes, encode each segment.
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}
