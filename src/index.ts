import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const MODEL_ID = "auto"
const PROVIDER_ID = "github-copilot"
const COPILOT_API_VERSION = "2026-06-01"
const INTENT_TIMEOUT_MS = 1000
const SESSION_REFRESH_SKEW_MS = 60_000

type SourceModel = {
  id: string
  modelID: string
  name: string
  family?: string
  package: string
  settings: { baseURL?: string; endpoint?: string } & Record<string, unknown>
  enabled: boolean
  capabilities?: Record<string, unknown>
  variants?: unknown
  limit?: Record<string, number>
  cost?: unknown
  time?: unknown
  status?: string
}

type AutoSession = {
  selectedModelID: string
  sessionToken: string
  availableModels: string[]
  expiresAtMs: number
}

type ConvState = {
  session?: AutoSession
  sessionInflight?: Promise<AutoSession | undefined>
  lastPrompt?: string
  routedModelID?: string
  routedLabel?: "needs_reasoning" | "no_reasoning"
  needsReEval?: boolean
  previousModel?: string
  turn: number
}

type RouterDecision = {
  predicted_label?: "needs_reasoning" | "no_reasoning"
  confidence?: number
  candidate_models?: string[]
}

type AutoConfig = {
  id?: string
  name?: string
  preferredModels?: string[]
  reasoning?: string[]
  noReasoning?: string[]
}

type Options = {
  preferredModels?: string[]
  reasoning?: string[]
  noReasoning?: string[]
  autos?: AutoConfig[]
}

type AutoDraft = {
  requestedID?: string
  requestedName?: string
  preferredModels: string[]
  reasoning: string[]
  noReasoning: string[]
  legacy: boolean
  index: number
  familyFilter?: string
}

type InjectedAuto = {
  id: string
  name: string
  preferredModels: string[]
  reasoning: string[]
  noReasoning: string[]
  preferredApiIDs: string[]
  reasoningApiIDs: string[]
  noReasoningApiIDs: string[]
  template: SourceModel
  catalogDefaultModelID: string
  familyFilter?: string
}

// --- logging ---------------------------------------------------------------------------

function logFile() {
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "opencode-github-copilot-auto-model",
      "plugin.log",
    )
  const xdg = process.env.XDG_STATE_HOME
  return path.join(xdg ?? path.join(homedir(), ".local", "state"), "opencode-github-copilot-auto-model", "plugin.log")
}

let logReady: Promise<void> | undefined
function log(msg: string) {
  const file = logFile()
  logReady ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
  void logReady.then(() => appendFile(file, `${new Date().toISOString()} info ${msg}\n`).catch(() => undefined))
}

// --- model helpers ---------------------------------------------------------------------

let catalog: SourceModel[] = []

export function familyLabel(model?: SourceModel): string | undefined {
  if (!model) return undefined
  const fingerprint = `${model.id} ${model.name} ${model.family ?? ""}`.toLowerCase()
  if (fingerprint.includes("claude")) return "Claude"
  if (fingerprint.includes("gemini")) return "Gemini"
  if (fingerprint.includes("microsoft") || fingerprint.includes("mai") || fingerprint.includes("raptor"))
    return "Microsoft"
  if (fingerprint.includes("kimi")) return "Kimi"
  if (fingerprint.includes("gpt") || fingerprint.includes("codex")) return "GPT"
  const pkg = model.package?.replace(/^aisdk:/, "").split("/").pop()?.replace(/^@/, "")
  return pkg ? pkg[0].toUpperCase() + pkg.slice(1) : undefined
}

export function endpointKey(model?: SourceModel): string | undefined {
  if (!model) return undefined
  return [model.package, model.settings?.baseURL ?? "", model.settings?.endpoint ?? ""].join("|")
}

export function capiBase(url: string) {
  const clean = url.replace(/\/+$/, "")
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean
}

function modelByApiId(apiId: string): SourceModel | undefined {
  return catalog.find((m) => m.modelID === apiId || m.id === apiId)
}

