# Cline - AI Coding Agent VS Code Extension

## Quick Reference

- **Build:** `npm run compile` (type-check + lint + esbuild). NOT `npm run build`.
- **Package:** `npm run package` (production build including webview)
- **Unit tests:** `npm run test:unit`
- **Webview tests:** `npm run test:webview`
- **CLI tests:** `npm run cli:test`
- **Integration tests:** `npm run test:integration`
- **Lint/format:** `npx @biomejs/biome check` (uses Biome, not ESLint/Prettier)
- **Proto codegen:** `npm run protos` (run after any `.proto` file changes)
- **Regenerate snapshots:** `UPDATE_SNAPSHOTS=true npm run test:unit`
- **Changesets:** `npm run changeset` (patch only, never minor/major; skip for trivial changes)

## Architecture

Monorepo with three main surfaces sharing code via `src/shared/`:

- **Extension** (`src/`) - VS Code extension entry point, core logic, API providers, services
- **Webview** (`webview-ui/`) - React UI rendered in VS Code sidebar (built with Vite)
- **CLI** (`cli/`) - Terminal UI using React Ink

**Communication:** Extension and webview use a gRPC-like protocol over VS Code message passing. Proto definitions in `proto/cline/` generate types into `src/shared/proto/`, `src/generated/`.

**TypeScript path aliases:** `@` = `src/`, `@core` = `src/core/`, `@shared` = `src/shared/`, `@utils` = `src/utils/`, `@services` = `src/services/`, `@integrations` = `src/integrations/`, `@generated` = `src/generated/`

## Networking & Proxy

In extension code, NEVER use global `fetch` or default `axios`. Use proxy-aware wrappers:

```typescript
import { fetch } from "@/shared/net"
import { getAxiosSettings } from "@/shared/net"
```

Pass `fetch` to third-party API clients (OpenAI, etc.). Webview code CAN use global `fetch`. See `.clinerules/network.md` for full details.

## Key Patterns

### Adding a New API Provider

Must update proto conversion in THREE places or provider silently resets to Anthropic:

1. `proto/cline/models.proto` - Add to `ApiProvider` enum
2. `convertApiProviderToProto()` in `src/shared/proto-conversions/models/api-configuration-conversion.ts`
3. `convertProtoToApiProvider()` in the same file

Also update: `src/shared/api.ts`, `src/shared/providers/providers.json`, `src/core/api/index.ts`, `webview-ui/src/components/settings/utils/providerUtils.ts`, `webview-ui/src/utils/validate.ts`, `webview-ui/src/components/settings/ApiOptions.tsx`, and CLI (`cli/src/components/ModelPicker.tsx`).

### Responses API Providers (OpenAI Codex, OpenAI Native)

1. Add provider to `isNextGenModelProvider()` in `src/utils/model-utils.ts`
2. Set `apiFormat: ApiFormat.OPENAI_RESPONSES` on models in `src/shared/api.ts`

### Adding Tools to System Prompt

1. Add to `ClineDefaultTool` enum in `src/shared/tools.ts`
2. Tool definition in `src/core/prompts/system-prompt/tools/` (define variants per `ModelFamily`)
3. Register in `src/core/prompts/system-prompt/tools/init.ts`
4. Add to variant configs in `src/core/prompts/system-prompt/variants/*/config.ts`
5. Create handler in `src/core/task/tools/handlers/`
6. Wire up in `ToolExecutor.ts`, tool parsing in `src/core/assistant-message/index.ts`
7. If UI feedback needed: add `ClineSay` enum in proto, update `ExtensionMessage.ts`, proto-conversions, `ChatRow.tsx`

### Modifying System Prompt

Read `src/core/prompts/system-prompt/README.md` first. System is modular: components + variants + templates.

- Variant tiers: next-gen (Claude 4, GPT-5, Gemini 2.5), standard (`generic/`), small models (`xs/`, `hermes/`, `glm/`)
- Variants override components via `componentOverrides` in `config.ts` or custom templates
- After changes: `UPDATE_SNAPSHOTS=true npm run test:unit`

### Adding New Global State Keys

1. Type in `src/shared/storage/state-keys.ts`
2. Read in `src/core/storage/utils/state-helpers.ts` - add BOTH `context.globalState.get()` call AND return value
3. StateManager handles read/write after initialization

### Slash Commands

Three places: `src/core/slash-commands/index.ts`, `src/core/prompts/commands.ts`, `webview-ui/src/utils/slash-commands.ts`

### Feature Flags

See https://github.com/cline/cline/pull/7566 as reference.

### ChatRow Cancelled/Interrupted States

Check both `!isLast` AND `lastModifiedMessage?.ask === "resume_task" || "resume_completed_task"` to detect cancellation. See `generate_explanation` and `BrowserSessionRow.tsx` for examples.

## CLI Development

Lives in `cli/`, uses React Ink. Use `COLORS.primaryBlue` from `cli/src/constants/colors.ts`. Never use `dimColor` with gray. When updating webview, consider parity with CLI.
