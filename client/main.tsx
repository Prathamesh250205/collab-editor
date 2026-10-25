import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, MotionConfig } from 'motion/react'
import '@fontsource-variable/inter-tight'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/instrument-serif/400-italic.css'
import './styles.css'
import { Editor } from './Editor.tsx'
import { Landing } from './Landing.tsx'
import { Auth, type Session } from './Auth.tsx'
import { SERVER_URL } from './config.ts'

// Wake the server as soon as the page opens: a free host that went to sleep
// takes a while to start, and this overlaps that with the user typing their login.
fetch(`${SERVER_URL}/api/health`).catch(() => {})

const newDocUrl = () => `/d/${crypto.randomUUID().slice(0, 8)}`

// No router library: the only routes are "/" (landing) and "/d/<docId>" (a document).
// The document link *is* the share link.
function App() {
  const [session, setSession] = useState<Session | null>(loadSession)
  const [authOpen, setAuthOpen] = useState(false)
  const docId = location.pathname.match(/^\/d\/([\w-]{1,64})$/)?.[1]

  function login(s: Session) {
    localStorage.setItem('session', JSON.stringify(s))
    setSession(s)
    setAuthOpen(false)
    if (!docId) location.assign(newDocUrl())
  }
  const logout = () => (localStorage.removeItem('session'), setSession(null))

  if (docId) {
    if (session) return <Editor docId={docId} name={session.username} token={session.token} onLogout={logout} />
    return (
      <div className="gate">
        <div className="grain" aria-hidden />
        <Auth onLogin={login} />
      </div>
    )
  }

  return (
    <>
      <Landing username={session?.username} onStart={() => (session ? location.assign(newDocUrl()) : setAuthOpen(true))} />
      <AnimatePresence>{authOpen && <Auth onLogin={login} onClose={() => setAuthOpen(false)} />}</AnimatePresence>
    </>
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

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>,
)
