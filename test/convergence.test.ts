// Randomized convergence test of the CRDT itself, no network involved.
// Replicas edit concurrently while an adversarial "network" drops, duplicates and
// reorders messages, and replicas go offline and come back (syncing by state vector,
// exactly like a reconnecting client). At the end every replica must be identical.
import { test, expect } from 'vitest'
import * as Y from 'yjs'
import { rng, randomEdit } from './helpers.ts'

const REPLICAS = 5
const STEPS = 4000
const SEEDS = [1, 2, 3, 4, 5]

// Bring `a` up to date with `b` and vice versa (what sync step 1 + 2 does over the wire).
function syncPair(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'net')
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'net')
}

test.each(SEEDS)('replicas converge under random concurrent edits (seed %i)', seed => {
  const rand = rng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const docs = Array.from({ length: REPLICAS }, () => new Y.Doc())
  const online = docs.map(() => true)
  const inflight: { to: number; update: Uint8Array }[] = []
  let edits = 0

  docs.forEach((doc, i) =>
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'net' || !online[i]) return // offline edits only travel on reconnect
      for (let j = 0; j < REPLICAS; j++) if (j !== i) inflight.push({ to: j, update })
    }),
  )

  for (let step = 0; step < STEPS; step++) {
    const r = rand()
    if (r < 0.5) {
      randomEdit(docs[Math.floor(rand() * REPLICAS)].getText('code'), rand)
      edits++
    } else if (r < 0.9 && inflight.length) {
      // Deliver a random in-flight message (=> reordering). Sometimes keep it (=> duplicate),
      // and drop messages for offline replicas.
      const k = Math.floor(rand() * inflight.length)
      const { to, update } = inflight[k]
      if (rand() < 0.9) inflight.splice(k, 1)
      if (online[to]) Y.applyUpdate(docs[to], update, 'net')
    } else if (r < 0.97) {
      // Go offline / come back online. Coming back = state-vector sync with an online peer.
      const i = Math.floor(rand() * REPLICAS)
      online[i] = !online[i]
      const peers = docs.filter((_, j) => j !== i && online[j])
      if (online[i] && peers.length) syncPair(docs[i], pick(peers))
    }
    // remaining ~3%: idle step
  }

  // Heal the network: everyone online, deliver everything left, then a final round of syncs.
  online.fill(true)
  for (const { to, update } of inflight) Y.applyUpdate(docs[to], update, 'net')
  for (const a of docs) for (const b of docs) if (a !== b) syncPair(a, b)

  const expected = docs[0].getText('code').toString()
  expect(expected.length).toBeGreaterThan(0)
  for (const doc of docs) expect(doc.getText('code').toString()).toBe(expected)
  expect(edits).toBeGreaterThan(1500)
})
