import { useState } from "react"

import { Button } from "@/components/ui/button"
import { client } from "@/lib/api"

export function App() {
  const [pingResult, setPingResult] = useState<string | null>(null)

  async function handlePing() {
    const res = await client.api.ping.$post()
    const data = await res.json()
    setPingResult(data.time)
  }

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Project ready!</h1>
          <p>You may now add components and start building.</p>
          <Button className="mt-2" onClick={handlePing}>
            POST /api/ping
          </Button>
          {pingResult && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              {pingResult}
            </p>
          )}
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
      </div>
    </div>
  )
}

export default App
