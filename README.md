# cursor-opencode-provider

Use [Cursor](https://cursor.com) subscription models from [OpenCode](https://opencode.ai) by speaking Cursor's Connect-RPC agent protocol.

This project is a custom **AI SDK provider** (`LanguageModelV3`) plus an **OpenCode plugin** that handles authentication and model discovery. Instead of calling a generic chat-completions API, it encodes and decodes Cursor's protobuf agent protocol over HTTP/2 to `agentn.api5.cursor.sh`.

> **Status:** Under active development.

## Features

- **OpenCode integration** — registers a `cursor` provider with auth hooks and cached model list
- **Authentication** — browser OAuth (PKCE), or API key from [cursor.com/settings](https://cursor.com/settings)
- **Model discovery** — fetches available models from Cursor's API and caches them locally
- **Streaming** — bidirectional Connect-RPC stream for agent runs
- **Tool calls** — maps Cursor exec-server messages to AI SDK tool-call parts
- **Thinking / reasoning** — surfaces extended-thinking deltas where the model supports it

## Requirements

- [Bun](https://bun.sh) (for development and tests)
- [OpenCode](https://opencode.ai) with plugin support
- An active Cursor account with API access

## Installation

Clone and build:

```bash
git clone <repo-url> cursor-opencode-provider
cd cursor-opencode-provider
bun install
bun run build
```

## OpenCode setup

Add the plugin and provider to your OpenCode config. Use an absolute `file://` URL pointing at the built entry point:

```json
{
  "plugin": ["cursor-opencode-provider/plugin"],
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/cursor-opencode-provider/dist/index.js",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

The plugin auto-registers the provider on startup if it is not already configured.

For OpenCode builds that use the Effect/Promise **v2** plugin API (`plugins` field), also load:

```json
{
  "plugins": ["cursor-opencode-provider/plugin/v2"]
}
```

That entry registers the provider via `ctx.aisdk.sdk` / `ctx.aisdk.language`. Keep the classic `plugin` entry for auth. Model entries are populated from a local cache after you authenticate.

### Authenticate

Run OpenCode's auth flow for the `cursor` provider:

```bash
opencode auth login cursor
```

Choose one of:

| Method | Description |
|--------|-------------|
| **Browser login** | PKCE OAuth — opens cursor.com to sign in |
| **API key** | Paste a key from [cursor.com/settings](https://cursor.com/settings) (`sk-...`) |

After login, the plugin fetches your available models and writes them to `cursor-models.json` in your OpenCode config directory.

### Select a model

Pick a model from the cached list (for example `composer-2.5`, `default`, or a Claude/GPT variant exposed by your subscription):

```bash
opencode run --model cursor/composer-2.5 "Hello from Cursor via OpenCode"
```

## Programmatic usage

You can use the provider outside the plugin by importing `createCursor`:

```ts
import { createCursor } from "cursor-opencode-provider"

const cursor = createCursor({
  name: "cursor",
  accessToken: process.env.CURSOR_ACCESS_TOKEN,
})

const model = cursor.languageModel("composer-2.5")
// model implements AI SDK LanguageModelV3 (doStream / doGenerate)
```

Pass either `accessToken` (JWT from OAuth or key exchange) or `apiKey` (raw `sk-...` key).

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_CONFIG_DIR` | Override directory for `cursor-models.json` cache (defaults to OpenCode config dir) |
| `CURSOR_WEBSITE_URL` | Override OAuth login base URL (default `https://cursor.com`) |
| `CURSOR_API_BASE_URL` | Override API base for auth and model discovery (default `https://api2.cursor.sh`) |
| `CURSOR_PROVIDER_DEBUG` | Set to `1` or `true` to enable wire-level debug logging |
| `CURSOR_PROVIDER_DEBUG_FILE` | Debug log path (default `/tmp/cursor-provider-debug.log`) |

## Development

```bash
bun install          # install dependencies
bun run build        # compile TypeScript → dist/
bun run typecheck    # type-check without emit
bun test             # run unit tests
bun run test:watch   # watch mode
```

## Architecture

```
OpenCode
  └── CursorPlugin (auth, model cache, config hook)
        └── createCursor() → LanguageModelV3
              ├── protocol/   protobuf messages, framing, tools, thinking
              └── transport/  Connect-RPC over HTTP/2 to agentn.api5.cursor.sh
```

| Module | Role |
|--------|------|
| `src/plugin.ts` | OpenCode hooks: provider registration, OAuth, API key exchange, token refresh |
| `src/index.ts` | `createCursor` factory and default plugin export |
| `src/language-model.ts` | AI SDK `LanguageModelV3` adapter (`doStream`, `doGenerate`) |
| `src/auth.ts` | PKCE OAuth, API key exchange, JWT refresh |
| `src/models.ts` | `AvailableModels` fetch and `cursor-models.json` cache |
| `src/transport/connect.ts` | HTTP/2 bidi stream and unary RPC calls |
| `src/protocol/` | Protobuf encode/decode, checksum headers, tool-call mapping |

## Package exports

| Import path | Export |
|-------------|--------|
| `cursor-opencode-provider` | `createCursor`, `CursorPlugin` (default), `CursorPluginV2` |
| `cursor-opencode-provider/plugin` | `CursorPlugin` (classic Hooks — auth) |
| `cursor-opencode-provider/plugin/v2` | OpenCode Effect/Promise v2 plugin (`ctx.aisdk.*`) |

## License

MIT
