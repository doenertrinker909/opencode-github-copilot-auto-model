import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import { autoDrafts, capiBase, endpointKey, familyLabel, slugify } from "../src/index"

const model = (overrides: Record<string, unknown>) =>
  ({
    id: "gpt-5.6-luna",
    modelID: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    family: "gpt-luna",
    package: "aisdk:@ai-sdk/github-copilot",
    settings: { baseURL: "https://api.individual.githubcopilot.com", endpoint: "responses" },
    enabled: true,
    ...overrides,
  }) as never

describe("package metadata", () => {
  test("is the V2 port", () => {
    expect(pkg.version).toBe("0.3.0")
    expect(pkg.main).toBe("./dist/index.js")
  })
})

describe("familyLabel", () => {
  test("labels GPT and Codex models", () => {
    expect(familyLabel(model({}))).toBe("GPT")
    expect(familyLabel(model({ id: "gpt-5.3-codex", name: "GPT-5.3 Codex", family: "gpt-codex" }))).toBe("GPT")
  })

  test("labels Claude models", () => {
    expect(
      familyLabel(model({ id: "claude-haiku-4.5", name: "Claude Haiku 4.5", family: "claude-haiku" })),
    ).toBe("Claude")
  })

  test("labels Microsoft and Kimi models", () => {
    expect(familyLabel(model({ id: "mai-code-1.1-flash", name: "MAI Code 1.1 Flash", family: "mai" }))).toBe(
      "Microsoft",
    )
    expect(familyLabel(model({ id: "kimi-k3", name: "Kimi K3", family: "kimi-k3" }))).toBe("Kimi")
  })

  test("returns undefined without a model", () => {
    expect(familyLabel(undefined)).toBeUndefined()
  })
})

describe("endpointKey", () => {
  test("groups models that share transport", () => {
    const a = model({ id: "gpt-5.6-luna" })
    const b = model({ id: "gpt-6-luna", family: "gpt-luna" })
    expect(endpointKey(a)).toBe(endpointKey(b))
  })

  test("separates different endpoints", () => {
    const a = model({})
    const b = model({ settings: { baseURL: "https://api.githubcopilot.com", endpoint: "chat" } })
    expect(endpointKey(a)).not.toBe(endpointKey(b))
  })
})

describe("capiBase", () => {
  test("strips a trailing /v1", () => {
    expect(capiBase("https://api.githubcopilot.com/v1")).toBe("https://api.githubcopilot.com")
  })

  test("strips trailing slashes", () => {
    expect(capiBase("https://api.githubcopilot.com///")).toBe("https://api.githubcopilot.com")
  })
})

describe("slugify", () => {
  test("lowercases and joins words", () => {
    expect(slugify("Auto GPT/Codex")).toBe("auto-gpt-codex")
  })
})

describe("autoDrafts", () => {
  test("always injects the legacy auto", () => {
    const drafts = autoDrafts({})
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.requestedID).toBe("auto")
    expect(drafts[0]?.requestedName).toBe("Auto")
  })

  test("adds configured autos in order", () => {
    const drafts = autoDrafts({
      autos: [{ name: "Auto GPT/Codex", preferredModels: ["gpt-5.6-luna"] }, { id: "fast" }],
    })
    expect(drafts.map((d) => d.requestedID)).toEqual(["auto", undefined, "fast"])
    expect(drafts[1]?.requestedName).toBe("Auto GPT/Codex")
  })

  test("empties the family defaults when autos is an explicit list", () => {
    expect(autoDrafts({ autos: [] })).toHaveLength(1)
  })
})
