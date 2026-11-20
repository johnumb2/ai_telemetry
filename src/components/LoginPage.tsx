import { useEffect, useState } from 'react'
import { useAuth } from '../lib/useAuth'

interface LoginPageProps {
  token: string | null
  onResetDone: () => void
}

type Mode = 'login' | 'forgot' | 'reset'

export function LoginPage({ token, onResetDone }: LoginPageProps) {
  const { login, requestForgot, validateReset, confirmReset } = useAuth()

  const [mode, setMode] = useState<Mode>(token ? 'reset' : 'login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // If the reset link's token turns out to be invalid, fall back to login.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    validateReset(token).then((ok) => {
      if (cancelled) return
      if (!ok) {
        setMode('login')
        setError('That reset link is invalid or has expired.')
      }
    })
    return () => {
      cancelled = true
    }
  }, [token, validateReset])

  async function onSubmitLogin(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username.trim(), password)
      setBusy(false)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Login failed')
    }
  }

  async function onSubmitForgot(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await requestForgot(email.trim())
      setBusy(false)
      setMode('login')
      setNotice('If that account exists, a reset link is on its way.')
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Request failed')
    }
  }

  async function onSubmitReset(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!token) return
    setBusy(true)
    try {
      await confirmReset(token, newPassword)
      setBusy(false)
      onResetDone()
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Reset failed')
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-wordmark">PULSE</span>
          <p className="login-tag">AI inference operations · secure access</p>
        </div>

        {notice && <div className="login-notice">{notice}</div>}
        {error && <div className="login-error">{error}</div>}

        {mode === 'login' && (
          <form className="login-form" onSubmit={onSubmitLogin}>
            <label className="login-label" htmlFor="login-username">Username</label>
            <input
              id="login-username"
              className="login-input"
              type="text"
              value={username}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              required
            />
            <label className="login-label" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              className="login-input"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
            <button className="login-btn" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="login-foot">
              <button
                type="button"
                className="login-link"
                disabled={busy}
                onClick={() => {
                  setNotice(null)
                  setError(null)
                  setMode('forgot')
                }}
              >
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form className="login-form" onSubmit={onSubmitForgot}>
            <p className="login-hint">Enter the email on your account and we&apos;ll send a reset link.</p>
            <label className="login-label" htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              className="login-input"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
            <button className="login-btn" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <div className="login-foot">
              <button
                type="button"
                className="login-link"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setNotice(null)
                  setMode('login')
                }}
              >
                Back to sign in
              </button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form className="login-form" onSubmit={onSubmitReset}>
            <p className="login-hint">Set a new password for this account.</p>
            <label className="login-label" htmlFor="reset-password">New password</label>
            <input
              id="reset-password"
              className="login-input"
              type="password"
              value={newPassword}
              autoComplete="new-password"
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
              required
              minLength={6}
            />
            <button className="login-btn" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
