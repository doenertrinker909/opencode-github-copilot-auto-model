# opencode-github-copilot-auto-model

Exposes GitHub Copilot's **Auto** model in OpenCode **V2**.

OpenCode V2.1.4 ships no Copilot models for accounts that GitHub limits to
automatic model selection (Copilot Free and Copilot for Students). The provider
still syncs its catalog, but every entry arrives with `enabled: false`, so the
picker stays empty.

This plugin adds `github-copilot/auto` (and one auto per model family when the
catalog has enough models for that family, for example `github-copilot/auto-gpt`).
Each auto behaves like VS Code's auto mode: it opens a Copilot auto session,
asks the intent router which tier the prompt needs, and rewrites the outgoing
request to the routed model while keeping the session token attached.

> This is a fork of [m0wer/opencode-github-copilot-auto-model](https://github.com/m0wer/opencode-github-copilot-auto-model)
> ported from the OpenCode V1 plugin API to V2.

## Requirements

- OpenCode `2.1.4` or newer (V2 plugin API: `Plugin.define`, `ctx.provider.transform`,
  `ctx.session.hook`)
- A signed-in GitHub Copilot connection in OpenCode
- An account whose Copilot plan only allows automatic model selection

## Install

Local checkout:

```jsonc
{
  "plugins": ["C:/path/to/opencode-github-copilot-auto-model"]
}
```

The repository root is a valid plugin directory: `index.ts` re-exports the
implementation in `src/index.ts`.

Package install (after publishing):

```jsonc
{
  "plugins": ["opencode-github-copilot-auto-model"]
}
```

Pick `Auto` in the model picker, or run:

```sh
opencode run -m github-copilot/auto "hello"
```

## Options

All options are optional and passed through the object form of the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-github-copilot-auto-model",
      "options": {
        "preferredModels": ["gpt-5.6-luna", "claude-sonnet-4.6"],
        "reasoning": ["gpt-5.6-luna"],
        "noReasoning": ["mai-code-1.1-flash"],
        "autos": []
      }
    }
  ]
}
```

| Option | Type | Description |
|--------|------|-------------|
| `preferredModels` | string[] | Preferred catalog models. The first match anchors the auto's endpoint family. |
| `reasoning` | string[] | Preferred models when the router predicts `needs_reasoning`. |
| `noReasoning` | string[] | Preferred models when the router predicts `no_reasoning`. |
| `autos` | object[] | Extra autos. Omit for one default auto per family with at least two catalog models; `[]` disables the defaults. Each entry accepts `id`, `name`, `preferredModels`, `reasoning`, `noReasoning`. |

## How it works (V2)

The V1 plugin relied on `provider.models`, `chat.message`, `chat.params` and
`chat.headers`. V2 replaces those hooks, and model IDs are read-only during a
request, so the port moves the model swap into the native HTTP layer:

| Concern | V1 | V2 |
|---------|----|----|
| Register autos in the catalog | `provider.models` | `ctx.provider.transform` + `editor.models.set` |
| Capture the prompt | `chat.message` | `ctx.session.hook("prompt")` |
| Route the turn | `chat.params` (`output.options.model`) | `ctx.session.hook("http.request")` rewriting the JSON body's `model` field |
| Attach the session token | `chat.headers` | same `http.request` hook, `Copilot-Session-Token` header |
| Invalidate after compaction | `event: session.compacted` | `ctx.event.subscribe`, `session.compaction.ended` |

Per request the plugin:

1. Reads the outgoing request body and the `Authorization` header OpenCode already set.
2. Opens a Copilot auto session with `POST /models/session` (pool plus session token), once per conversation.
3. Calls `POST /models/session/intent` on the first turn to get `needs_reasoning` / `no_reasoning` and a ranked candidate list.
4. Replaces `model` with the best candidate that shares the auto's transport (same provider package, base URL and endpoint), raises reasoning effort when the router asks for it, and adds `Copilot-Session-Token`.
5. Keeps the routed model sticky for the rest of the conversation, and re-routes after a compaction.

Routing stays inside one endpoint family because the request URL and provider
package cannot change per turn. Cross-family preferences are skipped.

## Limitations

- Only the auto-session path is implemented; direct model selection is rejected by GitHub for accounts limited to auto mode.
- Reasoning effort is raised for `needs_reasoning` and otherwise left at the model default.
- Compaction re-routing is best effort: the plugin only sees `session.compaction.ended`.

## Logging

```sh
tail -f "$LOCALAPPDATA/opencode-github-copilot-auto-model/plugin.log"   # Windows
tail -f ~/.local/state/opencode-github-copilot-auto-model/plugin.log    # Linux/macOS
```

Session tokens are never logged.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

`src/index.ts` is the V2 implementation and the package entrypoint
(`dist/index.js` after `bun run build`). The tests in `test/index.test.ts` cover
the pure helpers (family detection, endpoint grouping, auto drafts).

## License

MIT. Original work by m0wer.
