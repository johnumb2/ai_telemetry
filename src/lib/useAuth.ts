import { useCallback, useEffect, useState } from 'react'

/** A PULSE account as returned by the auths sidecar. */
export interface AuthUser {
  id: number
  username: string
  email: string
  admin: boolean
}

/** A full user row from the admin list (adds account flags). */
export interface AuthUserRow {
  id: number
  username: string
  email: string
  admin: boolean
  disabled: boolean
  created_at: string
}

export type AuthStatus = 'loading' | 'in' | 'out'

export interface NewUser {
  username: string
  email: string
  password: string
  is_admin: boolean
}

interface ApiError {
  ok?: boolean
  error?: string
}

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const resp = await fetch(url, { credentials: 'same-origin', ...opts })
  const data = (await resp.json().catch(() => ({}))) as Partial<T> & ApiError
  if (!resp.ok || (data as ApiError).ok === false) {
    // Prefer the server's own error text; fall back to a generic message.
    throw new Error((data as ApiError).error || `HTTP ${resp.status}`)
  }
  return data as T
}

function isHttpError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && (e as { name: string }).name === 'AbortError'
}

export interface AuthHook {
  user: AuthUser | null
  status: AuthStatus
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  requestForgot: (email: string) => Promise<void>
  validateReset: (token: string) => Promise<boolean>
  confirmReset: (token: string, password: string) => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
  listUsers: () => Promise<AuthUserRow[]>
  createUser: (n: NewUser) => Promise<AuthUser>
  updateUser: (
    id: number,
    patch: { email?: string; admin?: boolean; disabled?: boolean },
  ) => Promise<AuthUser>
  adminSetPassword: (id: number, password: string) => Promise<void>
}

export function useAuth(): AuthHook {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ user: AuthUser }>('/api/session')
      setUser(d.user)
      setStatus('in')
    } catch (e) {
      if (isHttpError(e)) return
      // A 401/403 means not logged in (or the server is unreachable).
      setUser(null)
      setStatus('out')
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    await api<{ user: AuthUser }>('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    await refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    await api<unknown>('/api/logout', { method: 'POST' })
    await refresh()
  }, [refresh])

  const requestForgot = useCallback(async (email: string) => {
    await api<{ ok: boolean }>('/api/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  }, [])

  const validateReset = useCallback(async (token: string) => {
    try {
      await api<{ ok: boolean }>(`/api/reset?token=${encodeURIComponent(token)}`)
      return true
    } catch (e) {
      if (isHttpError(e)) return false
      return false
    }
  }, [])

  const confirmReset = useCallback(
    async (token: string, password: string) => {
      // The server reads the token from the query string and takes the new
      // password as the body field.
      await api<{ ok: boolean }>(`/api/reset?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: password }),
      })
      await refresh()
    },
    [refresh],
  )

  const changePassword = useCallback(
    async (current: string, next: string) => {
      await api<{ ok: boolean }>('/api/session/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      // The server invalidates other sessions but keeps this one; re-read it.
      await refresh()
    },
    [refresh],
  )

  const listUsers = useCallback(async () => (await api<{ users: AuthUserRow[] }>('/api/users')).users, [])

  const createUser = useCallback(
    async (n: NewUser) =>
      (await api<{ user: AuthUser }>(
        '/api/users',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(n),
        },
      )).user,
    [],
  )

  const updateUser = useCallback(
    async (id: number, patch: { email?: string; admin?: boolean; disabled?: boolean }) =>
      (await api<{ user: AuthUser }>(`/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })).user,
    [],
  )

  const adminSetPassword = useCallback(
    async (id: number, password: string) => {
      await api<{ ok: boolean }>(`/api/users/${id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: password }),
      })
    },
    [],
  )

  // Keep the session alive and pick up expirations/disabling without spamming.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh()
    }, 10000)
    return () => window.clearInterval(id)
  }, [refresh])

  return {
    user,
    status,
    login,
    logout,
    requestForgot,
    validateReset,
    confirmReset,
    changePassword,
    listUsers,
    createUser,
    updateUser,
    adminSetPassword,
  }
}
