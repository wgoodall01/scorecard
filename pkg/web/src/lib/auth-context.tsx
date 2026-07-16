import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { authService, createApiClient, type ApiClient } from "@/lib/auth"

type AuthContextValue = {
  token: string | null
  client: ApiClient | null
  requestCode: (email: string) => Promise<void>
  register: (email: string, name: string) => Promise<void>
  useCode: (email: string, code: string) => Promise<void>
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => authService.getToken())
  const client = useMemo(() => (token ? createApiClient(token) : null), [token])

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      client,
      requestCode: (email) => authService.requestCode(email),
      register: (email, name) => authService.register(email, name),
      useCode: async (email, code) => {
        setToken(await authService.useCode(email, code))
      },
      signOut: () => {
        authService.clearToken()
        setToken(null)
      },
    }),
    [client, token],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error("useAuth must be used within an AuthProvider")
  return value
}
