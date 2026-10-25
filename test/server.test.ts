// End-to-end tests against a real server (real WebSockets, real Postgres).
import { test, expect, beforeAll, afterAll } from 'vitest'
import { start, connect, waitFor, sleep, uid, rng, randomEdit, type Client } from './helpers.ts'

let server: Awaited<ReturnType<typeof start>>
beforeAll(async () => { server = await start() })
afterAll(async () => { await server?.close() })

const close = (...clients: Client[]) => clients.forEach(c => c.provider.destroy())

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
  const versions = await (await fetch(`http://localhost:${server.port}/api/docs/${doc}/versions`)).json()
  expect(versions.length).toBeGreaterThan(0)
  const { text } = await (await fetch(`http://localhost:${server.port}/api/docs/${doc}/versions/${versions[0].id}`)).json()
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
  const res = await fetch(`http://localhost:${server.port}/api/docs/${'x'.repeat(100)}/versions`)
  expect(res.status).toBe(400)
})