function isSameFamily(apiId: string | undefined, template: SourceModel): boolean {
  if (!apiId) return false
  if (apiId === template.modelID || apiId === template.id) return true
  const model = modelByApiId(apiId)
  return !!model && endpointKey(model) === endpointKey(template)
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values?.length) return []
  const deduped: string[] = []
  for (const v of values) {
    const s = v.trim()
    if (s && !deduped.includes(s)) deduped.push(s)
  }
  return deduped
}

function resolvePreferredApiIDs(preferred: string[]): string[] {
  const resolved: string[] = []
  for (const token of preferred) {
    const model = catalog.find((m) => m.id === token) ?? catalog.find((m) => m.modelID === token)
    if (model && !resolved.includes(model.modelID)) resolved.push(model.modelID)
  }
  return resolved
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function uniqueValue(base: string, used: Set<string>, suffix = "-"): string {
  let value = base || "auto"
  let counter = 2
  while (used.has(value)) {
    value = `${base}${suffix}${counter}`
    counter += 1
  }
  used.add(value)
  return value
}

function defaultFamilyDrafts(): AutoDraft[] {
  const counts = new Map<string, number>()
  for (const model of catalog) {
    const label = familyLabel(model)
    if (!label) continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const drafts: AutoDraft[] = []
  for (const [index, label] of ["Claude", "GPT"].entries()) {
    if ((counts.get(label) ?? 0) < 2) continue
    drafts.push({
      preferredModels: [],
      reasoning: [],
      noReasoning: [],
      legacy: false,
      index: index + 1,
      familyFilter: label,
    })
  }
  return drafts
}

export function autoDrafts(options: Options): AutoDraft[] {
  const drafts: AutoDraft[] = [
    {
      requestedID: MODEL_ID,
      requestedName: "Auto",
      preferredModels: normalizeList(options.preferredModels),
      reasoning: normalizeList(options.reasoning),
      noReasoning: normalizeList(options.noReasoning),
      legacy: true,
      index: 0,
    },
  ]
  if (options.autos === undefined) {
    drafts.push(...defaultFamilyDrafts())
    return drafts
  }
  for (const [index, auto] of options.autos.entries()) {
    drafts.push({
      requestedID: auto.id?.trim() || undefined,
      requestedName: auto.name?.trim() || undefined,
      preferredModels: normalizeList(auto.preferredModels),
      reasoning: normalizeList(auto.reasoning),
      noReasoning: normalizeList(auto.noReasoning),
      legacy: false,
      index: index + 1,
    })
  }
  return drafts
}

// --- Copilot auto endpoints ------------------------------------------------------------

function copilotHeaders(bearer: string, sessionToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
  }
  if (sessionToken) headers["Copilot-Session-Token"] = sessionToken
  return headers
}

async function fetchAutoSession(baseURL: string, bearer: string): Promise<AutoSession | undefined> {
  const now = Date.now()
  const response = await fetch(`${baseURL}/models/session`, {
    method: "POST",
    headers: copilotHeaders(bearer),
    body: JSON.stringify({ auto_mode: { model_hints: [MODEL_ID] } }),
  }).catch((error) => {
    log(`auto session fetch failed: ${String(error)}`)
    return undefined
  })
  if (!response) return undefined
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    log(`auto session fetch non-ok: ${response.status} ${body}`)
    return undefined
  }
  const data = (await response.json().catch(() => undefined)) as any
  if (!data || typeof data.session_token !== "string") {
    log("auto session fetch invalid payload (missing session_token)")
    return undefined
  }
  const availableModels = Array.isArray(data.available_models)
    ? (data.available_models.filter((m: unknown) => typeof m === "string") as string[])
    : []
  const selectedModelID = typeof data.selected_model === "string" ? data.selected_model : availableModels[0]
  if (!selectedModelID) {
    log("auto session fetch invalid payload (no selected_model and no available_models)")
    return undefined
  }
  const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : now + 30 * 60_000
  log(
    `auto session parsed: selected_model=${selectedModelID}, available_models=[${availableModels.join(", ")}]`,
  )
  return { selectedModelID, sessionToken: data.session_token, availableModels, expiresAtMs }
}

