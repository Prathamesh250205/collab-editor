// Load test: how many concurrent editors can the server(s) handle, and what is the
// end-to-end sync latency (edit typed on one client -> visible on every other client
// of that document)?
//
//   node loadtest/run.ts --url ws://localhost:3000/ws --levels 100,200,400 --perDoc 10 --rate 2 --seconds 20
//
// Several --url values (comma separated) spread editors across instances round-robin.
// Sender and receivers live in this one process, so they share a clock: latency is
// simply receive time - send time. The load generator itself uses CPU on the same
// machine, so the numbers are a lower bound on what the server could do alone.
// The generator runs in worker threads (each owns whole documents, so a document's
// sender and receivers still share one clock); one thread alone saturated before the server did.
import { parseArgs } from 'node:util'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'

const { values: parsed } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:3000/ws' },
    levels: { type: 'string', default: '50,100,200' },
    perDoc: { type: 'string', default: '10' },
    rate: { type: 'string', default: '2' }, // edits per second per editor
    seconds: { type: 'string', default: '20' },
    token: { type: 'string', default: '' },
    workers: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
  },
})
process.setMaxListeners(0) // every provider adds an exit listener
const args: typeof parsed = isMainThread ? parsed : workerData.args
const urls = args.url.split(',')
const perDoc = Number(args.perDoc)
const rate = Number(args.rate)
const seconds = Number(args.seconds)

type Editor = { provider: WebsocketProvider; text: Y.Text; timer?: NodeJS.Timeout }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function connect(url: string, docId: string): Promise<Editor> {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, docId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    params: args.token ? { token: args.token } : {},
  })
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect timeout ${docId}`)), 30_000)
    provider.once('sync', () => {
      clearTimeout(t)
      resolve({ provider, text: doc.getText('code') })
    })
  })
}

function percentile(sorted: number[], p: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN
}

type Job = { run: string; docs: number[]; editorsTotal: number }

// Runs in a worker thread: connect the editors of the given documents, edit for
// `seconds`, and report how many edits were sent and every observed latency.
async function simulate({ run, docs, editorsTotal }: Job) {
  const sent = new Map<string, number>() // tag -> send time
  const latencies: number[] = []
  let sending = false

  // Connect in batches so we measure steady state, not a connection storm.
  const editors: Editor[] = []
  const indices = docs.flatMap(d => Array.from({ length: perDoc }, (_, k) => d * perDoc + k)).filter(j => j < editorsTotal)
  for (let i = 0; i < indices.length; i += 50) {
    const batch = indices.slice(i, i + 50).map(j => connect(urls[j % urls.length], `${run}-${Math.floor(j / perDoc)}`))
    editors.push(...(await Promise.all(batch)))
  }
  parentPort!.postMessage('ready')
  await new Promise(r => parentPort!.once('message', r)) // all workers start editing together

  editors.forEach((ed, idx) => {
    // Remote edits arrive with origin = the provider; parse our tags out of the inserted text.
    ed.text.observe(event => {
      if (event.transaction.origin !== ed.provider) return
      const now = performance.now()
      for (const op of event.delta) {
        if (typeof op.insert !== 'string') continue
        for (const m of op.insert.matchAll(/\[(\d+:\d+)\]/g)) {
          const t = sent.get(m[1])
          if (t !== undefined) latencies.push(now - t)
        }
      }
    })
    let seq = 0
    const tick = () => {
      if (sending) {
        const tag = `${idx}:${seq++}`
        sent.set(tag, performance.now())
        ed.text.insert(Math.floor(Math.random() * (ed.text.length + 1)), `[${tag}]`)
      }
      ed.timer = setTimeout(tick, (1000 / rate) * (0.5 + Math.random())) // jitter so edits don't line up
    }
    ed.timer = setTimeout(tick, Math.random() * (1000 / rate))
  })

  sending = true
  await sleep(seconds * 1000)
  sending = false
  editors.forEach(e => clearTimeout(e.timer))
  await sleep(2000) // let in-flight edits land

  editors.forEach(e => e.provider.destroy())
  await sleep(500)
  return { sent: sent.size, latencies }
}

async function runLevel(editorsTotal: number, workers: number) {
  const run = `load-${Date.now()}`
  const docCount = Math.ceil(editorsTotal / perDoc)
  const threads = Array.from({ length: Math.min(workers, docCount) }, (_, w) => {
    const job: Job = { run, editorsTotal, docs: Array.from({ length: docCount }, (_, d) => d).filter(d => d % workers === w) }
    return new Worker(new URL(import.meta.url), { workerData: { job, args } })
  })
  // Wait until every worker has connected its editors, then start them together.
  await Promise.all(threads.map(t => new Promise(r => t.once('message', r))))
  threads.forEach(t => t.postMessage('go'))
  const parts = await Promise.all(threads.map(t => new Promise<{ sent: number; latencies: number[] }>(r => t.once('message', r))))

  const latencies = parts.flatMap(p => p.latencies).sort((a, b) => a - b)
  const sentTotal = parts.reduce((n, p) => n + p.sent, 0)
  const expected = sentTotal * (Math.min(perDoc, editorsTotal) - 1)
  return {
    editors: editorsTotal,
    docs: docCount,
    edits: sentTotal,
    editsPerSec: Math.round(sentTotal / seconds),
    deliveries: latencies.length,
    delivered: `${((100 * latencies.length) / expected).toFixed(2)}%`,
    p50: +percentile(latencies, 50).toFixed(1),
    p95: +percentile(latencies, 95).toFixed(1),
    p99: +percentile(latencies, 99).toFixed(1),
    max: +(latencies.at(-1) ?? NaN).toFixed(1),
  }
}

if (isMainThread) {
  const workers = Number(args.workers)
  console.log(`urls=${urls.join(',')} perDoc=${perDoc} rate=${rate}/s/editor seconds=${seconds} workers=${workers}`)
  const results = []
  for (const level of args.levels.split(',').map(Number)) {
    const r = await runLevel(level, workers)
    console.log(JSON.stringify(r))
    results.push(r)
  }
  console.table(results)
  process.exit(0)
} else {
  parentPort!.postMessage(await simulate(workerData.job))
  process.exit(0)
}
