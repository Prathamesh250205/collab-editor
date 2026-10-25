import { useState } from 'react'
import { motion } from 'motion/react'
import { SERVER_URL } from './config.ts'

export type Session = { username: string; token: string }

export function Auth({ onLogin, onClose }: { onLogin: (s: Session) => void; onClose?: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${SERVER_URL}/api/${mode}`, {
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
    <motion.div className="auth-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.form
        className="auth"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'login' ? 'Log in' : 'Create account'}
        onSubmit={submit}
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      >
        <div className="auth-tabs" role="tablist">
          {(['login', 'register'] as const).map(m => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => (setMode(m), setError(''))}>
              {mode === m && <motion.span layoutId="auth-tab" className="auth-tab-bg" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />}
              <span>{m === 'login' ? 'Log in' : 'Create account'}</span>
            </button>
          ))}
        </div>
        <label>
          <span>Username</span>
          <input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[\w-]+" autoFocus />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} />
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        {busy && <p className="auth-note">Connecting… the free server can take up to a minute to wake up.</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </motion.form>
    </motion.div>
  )
}
