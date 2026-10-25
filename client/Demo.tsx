// A live, in-browser CRDT demo: two Yjs replicas joined by a simulated network
// with adjustable latency. Two bots type, the visitor can type too, and either
// replica can be taken offline. On reconnect they exchange state vectors (the
// same handshake the real server uses) and converge.
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { yCollab } from 'y-codemirror.next'
import { EditorView, minimalSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { inkTheme } from './cmTheme.ts'

const SEED = '// shared.ts\n\n\n'
const BOTS = [
  { name: 'maya', color: '#ff6b4a', at: 13, script: 'export function merge(a, b) {\n  return [...a, ...b].sort(byClock)\n}\n' },
  { name: 'kai', color: '#4fd1ff', at: SEED.length, script: '\n// no locks: every replica converges\nconst doc = new Y.Doc()\n' },
]

type Replica = {
  doc: Y.Doc
  text: Y.Text
  awareness: awarenessProtocol.Awareness
  online: boolean
}

export function Demo({ active }: { active: boolean }) {
  const hosts = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const [online, setOnline] = useState([true, true])
  const [inFlight, setInFlight] = useState(0)
  const [converged, setConverged] = useState(true)
  const [latency, setLatency] = useState(250)
  const [round, setRound] = useState(0)
  const [finished, setFinished] = useState(false)
  const api = useRef<{ setOnline: (i: number, on: boolean) => void; latency: number }>({ setOnline: () => {}, latency: 250 })
  api.current.latency = latency

  useEffect(() => {
    if (!active) return
    setFinished(false)
    // Both replicas start from the same base state.
    const seed = new Y.Doc()
    seed.getText('code').insert(0, SEED)
    const base = Y.encodeStateAsUpdate(seed)

    const replicas: Replica[] = [0, 1].map(() => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, base)
      return { doc, text: doc.getText('code'), awareness: new awarenessProtocol.Awareness(doc), online: true }
    })
    let flying = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => (timers.delete(t), fn()), ms)
      timers.add(t)
    }
    const check = () => setConverged(replicas[0].text.toString() === replicas[1].text.toString())

    // The "network": a message is delivered after a random delay, and dropped if
    // either side is offline when it arrives (the reconnect handshake repairs it).
    function send(from: number, deliver: (to: Replica) => void) {
      const to = replicas[1 - from]
      if (!replicas[from].online) return
      flying++
      setInFlight(flying)
      later(api.current.latency * (0.5 + Math.random()), () => {
        flying--
        setInFlight(flying)
        if (replicas[from].online && to.online) deliver(to)
        check()
      })
    }
    replicas.forEach((r, i) => {
      r.doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== 'net') send(i, to => Y.applyUpdate(to.doc, u, 'net'))
        check()
      })
      r.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'net') return
        const msg = awarenessProtocol.encodeAwarenessUpdate(r.awareness, added.concat(updated, removed))
        send(i, to => awarenessProtocol.applyAwarenessUpdate(to.awareness, msg, 'net'))
      })
    })

    api.current.setOnline = (i, on) => {
      replicas[i].online = on
      setOnline(replicas.map(r => r.online))
      if (on && replicas[1 - i].online) {
        // Reconnect: each side sends what the other is missing, by state vector.
        later(api.current.latency, () => {
          const [a, b] = replicas
          Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), 'net')
          Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), 'net')
          for (const [x, y] of [[a, b], [b, a]]) {
            awarenessProtocol.applyAwarenessUpdate(y.awareness, awarenessProtocol.encodeAwarenessUpdate(x.awareness, [x.doc.clientID]), 'net')
          }
          check()
        })
      }
    }
    setOnline([true, true])

    const views = replicas.map(
      (r, i) =>
        new EditorView({
          parent: hosts[i].current!,
          doc: r.text.toString(), // CodeMirror must start from the replica's current text
          extensions: [minimalSetup, javascript(), inkTheme, yCollab(r.text, r.awareness, { undoManager: false })],
        }),
    )

    // Each bot types into its own replica, one character at a time, at a position
    // that moves with concurrent edits (a Yjs relative position).
    let doneBots = 0
    BOTS.forEach((bot, i) => {
      const r = replicas[i]
      r.awareness.setLocalStateField('user', { name: bot.name, color: bot.color, colorLight: bot.color + '33' })
      // assoc -1: the position sticks to the character on its left (the bot's last
      // typed character), so concurrent inserts by the other bot never land in between.
      let anchor = Y.createRelativePositionFromTypeIndex(r.text, bot.at, -1)
      let k = 0
      const type = () => {
        if (k >= bot.script.length) {
          if (++doneBots === BOTS.length) later(1200, () => setFinished(true))
          return
        }
        const index = Y.createAbsolutePositionFromRelativePosition(anchor, r.doc)?.index ?? r.text.length
        r.text.insert(index, bot.script[k++])
        anchor = Y.createRelativePositionFromTypeIndex(r.text, index + 1, -1)
        const cursor = Y.relativePositionToJSON(anchor)
        r.awareness.setLocalStateField('cursor', { anchor: cursor, head: cursor })
        later(55 + Math.random() * 110, type)
      }
      later(700 + i * 450, type)
    })

    return () => {
      timers.forEach(clearTimeout)
      views.forEach(v => v.destroy())
      replicas.forEach(r => (r.awareness.destroy(), r.doc.destroy()))
    }
  }, [active, round])

  return (
    <div className="demo">
      <div className="demo-panes">
        {[0, 1].map(i => (
          <div key={i} className={`pane ${online[i] ? '' : 'is-offline'}`}>
            <div className="pane-bar">
              <span className="pane-dot" style={{ background: BOTS[i].color }} />
              <span className="mono">replica {i === 0 ? 'A' : 'B'} · {BOTS[i].name}</span>
              <button className="chip" onClick={() => api.current.setOnline(i, !online[i])} aria-pressed={!online[i]}>
                {online[i] ? 'Go offline' : 'Reconnect'}
              </button>
            </div>
            <div ref={hosts[i]} className="pane-editor" />
            <AnimatePresence>
              {!online[i] && (
                <motion.div className="pane-badge" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}>
                  offline · edits stay local
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      <div className="demo-bar">
        <motion.div className={`sync ${converged ? 'ok' : 'busy'}`} layout>
          <span className="sync-dot" />
          {converged ? 'Replicas identical' : online.every(Boolean) ? 'Syncing…' : 'Diverged until reconnect'}
        </motion.div>
        <span className="mono muted">{inFlight} in flight</span>
        <label className="latency">
          <span className="mono muted">latency {latency} ms</span>
          <input type="range" min={20} max={1500} step={10} value={latency} onChange={e => setLatency(Number(e.target.value))} />
        </label>
        <button className="chip" onClick={() => setRound(r => r + 1)} disabled={!finished}>
          Replay
        </button>
      </div>
      <p className="demo-hint muted">Click into either pane and type. Take one offline, type in both, then reconnect.</p>
    </div>
  )
}
