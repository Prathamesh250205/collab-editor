import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import { startServer } from '../server/index.ts'
import { signToken } from '../server/auth.ts'

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://collab:collab@localhost:5432/collab'
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
export const SECRET = 'test-secret'

export function start(opts: { redis?: boolean; port?: number } = {}) {
  return startServer({
    port: opts.port ?? 0,
    databaseUrl: DATABASE_URL,
    redisUrl: opts.redis ? REDIS_URL : undefined,
    authSecret: SECRET,
    saveIntervalMs: 50,
    versionIntervalMs: 200,
  })
}

export type Client = { doc: Y.Doc; text: Y.Text; provider: WebsocketProvider }

// A headless editor: the same WebsocketProvider the browser uses, running in Node.
export function connect(port: number, docId: string, name = 'tester'): Promise<Client> {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${port}/ws`, docId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // y-websocket also syncs same-browser tabs over BroadcastChannel, which Node has too.
    // Each test client stands for a separate machine, so everything must go through the server.
    disableBc: true,
    params: { token: signToken(name, SECRET) },
  })
  provider.awareness.setLocalStateField('user', { name })
  return new Promise(resolve => provider.once('sync', () => resolve({ doc, text: doc.getText('code'), provider })))
}

export async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await sleep(10)
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

// Small seeded PRNG (mulberry32) so a failing random test can be replayed from its seed.
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One random edit: insert a short string or delete a short range, at a random position.
export function randomEdit(text: Y.Text, rand: () => number) {
  const pos = Math.floor(rand() * (text.length + 1))
  if (rand() < 0.3 && text.length > 0) {
    text.delete(Math.min(pos, text.length - 1), 1 + Math.floor(rand() * Math.min(5, text.length - pos)))
  } else {
    text.insert(pos, 'abcdefghij\n'.slice(Math.floor(rand() * 10)).slice(0, 1 + Math.floor(rand() * 4)))
  }
}
