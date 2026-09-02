import type { FrontendBlueprint } from "./blueprint"

export interface FrontendVerificationCommand {
  name: string
  command: string
  timeoutMs: number
}

export interface FrontendVerificationPlan {
  setup: FrontendVerificationCommand[]
  check: FrontendVerificationCommand[]
}

export function frontendVerification(bp: FrontendBlueprint): FrontendVerificationPlan {
  return {
    setup: [
      // Shot workspaces live under the spec repo (out/<app>-frontend-N), so a
      // plain `pnpm install` would be captured by the enclosing pnpm workspace
      // and install the MONOREPO's scope instead of the shot manifest —
      // leaving react/vite/playwright unresolvable. --ignore-workspace makes
      // every shot an independent package root: the same manifest, resolved
      // from the blueprint's exact pins, in every shot.
      { name: "install", command: "pnpm install --ignore-workspace --frozen-lockfile=false", timeoutMs: 600_000 },
      { name: "browser", command: "pnpm exec playwright install chromium", timeoutMs: 600_000 },
    ],
    check: [
      { name: "build", command: "pnpm build", timeoutMs: 180_000 },
      { name: "playwright", command: "pnpm exec playwright test -c conformance/playwright.config.ts", timeoutMs: 300_000 },
    ],
  }
}
