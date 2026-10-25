// End-to-end tests against a real server (real WebSockets, real Postgres).
import { test, expect, beforeAll, afterAll } from 'vitest'
import WebSocket from 'ws'
import { start, connect, waitFor, sleep, uid, rng, randomEdit, SECRET, type Client } from './helpers.ts'
import { signToken } from '../server/auth.ts'

let server: Awaited<ReturnType<typeof start>>
beforeAll(async () => { server = await start() })
afterAll(async () => { await server?.close() })

const close = (...clients: Client[]) => clients.forEach(c => c.provider.destroy())
const authed = (path: string) => fetch(`http://localhost:${server.port}${path}`, { headers: { Authorization: `Bearer ${signToken('tester', SECRET)}` } })

test('edits sync between two clients', async () => {
  const doc = uid('basic')
  const a = await connect(server.port, doc)
  const b = await connect(server.port, doc)
  a.text.insert(0, 'hello')
  await waitFor(() => b.text.toString() === 'hello')
  b.text.insert(5, ' world')
  await waitFor(() => a.text.toString() === 'hello world')
  close(a, b)
})

test('a late joiner receives the full document from the server', async () => {
  const doc = uid('late')
  const a = await connect(server.port, doc)
  a.text.insert(0, 'written before b joined')
  await sleep(50)
  const b = await connect(server.port, doc)
  expect(b.text.toString()).toBe('written before b joined')
  close(a, b)
})

test('document survives a server restart (Postgres) and gets a version snapshot', async () => {
  const doc = uid('persist')
  const a = await connect(server.port, doc)
  a.text.insert(0, 'persist me')
  await sleep(100)
  close(a)
  await server.close() // last client gone + shutdown => final save
  server = await start()
  const b = await connect(server.port, doc)
  expect(b.text.toString()).toBe('persist me')
  const versions = await (await authed(`/api/docs/${doc}/versions`)).json()
  expect(versions.length).toBeGreaterThan(0)
  const { text } = await (await authed(`/api/docs/${doc}/versions/${versions[0].id}`)).json()
  expect(text).toBe('persist me')
  close(b)
})

test('offline edits on both sides merge on reconnect', async () => {
  const doc = uid('offline')
  const a = await connect(server.port, doc)
  const b = await connect(server.port, doc)
  a.text.insert(0, 'base\n')
  await waitFor(() => b.text.toString() === 'base\n')

  a.provider.disconnect() // a goes offline
  a.text.insert(0, 'from-a-offline\n')
  b.text.insert(b.text.length, 'from-b-online\n')
  await sleep(50)
  expect(a.text.toString()).not.toContain('from-b-online')

  a.provider.connect() // back online: state-vector sync in both directions
  await waitFor(() => a.text.toString() === b.text.toString())
  expect(a.text.toString()).toContain('from-a-offline')
  expect(a.text.toString()).toContain('from-b-online')
  close(a, b)
})

test('presence: a disconnected client disappears from others', async () => {
  const doc = uid('presence')
  const a = await connect(server.port, doc, 'alice')
  const b = await connect(server.port, doc, 'bob')
  const names = () => [...a.provider.awareness.getStates().values()].map(s => s.user?.name).sort()
  await waitFor(() => names().join() === 'alice,bob')
  close(b)
  await waitFor(() => names().join() === 'alice')
  close(a)
})

test('randomized: many clients editing concurrently through the server converge', async () => {
  const doc = uid('random')
  const rand = rng(42)
  const clients = await Promise.all(Array.from({ length: 6 }, () => connect(server.port, doc)))
  for (let round = 0; round < 300; round++) {
    for (const c of clients) randomEdit(c.text, rand)
    // Occasionally drop a client offline for a while, then bring it back.
    if (round % 50 === 10) clients[round % clients.length].provider.disconnect()
    if (round % 50 === 30) clients.forEach(c => c.provider.shouldConnect || c.provider.connect())
    if (round % 10 === 0) await sleep(1) // let the network interleave with the edits
  }
  clients.forEach(c => c.provider.shouldConnect || c.provider.connect())
  await waitFor(() => clients.every(c => c.text.toString() === clients[0].text.toString()), 15000)
  expect(clients[0].text.length).toBeGreaterThan(0)
  close(...clients)
})

test('rejects bad document ids', async () => {
  const res = await authed(`/api/docs/${'x'.repeat(100)}/versions`)
  expect(res.status).toBe(400)
})

test('auth: register, login, and rejection of missing or forged tokens', async () => {
  const base = `http://localhost:${server.port}/api`
  const post = (path: string, body: object) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const username = uid('u').slice(0, 30)

  expect((await post('/register', { username, password: 'short' })).status).toBe(400)
  const reg = await post('/register', { username, password: 'correct horse' })
  expect(reg.status).toBe(200)
  expect((await post('/register', { username, password: 'correct horse' })).status).toBe(409)
  expect((await post('/login', { username, password: 'wrong password' })).status).toBe(401)
  const { token } = await (await post('/login', { username, password: 'correct horse' })).json()

  // History API needs a valid token
  expect((await fetch(`${base}/docs/x/versions`)).status).toBe(401)
  expect((await fetch(`${base}/docs/x/versions`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
  const forged = signToken(username, 'not-the-secret')
  expect((await fetch(`${base}/docs/x/versions`, { headers: { Authorization: `Bearer ${forged}` } })).status).toBe(401)

  // WebSocket upgrade needs a valid token
  const tryWs = (q: string) =>
    new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws/x${q}`)
      ws.on('open', () => (ws.close(), resolve('open')))
      ws.on('error', () => resolve('rejected'))
    })
  expect(await tryWs('')).toBe('rejected')
  expect(await tryWs(`?token=${forged}`)).toBe('rejected')
  expect(await tryWs(`?token=${token}`)).toBe('open')
})

test('CORS: only the configured frontend origin is allowed', async () => {
  const { startServer } = await import('../server/index.ts')
  const { DATABASE_URL } = await import('./helpers.ts')
  const s = await startServer({ port: 0, databaseUrl: DATABASE_URL, authSecret: SECRET, corsOrigin: 'https://app.example' })
  const pre = await fetch(`http://localhost:${s.port}/api/login`, { method: 'OPTIONS' })
  expect(pre.status).toBe(204)
  expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example')
  expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization')
  await s.close()
  // Without corsOrigin (same-origin deployment) no CORS headers are sent.
  expect((await fetch(`http://localhost:${server.port}/api/health`)).headers.get('access-control-allow-origin')).toBeNull()
})
