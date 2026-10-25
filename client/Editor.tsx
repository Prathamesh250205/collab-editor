import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { yCollab } from 'y-codemirror.next'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'

type Peer = { name: string; color: string }
type Version = { id: number; createdAt: string; bytes: number }

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#469990']

export function Editor({ docId, name }: { docId: string; name: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('connecting')
  const [peers, setPeers] = useState<Peer[]>([])
  const [versions, setVersions] = useState<Version[] | null>(null) // null = history panel closed
  const [preview, setPreview] = useState<{ id: number; text: string } | null>(null)
  const ytextRef = useRef<Y.Text>(null)

  useEffect(() => {
    // The Y.Doc is this browser's replica of the document. Every edit goes into it
    // first (so typing never waits for the network), then the provider ships it to the server.
    const ydoc = new Y.Doc()
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const provider = new WebsocketProvider(wsUrl, docId, ydoc)
    const ytext = ydoc.getText('code')
    ytextRef.current = ytext

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

  async function toggleHistory() {
    if (versions) return setVersions(null), setPreview(null)
    setVersions(await (await fetch(`/api/docs/${docId}/versions`)).json())
  }
  async function openVersion(id: number) {
    const { text } = await (await fetch(`/api/docs/${docId}/versions/${id}`)).json()
    setPreview({ id, text })
  }
  // Restoring is just another edit (replace everything with the old text), so it syncs
  // to everyone like any other change, and the current text stays in history too.
  function restore(text: string) {
    const ytext = ytextRef.current!
    ytext.doc!.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, text)
    })
    setPreview(null)
  }

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
        <button onClick={toggleHistory}>History</button>
        <button onClick={() => navigator.clipboard.writeText(location.href)}>Copy link</button>
      </header>
      <div className="main">
        <div ref={host} className="editor" />
        {versions && (
          <aside className="history">
            <h3>Versions</h3>
            {versions.length === 0 && <p>No snapshots yet (taken every minute while the document changes).</p>}
            {versions.map(v => (
              <button key={v.id} className={preview?.id === v.id ? 'active' : ''} onClick={() => openVersion(v.id)}>
                {new Date(v.createdAt).toLocaleString()}
              </button>
            ))}
            {preview && (
              <>
                <pre>{preview.text}</pre>
                <button onClick={() => restore(preview.text)}>Restore this version</button>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function hash(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
