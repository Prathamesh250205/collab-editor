import { createRoot } from 'react-dom/client'
import { Editor } from './Editor.tsx'

// No router library: the only routes are "/" (home) and "/d/<docId>" (a document).
// The document link *is* the share link.
function App() {
  const docId = location.pathname.match(/^\/d\/([\w-]{1,64})$/)?.[1]
  const name = getName()
  if (docId) return <Editor docId={docId} name={name} />
  return (
    <main className="home">
      <h1>Collab Editor</h1>
      <p>Real-time collaborative code editing. Create a document and share the link.</p>
      <button onClick={() => location.assign(`/d/${crypto.randomUUID().slice(0, 8)}`)}>New document</button>
    </main>
  )
}

function getName() {
  let name = localStorage.getItem('name')
  if (!name) {
    name = prompt('Your name?')?.trim() || `guest-${Math.floor(Math.random() * 1000)}`
    localStorage.setItem('name', name)
  }
  return name
}

createRoot(document.getElementById('root')!).render(<App />)
