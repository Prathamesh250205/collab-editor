import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { yCollab } from 'y-codemirror.next'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'

type Peer = { name: string; color: string }

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#469990']

export function Editor({ docId, name }: { docId: string; name: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('connecting')
  const [peers, setPeers] = useState<Peer[]>([])

  useEffect(() => {
    // The Y.Doc is this browser's replica of the document. Every edit goes into it
    // first (so typing never waits for the network), then the provider ships it to the server.
    const ydoc = new Y.Doc()
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const provider = new WebsocketProvider(wsUrl, docId, ydoc)
    const ytext = ydoc.getText('code')

    const color = COLORS[hash(name) % COLORS.length]
    // y-codemirror reads `user` from awareness to draw our cursor on other screens.
    provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '33' })

    const updatePeers = () =>
      setPeers([...provider.awareness.getStates().values()].map(s => s.user).filter(Boolean))
    provider.awareness.on('change', updatePeers)
    provider.on('status', ({ status }: { status: string }) => setStatus(status))

    const view = new EditorView({
      parent: host.current!,
      // yCollab binds CodeMirror <-> Y.Text both ways and renders remote cursors.
      extensions: [basicSetup, javascript({ typescript: true }), yCollab(ytext, provider.awareness, { undoManager: new Y.UndoManager(ytext) })],
    })
    updatePeers()

    return () => {
      view.destroy()
      provider.destroy()
      ydoc.destroy()
    }
  }, [docId, name])

  return (
    <div className="editor-page">
      <header>
        <a href="/">Collab Editor</a>
        <span className={`status ${status}`}>{status}</span>
        <div className="peers">
          {peers.map((p, i) => (
            <span key={i} className="peer" style={{ background: p.color }} title={p.name}>
              {p.name}
            </span>
          ))}
        </div>
        <button onClick={() => navigator.clipboard.writeText(location.href)}>Copy link</button>
      </header>
      <div ref={host} className="editor" />
    </div>
  )
}

function hash(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
