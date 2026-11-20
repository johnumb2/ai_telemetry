import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth, AuthUserRow } from '../lib/useAuth'

type Section = 'account' | 'admin'

export function UserMenu() {
  const { user, logout, changePassword, listUsers, createUser, updateUser, adminSetPassword } = useAuth()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<Section>('account')
  const [msg, setMsg] = useState<string | null>(null)

  // Change-password form state.
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  // Admin user-management state.
  const [rows, setRows] = useState<AuthUserRow[]>([])
  const [uBusy, setUBusy] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', email: '', password: '', is_admin: false })
  const [pwRows, setPwRows] = useState<Record<number, string>>({})

  const ref = useRef<HTMLDivElement>(null)

  const reloadUsers = useCallback(async () => {
    if (!user?.admin) return
    try {
      setRows(await listUsers())
    } catch {
      // transient; the table just shows empty / stale
    }
  }, [listUsers, user?.admin])

  useEffect(() => {
    if (open && user?.admin) void reloadUsers()
  }, [open, user?.admin, reloadUsers])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null

  async function onSubmitPassword(e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    setUBusy(false)
    setPwBusy(true)
    try {
      await changePassword(curPw, newPw)
      setCurPw('')
      setNewPw('')
      setMsg('Password updated. Other devices are signed out.')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setPwBusy(false)
    }
  }

  async function onSubmitNewUser(e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    setUBusy(true)
    try {
      await createUser(newUser)
      setNewUser({ username: '', email: '', password: '', is_admin: false })
      setMsg('User created.')
      await reloadUsers()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setUBusy(false)
    }
  }

  async function toggleField(id: number, field: 'admin' | 'disabled', value: boolean) {
    setMsg(null)
    setUBusy(true)
    try {
      await updateUser(id, { [field]: value })
      await reloadUsers()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setUBusy(false)
    }
  }

  async function submitSetPassword(id: number, e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    setUBusy(true)
    const pw = pwRows[id] ?? ''
    try {
      await adminSetPassword(id, pw)
      setPwRows((p) => ({ ...p, [id]: '' }))
      setMsg(`Password set for ${rows.find((r) => r.id === id)?.username}.`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Set password failed')
    } finally {
      setUBusy(false)
    }
  }

  async function onLogout() {
    await logout()
    setOpen(false)
  }

  return (
    <div className="usermenu-wrap" ref={ref}>
      <button
        type="button"
        className="usermenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="usermenu-avatar" aria-hidden="true">
          {user.username.charAt(0).toUpperCase()}
        </span>
        <span className="usermenu-name">{user.username}</span>
        <span className={`usermenu-badge ${user.admin ? 'usermenu-badge-admin' : ''}`}>
          {user.admin ? 'admin' : 'user'}
        </span>
      </button>

      {open && (
        <div className="usermenu-pop" role="menu" aria-label="Account">
          <div className="usermenu-head">
            <div>
              <div className="usermenu-title">{user.username}</div>
              <div className="usermenu-sub">{user.email}</div>
            </div>
          </div>

          {msg && <div className={msg.startsWith('Password') || msg.startsWith('User') || msg.endsWith('signed out.') ? 'usermenu-ok' : 'usermenu-err'}>{msg}</div>}

          {user.admin && (
            <div className="usermenu-tabs">
              <button type="button" className={`usermenu-tab ${section === 'account' ? 'usermenu-tab-active' : ''}`} onClick={() => setSection('account')}>
                Account
              </button>
              <button type="button" className={`usermenu-tab ${section === 'admin' ? 'usermenu-tab-active' : ''}`} onClick={() => setSection('admin')}>
                Users ({rows.length})
              </button>
            </div>
          )}

          {(!user.admin || section === 'account') && (
            <form className="usermenu-account" onSubmit={onSubmitPassword}>
              <div className="usermenu-account-row">
                <label className="usermenu-label" htmlFor="um-cur">Current password</label>
                <input id="um-cur" className="usermenu-input" type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} disabled={pwBusy} required />
              </div>
              <div className="usermenu-account-row">
                <label className="usermenu-label" htmlFor="um-new">New password</label>
                <input id="um-new" className="usermenu-input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} disabled={pwBusy} required minLength={6} />
              </div>
              <div className="usermenu-account-actions">
                <button className="usermenu-save" type="submit" disabled={pwBusy}>
                  {pwBusy ? 'Saving…' : 'Change password'}
                </button>
                <button
                  type="button"
                  className="usermenu-logout"
                  disabled={pwBusy}
                  onClick={() => void onLogout()}
                >
                  Sign out
                </button>
              </div>
            </form>
          )}

          {user.admin && section === 'admin' && (
            <div className="usermenu-admin">
              <div className="usermenu-users">
                <table className="usermenu-table">
                  <colgroup>
                    <col />
                    <col />
                    <col className="usermenu-col-toggle" />
                    <col className="usermenu-col-toggle" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Email</th>
                      <th>Admin</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="usermenu-td-name">{r.username}</td>
                        <td className="usermenu-td-email">{r.email}</td>
                        <td>
                          <button
                            type="button"
                            className={`usermenu-toggle ${r.admin ? 'usermenu-toggle-on' : ''}`}
                            disabled={uBusy || (r.id === user.id && !r.admin)}
                            aria-label={`admin for ${r.username}`}
                            aria-pressed={r.admin}
                            onClick={() => {
                              const nv = !r.admin
                              if (r.id === user.id && nv === false) {
                                setMsg('You cannot remove your own admin role.')
                                return
                              }
                              void toggleField(r.id, 'admin', nv)
                            }}
                          >
                            {r.admin ? 'on' : 'off'}
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`usermenu-toggle ${r.disabled ? 'usermenu-toggle-off' : 'usermenu-toggle-on'}`}
                            disabled={uBusy || (r.id === user.id && !r.disabled)}
                            aria-label={`active for ${r.username}`}
                            aria-pressed={!r.disabled}
                            onClick={() => {
                              const nv = !r.disabled
                              if (r.id === user.id && nv === true) {
                                setMsg('You cannot disable yourself.')
                                return
                              }
                              void toggleField(r.id, 'disabled', nv)
                            }}
                          >
                            {r.disabled ? 'disabled' : 'active'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <form className="usermenu-newuser" onSubmit={onSubmitNewUser}>
                <div className="usermenu-newuser-head">Add a user</div>
                <div className="usermenu-newuser-grid">
                  <input
                    className="usermenu-input"
                    type="text"
                    placeholder="Username"
                    value={newUser.username}
                    onChange={(e) => setNewUser((n) => ({ ...n, username: e.target.value }))}
                    disabled={uBusy}
                    required
                    minLength={2}
                    maxLength={32}
                  />
                  <input
                    className="usermenu-input"
                    type="email"
                    placeholder="Email"
                    value={newUser.email}
                    onChange={(e) => setNewUser((n) => ({ ...n, email: e.target.value }))}
                    disabled={uBusy}
                    required
                  />
                </div>
                <div className="usermenu-newuser-grid">
                  <input
                    className="usermenu-input"
                    type="password"
                    placeholder="Temp password (min 6)"
                    value={newUser.password}
                    onChange={(e) => setNewUser((n) => ({ ...n, password: e.target.value }))}
                    disabled={uBusy}
                    required
                    minLength={6}
                  />
                  <label className="usermenu-check">
                    <input
                      type="checkbox"
                      checked={newUser.is_admin}
                      onChange={(e) => setNewUser((n) => ({ ...n, is_admin: e.target.checked }))}
                      disabled={uBusy}
                    />
                    Admin
                  </label>
                </div>
                <div className="usermenu-account-actions">
                  <button className="usermenu-save" type="submit" disabled={uBusy}>
                    {uBusy ? 'Creating…' : 'Create user'}
                  </button>
                </div>
              </form>

              <div className="usermenu-setpw">
                <div className="usermenu-setpw-head">Set a password</div>
                {rows.map((r) => (
                  <form key={r.id} className="usermenu-setpw-row" onSubmit={(e) => void submitSetPassword(r.id, e)}>
                    <span className="usermenu-setpw-name">{r.username}</span>
                    <input
                      className="usermenu-input"
                      type="password"
                      placeholder="new password"
                      value={pwRows[r.id] ?? ''}
                      onChange={(e) => setPwRows((p) => ({ ...p, [r.id]: e.target.value }))}
                      disabled={uBusy}
                      minLength={6}
                    />
                    <button className="usermenu-mini" type="submit" disabled={uBusy || !pwRows[r.id]}>
                      Set
                    </button>
                  </form>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
