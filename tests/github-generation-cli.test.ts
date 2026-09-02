import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  TEMPORARY_REPOSITORY_WORKFLOW,
  temporaryShotLocalRoot,
  temporaryShotRepositoryName,
} from "../packages/cli/src/generate-github"

describe("GitHub generator per-shot repository topology", () => {
  it("derives a distinct remote repository and local checkout for every shot", () => {
    const firstRemote = temporaryShotRepositoryName("owner", "media-golden", "run-7", "shot-1")
    const secondRemote = temporaryShotRepositoryName("owner", "media-golden", "run-7", "shot-2")
    const firstLocal = temporaryShotLocalRoot("/source", "run-7", "shot-1")
    const secondLocal = temporaryShotLocalRoot("/source", "run-7", "shot-2")

    expect(firstRemote).toBe("owner/media-golden-run-7-shot-1")
    expect(secondRemote).toBe("owner/media-golden-run-7-shot-2")
    expect(firstRemote).not.toBe(secondRemote)
    expect(firstLocal).not.toBe(secondLocal)
    expect(path.dirname(firstLocal)).toBe(path.dirname(secondLocal))
  })

  it("bootstraps a required check from the immutable plan and pinned image", () => {
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain("name: spec-generation")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain("pull_request:")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain("spec/generate/$run_id/plan")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain(".acceptance.commands[]")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain(".environment.image")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain('docker pull "$image"')
  })
})
