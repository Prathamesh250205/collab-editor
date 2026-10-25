import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { yCollab } from 'y-codemirror.next'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { SERVER_URL, WS_URL } from './config.ts'
import { inkTheme, colorFor } from './cmTheme.ts'
import { Logo } from './Logo.tsx'

type Peer = { id: number; name: string; color: string; me: boolean }
type Version = { id: number; createdAt: string; bytes: number }

type Props = { docId: string; name: string; token: string; onLogout: () => void }

export function Editor({ docId, name, token, onLogout }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('connecting')
  const [peers, setPeers] = useState<Peer[]>([])
  const [versions, setVersions] = useState<Version[] | null>(null) // null = history panel closed
  const [preview, setPreview] = useState<{ id: number; text: string } | null>(null)
  const [toast, setToast] = useState('')
  const ytextRef = useRef<Y.Text>(null)

  useEffect(() => {
    // The Y.Doc is this browser's replica of the document. Every edit goes into it
    // first (so typing never waits for the network), then the provider ships it to the server.
    const ydoc = new Y.Doc()
    // Offline support: every edit is also stored in the browser (IndexedDB), so the
    // document opens and stays editable with no network, even after a reload.
    // When the socket reconnects, the sync handshake exchanges only the missing
    // updates in both directions, and the CRDT merges them without conflicts.
    const local = new IndexeddbPersistence(`doc-${docId}`, ydoc)
    const provider = new WebsocketProvider(WS_URL, docId, ydoc, { params: { token } })
    const ytext = ydoc.getText('code')
    ytextRef.current = ytext

    const color = colorFor(name)
    // y-codemirror reads `user` from awareness to draw our cursor on other screens.
    provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '33' })

    const updatePeers = () =>
      setPeers(
        [...provider.awareness.getStates()]
          .filter(([, s]) => s.user)
          .map(([id, s]) => ({ id, name: s.user.name, color: s.user.color, me: id === ydoc.clientID })),
      )
    provider.awareness.on('change', updatePeers)
    provider.on('status', ({ status }: { status: string }) => setStatus(status))

    const view = new EditorView({
      parent: host.current!,
      doc: ytext.toString(), // start from whatever the replica already holds
      // yCollab binds CodeMirror <-> Y.Text both ways and renders remote cursors.
      extensions: [basicSetup, javascript({ typescript: true }), inkTheme, yCollab(ytext, provider.awareness, { undoManager: new Y.UndoManager(ytext) })],
    })
    view.focus()
    updatePeers()

    return () => {
      view.destroy()
      provider.destroy()
      local.destroy()
      ydoc.destroy()
    }
  }, [docId, name, token])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(t)
  }, [toast])

  const api = (path: string) => fetch(`${SERVER_URL}/api/docs/${docId}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())

  async function toggleHistory() {
    if (versions) return setVersions(null), setPreview(null)
    setVersions(await api('/versions'))
  }
  async function openVersion(id: number) {
    const { text } = await api(`/versions/${id}`)
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
    setVersions(null)
    setToast('Version restored')
  }

  const online = status === 'connected'

  return (
    <div className="editor-page">
      <header className="ed-bar">
        <a href="/" className="brand" aria-label="Home">
          <Logo />
        </a>
        <button
          className="doc-chip mono"
          onClick={() => navigator.clipboard.writeText(location.href).then(() => setToast('Link copied, send it to a collaborator'))}
          title="Copy share link"
        >
          /d/{docId}
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden><path d="M9 9h10v10H9zM5 15V5h10" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        </button>

        <div className={`status-pill ${online ? 'on' : 'off'}`} role="status">
          <span className="pulse" />
          {online ? 'Live' : 'Offline · saving locally'}
        </div>

        <div className="ed-spacer" />

        <ul className="avatars" aria-label="People in this document">
          <AnimatePresence initial={false}>
            {peers.map(p => (
              <motion.li
                key={p.id}
                layout
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 28 }}
                style={{ background: p.color }}
                title={p.me ? `${p.name} (you)` : p.name}
              >
                {p.name.slice(0, 2).toUpperCase()}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>

        <button className={`btn btn-ghost btn-sm ${versions ? 'is-active' : ''}`} onClick={toggleHistory}>History</button>
        <button className="btn btn-ghost btn-sm" onClick={onLogout} title={`Signed in as ${name}`}>Log out</button>
      </header>

      <div className="ed-main">
        <div ref={host} className="ed-editor" />
        <AnimatePresence>
          {versions && (
            <motion.aside
              className="history"
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            >
              <div className="history-head">
                <h3>Version history</h3>
                <span className="mono muted">snapshot every minute of editing</span>
              </div>
              {versions.length === 0 && <p className="muted">No snapshots yet. Keep typing; the first one appears within a minute.</p>}
              <div className="history-list">
                {versions.map((v, i) => (
                  <motion.button
                    key={v.id}
                    className={`version ${preview?.id === v.id ? 'active' : ''}`}
                    onClick={() => openVersion(v.id)}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                  >
                    <span>{timeAgo(v.createdAt)}</span>
                    <span className="mono muted">{new Date(v.createdAt).toLocaleTimeString()}</span>
                  </motion.button>
                ))}
              </div>
              {preview && (
                <div className="preview">
                  <pre className="mono">{preview.text || '(empty)'}</pre>
                  <button className="btn btn-primary btn-sm" onClick={() => restore(preview.text)}>Restore this version</button>
                </div>
              )}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div className="toast" role="status" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}
