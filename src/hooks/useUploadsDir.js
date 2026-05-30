import { useEffect, useState } from 'react'
import { api } from '../api'

// One-shot lookup of the app's uploads directory. Cached at module scope so
// every consumer (Card, TrayApp) hits the Rust command once total, not once
// per mount. Returns '' until the path resolves — callers should check
// before constructing convertFileSrc URLs.
let cached = ''
let inflight = null

export function useUploadsDir() {
  const [dir, setDir] = useState(cached)
  useEffect(() => {
    if (cached) return
    if (!inflight) inflight = api.getUploadsDir().then((p) => { cached = p; return p })
    let mounted = true
    inflight.then((p) => { if (mounted) setDir(p) }).catch(() => {})
    return () => { mounted = false }
  }, [])
  return dir
}