async function getRouterDecision(
  baseURL: string,
  bearer: string,
  sessionToken: string,
  prompt: string,
  availableModels: string[],
  context: Record<string, unknown>,
): Promise<RouterDecision | undefined> {
  const body = { prompt, available_models: availableModels, ...context }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), INTENT_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseURL}/models/session/intent`, {
      method: "POST",
      headers: copilotHeaders(bearer, sessionToken),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      log(`intent fetch non-ok: ${response.status} ${text}`)
      return undefined
    }
    const data = (await response.json().catch(() => undefined)) as RouterDecision | undefined
    log(`intent response: ${JSON.stringify(data)}`)
    return data
  } catch (error) {
    log(`intent fetch failed: ${String(error)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// --- plugin ----------------------------------------------------------------------------

export default Plugin.define({
  id: "opencode-github-copilot-auto-model",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    let autos: InjectedAuto[] = []
    const autoByID = new Map<string, InjectedAuto>()
    const states = new Map<string, ConvState>()

    const stateKey = (sessionID: string, autoID: string) => `${sessionID}\n${autoID}`
    function getConv(sessionID: string, autoID: string): ConvState {
      const key = stateKey(sessionID, autoID)
      let conv = states.get(key)
      if (!conv) {
        conv = { turn: 0 }
        states.set(key, conv)
      }
      return conv
    }

    async function ensureSession(
      sessionID: string,
      autoID: string,
      baseURL: string,
      bearer: string,
    ): Promise<AutoSession | undefined> {
      const conv = getConv(sessionID, autoID)
      if (conv.session && Date.now() < conv.session.expiresAtMs - SESSION_REFRESH_SKEW_MS) return conv.session
      if (!conv.sessionInflight) {
        conv.sessionInflight = fetchAutoSession(baseURL, bearer)
          .then((session) => {
            if (session) conv.session = session
            return conv.session
          })
          .finally(() => {
            conv.sessionInflight = undefined
          })
      }
      return conv.sessionInflight
    }

    function buildAutos(
      source: SourceModel[],
      options: Options,
    ): { injected: InjectedAuto[]; models: SourceModel[] } {
      const drafts = autoDrafts(options)
      const usedIDs = new Set<string>([...source.map((m) => m.id), MODEL_ID])
      const usedNames = new Set<string>(["Auto"])
      const injected: InjectedAuto[] = []

      for (const draft of drafts) {
        const preferredApiIDs = resolvePreferredApiIDs(draft.preferredModels)
        const reasoningApiIDs = resolvePreferredApiIDs(draft.reasoning)
        const noReasoningApiIDs = resolvePreferredApiIDs(draft.noReasoning)
        let template = source.find((m) => !draft.familyFilter || familyLabel(m) === draft.familyFilter)
        const preferredTemplate = preferredApiIDs.map(modelByApiId).find((m): m is SourceModel => !!m)
        if (preferredTemplate) template = preferredTemplate
        if (!template) continue

        const baseName = draft.requestedName || (draft.legacy ? "Auto" : `Auto ${familyLabel(template) ?? draft.index}`)
        const baseID =
          draft.requestedID ||
          (draft.legacy ? MODEL_ID : `auto-${slugify(familyLabel(template) ?? String(draft.index))}`)
        const name = draft.legacy ? "Auto" : uniqueValue(baseName, usedNames, " ")
        const id = draft.legacy ? MODEL_ID : uniqueValue(baseID, usedIDs)

        injected.push({
          id,
          name,
          preferredModels: draft.preferredModels,
          reasoning: draft.reasoning,
          noReasoning: draft.noReasoning,
          preferredApiIDs,
          reasoningApiIDs,
          noReasoningApiIDs,
          template,
          catalogDefaultModelID: template.modelID,
          familyFilter: draft.familyFilter,
        })
      }
      return { injected, models: source }
    }

    await ctx.provider.transform((editor) => {
      const record = editor.get(PROVIDER_ID)
      if (!record) {
        log("provider transform: github-copilot provider not found")
        return
      }
      const source = Array.from(record.models.values()) as unknown as SourceModel[]
      catalog = source
      const built = buildAutos(source, options)
      autos = built.injected
      autoByID.clear()
      for (const auto of autos) autoByID.set(auto.id, auto)

      const added: SourceModel[] = autos.map((auto) => ({
        ...auto.template,
        id: auto.id,
        modelID: auto.id,
        name: auto.name,
        family: "github-copilot-auto",
        enabled: true,
      }))

      editor.models.set(PROVIDER_ID, [...source, ...added] as any)
      log(`injected ${autos.map((a) => `${a.id}->${a.catalogDefaultModelID}`).join(", ")}`)
    })

    // Capture the prompt text per session for the intent router.
    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text ?? ""
      for (const auto of autos) {
        const conv = getConv(event.sessionID, auto.id)
        conv.lastPrompt = text
      }
    })

    await ctx.session.hook(
      "http.request",
      async (event) => {
        const auto = autoByID.get(event.model.id)
        if (!auto) return
        const request = event.request
        let body: any
        try {
          body = JSON.parse(await request.clone().text())
        } catch (error) {
          log(`body parse failed: ${String(error)}`)
          return
        }
        if (!body || typeof body.model !== "string") return

        const header = request.headers.get("authorization") ?? ""
        const bearer = header.replace(/^Bearer\s+/i, "")
        if (!bearer) {
          log("no bearer on outgoing request; skipping auto routing")
          return
        }

        const baseURL = capiBase(auto.template.settings?.baseURL ?? "https://api.githubcopilot.com")
        const conv = getConv(event.sessionID, auto.id)
        const session = await ensureSession(event.sessionID, auto.id, baseURL, bearer)

        const pool = (session?.availableModels ?? []).filter((id) => isSameFamily(id, auto.template))
        let decided =
          auto.preferredApiIDs.find((id) => pool.includes(id)) ??
          pool[0] ??
          (isSameFamily(session?.selectedModelID, auto.template) ? session?.selectedModelID : undefined) ??
          auto.catalogDefaultModelID

        if (session?.availableModels.length) {
          if (conv.routedModelID !== undefined && !conv.needsReEval) {
            decided = conv.routedModelID
          } else {
            const decision = await getRouterDecision(
              baseURL,
              bearer,
              session.sessionToken,
              conv.lastPrompt ?? "",
              session.availableModels,
              {
                session_id: event.sessionID,
                turn_number: conv.turn + 1,
                previous_model: conv.previousModel,
                prompt_char_count: (conv.lastPrompt ?? "").length,
              },
            )
            const candidates = (decision?.candidate_models ?? []).filter((id) => isSameFamily(id, auto.template))
            const label = decision?.predicted_label
            const prefs =
              label === "needs_reasoning" ? auto.reasoningApiIDs
              : label === "no_reasoning" ? auto.noReasoningApiIDs
              : auto.preferredApiIDs
            const effective = prefs.length ? prefs : auto.preferredApiIDs
            const match = candidates.find((id) => effective.includes(id)) ?? candidates[0]
            if (match) decided = match
            conv.routedLabel = label
            conv.needsReEval = false
            log(`intent routed -> ${decided} (label=${label}, confidence=${decision?.confidence})`)
          }
        }

        const headers = new Headers(request.headers)
        if (session?.sessionToken) headers.set("Copilot-Session-Token", session.sessionToken)
        if (decided) body.model = decided
        if (conv.routedLabel === "needs_reasoning") {
          body.reasoning = { ...(body.reasoning ?? {}), effort: "high", summary: "auto" }
          body.include = Array.from(new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"]))
        }

        conv.routedModelID = decided
        conv.previousModel = decided
        conv.turn += 1
        log(`rewrite ${auto.id} -> ${decided} for ${event.sessionID}`)

        event.request = new Request(request.url, {
          method: request.method,
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        })
      },
      { providerID: PROVIDER_ID },
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.compaction.ended") continue
          const sessionID = (event as any).properties?.sessionID
          for (const [key, conv] of states) {
            if (key.startsWith(`${sessionID}\n`)) conv.needsReEval = true
          }
        }
      } catch {
        /* aborted */
      }
    })()
    return () => controller.abort()
  },
})
