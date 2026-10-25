// Several server instances sharing one Redis: clients connected to different
// instances must see each other's edits and cursors.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { start, connect, waitFor, sleep, uid, rng, randomEdit } from './helpers.ts'

let instances: Awaited<ReturnType<typeof start>>[]
beforeAll(async () => { instances = await Promise.all([start({ redis: true }), start({ redis: true }), start({ redis: true })]) })
afterAll(async () => { await Promise.all(instances.map(s => s.close())) })

test('clients on different instances converge under random concurrent edits', async () => {
  const doc = uid('multi')
  const rand = rng(7)
  // 9 clients, 3 per instance
  const clients = await Promise.all(Array.from({ length: 9 }, (_, i) => connect(instances[i % 3].port, doc, `user${i}`)))
  for (let round = 0; round < 200; round++) {
    for (const c of clients) randomEdit(c.text, rand)
    if (round % 10 === 0) await sleep(1)
  }
  await waitFor(() => clients.every(c => c.text.toString() === clients[0].text.toString()), 15000)
  expect(clients[0].text.length).toBeGreaterThan(0)

  // Presence crosses instances too: everyone sees all 9 users.
  await waitFor(() => clients.every(c => c.provider.awareness.getStates().size === 9))
  clients.forEach(c => c.provider.destroy())
})

test('an instance opening a doc late gets unsaved edits from the others', async () => {
  const doc = uid('hello')
  const a = await connect(instances[0].port, doc)
  a.text.insert(0, 'not saved yet') // save interval is 50ms; connect right away
  const b = await connect(instances[1].port, doc)
  await waitFor(() => b.text.toString() === 'not saved yet')
  a.provider.destroy()
  b.provider.destroy()
})
