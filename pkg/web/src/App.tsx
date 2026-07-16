import { useEffect, useRef, useState } from "react"
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router"
import { Button, buttonVariants } from "@/components/ui/button"
import { useAuth } from "@/lib/auth-context"
import { authService, createApiClient } from "@/lib/auth"

function safeReturnTo(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/"
}

const rootRoute = createRootRoute({ component: () => <Outlet /> })

function HomePage() {
  const [pingResult, setPingResult] = useState<string | null>(null)
  const { token, signOut } = useAuth()

  async function handlePing() {
    const res = await createApiClient().api.ping.$post()
    const data = await res.json()
    setPingResult(data.time)
  }

  return (
    <Page>
      <h1 className="font-medium">Scorecard</h1>
      <p>Project ready!</p>
      <Button className="mt-2" onClick={handlePing}>
        POST /api/ping
      </Button>
      {pingResult && <p className="mt-2 font-mono text-xs text-muted-foreground">{pingResult}</p>}
      <div className="mt-4 flex gap-2">
        {token ? (
          <>
            <Link className={buttonVariants({ variant: "outline" })} to="/me">My profile</Link>
            <Button variant="outline" onClick={signOut}>Sign out</Button>
          </>
        ) : (
          <Link className={buttonVariants({ variant: "outline" })} to="/login" search={{ returnTo: "/" }}>Sign in</Link>
        )}
      </div>
    </Page>
  )
}

function LoginPage() {
  const { returnTo } = loginRoute.useSearch()
  const { requestCode, useCode } = useAuth()
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      authService.setReturnTo(returnTo)
      await requestCode(email)
      setStatus("Check your email for an 8-digit code or magic link.")
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to send a code.")
    } finally {
      setLoading(false)
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await useCode(email, code)
      window.location.assign(authService.getReturnTo())
    } catch (useCodeError) {
      setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page>
      <h1 className="font-medium">Sign in</h1>
      <p>We’ll email you a one-time code.</p>
      <form className="mt-4 flex flex-col gap-3" onSubmit={submit}>
        <input
          className="rounded-md border bg-transparent px-3 py-2"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <Button type="submit" disabled={loading}>{loading ? "Sending…" : "Email me a code"}</Button>
      </form>
      {status && <p className="mt-3 text-sm text-muted-foreground">{status}</p>}
      {status && (
        <form className="mt-4 flex flex-col gap-3" onSubmit={verifyCode}>
          <input
            className="rounded-md border bg-transparent px-3 py-2"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="8-digit code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
            required
            pattern="[0-9]{8}"
          />
          <Button type="submit" disabled={loading || code.length !== 8}>{loading ? "Signing in…" : "Sign in with code"}</Button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </Page>
  )
}

function MagicLinkPage() {
  const { email, code } = magicRoute.useSearch()
  const { useCode } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    if (!email || !code) {
      setError("This magic link is incomplete.")
      return
    }

    void useCode(email, code)
      .then(() => window.location.assign(authService.getReturnTo()))
      .catch((useCodeError) => setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in."))
  }, [code, email, useCode])

  return <Page><h1 className="font-medium">Signing you in…</h1>{error && <p className="mt-3 text-sm text-destructive">{error}</p>}</Page>
}

function MePage() {
  const { client, signOut } = useAuth()
  const [profile, setProfile] = useState<{ id: string; email: string; name: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client) return
    void client.api.me.$get().then(async (response) => {
      if (!response.ok) {
        setError("Unable to load your profile.")
        return
      }
      const { user } = await response.json()
      setProfile(user)
    })
  }, [client])

  return (
    <Page>
      <h1 className="font-medium">My profile</h1>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {!profile && !error && <p className="mt-3 text-muted-foreground">Loading…</p>}
      {profile && <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt>ID</dt><dd>{profile.id}</dd><dt>Email</dt><dd>{profile.email}</dd><dt>Name</dt><dd>{profile.name ?? "—"}</dd></dl>}
      <div className="mt-4 flex gap-2"><Link className={buttonVariants({ variant: "outline" })} to="/">Home</Link><Button variant="outline" onClick={signOut}>Sign out</Button></div>
    </Page>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  const location = useLocation()
  if (!token) return <Navigate to="/login" search={{ returnTo: `${location.pathname}${location.search}${location.hash}` }} />
  return children
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh p-6"><main className="flex max-w-md min-w-0 flex-col text-sm leading-loose">{children}</main></div>
}

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage })
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => ({ returnTo: safeReturnTo(search.returnTo) }),
  component: LoginPage,
})
const magicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/magic",
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === "string" ? search.email : "",
    code: typeof search.code === "string" ? search.code : "",
  }),
  component: MagicLinkPage,
})
const meRoute = createRoute({ getParentRoute: () => rootRoute, path: "/me", component: () => <RequireAuth><MePage /></RequireAuth> })
const routeTree = rootRoute.addChildren([indexRoute, loginRoute, magicRoute, meRoute])
const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

export function App() {
  return <RouterProvider router={router} />
}

export default App
