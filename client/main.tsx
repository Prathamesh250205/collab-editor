import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from './Editor.tsx'
import { SERVER_URL } from './config.ts'

// Wake the server as soon as the page opens: a free host that went to sleep
// takes a while to start, and this overlaps that with the user typing their login.
fetch(`${SERVER_URL}/api/health`).catch(() => {})

type Session = { username: string; token: string }

// No router library: the only routes are "/" (home) and "/d/<docId>" (a document).
// The document link *is* the share link.
function App() {
  const [session, setSession] = useState<Session | null>(loadSession)
  if (!session) return <Login onLogin={s => (localStorage.setItem('session', JSON.stringify(s)), setSession(s))} />

  const logout = () => (localStorage.removeItem('session'), setSession(null))
  const docId = location.pathname.match(/^\/d\/([\w-]{1,64})$/)?.[1]
  if (docId) return <Editor docId={docId} name={session.username} token={session.token} onLogout={logout} />
  return (
    <main className="home">
      <h1>Collab Editor</h1>
      <p>Real-time collaborative code editing. Create a document and share the link.</p>
      <button onClick={() => location.assign(`/d/${crypto.randomUUID().slice(0, 8)}`)}>New document</button>{' '}
      <button onClick={logout}>Log out ({session.username})</button>
    </main>
  )
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent<HTMLFormElement>, action: 'login' | 'register') {
    e.preventDefault()
    const form = new FormData(e.currentTarget.closest('form')!)
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${SERVER_URL}/api/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) onLogin(body)
      else setError(body.error ?? 'something went wrong')
    } catch {
      setError('cannot reach the server, try again in a moment')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="home">
      <h1>Collab Editor</h1>
      <form className="login" onSubmit={e => submit(e, 'login')}>
        <label>Username <input name="username" autoComplete="username" required /></label>
        <label>Password <input name="password" type="password" autoComplete="current-password" required minLength={8} /></label>
        {error && <p className="error">{error}</p>}
        {busy && <p>Connecting… the free server can take up to a minute to wake up.</p>}
        <div>
          <button type="submit" disabled={busy}>Log in</button>{' '}
          <button type="button" disabled={busy} onClick={e => submit(e as unknown as React.FormEvent<HTMLFormElement>, 'register')}>Create account</button>
        </div>
      </form>
    </main>
  )
}

// A stored token is dropped once it has expired (the server would reject it anyway).
function loadSession(): Session | null {
  try {
    const s: Session = JSON.parse(localStorage.getItem('session') ?? 'null')
    const { exp } = JSON.parse(atob(s.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))
    return exp > Date.now() ? s : null
  } catch {
    return null
  }
}

createRoot(document.getElementById('root')!).render(<App />)
