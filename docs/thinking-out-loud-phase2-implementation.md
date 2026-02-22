# Thinking Out Loud: Phase 2 Implementation Plan

Step-by-step implementation guide for Phase 2 (Cloud TTS + Quality Improvements). Follow each step in order. Do not skip steps. Do not add features beyond what is described.

**Pre-requisites**:
- Read `docs/thinking-out-loud-design.md` for overall context.
- Phase 1 is already implemented. Read `docs/thinking-out-loud-phase1-implementation.md` to understand what exists.

---

## Overview

Phase 2 builds on Phase 1's working browser-speech narration by adding:

1. **OpenAI TTS integration** — Higher-quality cloud voices via OpenAI's `/v1/audio/speech` API
2. **LLM-based thinking summarization** — Summarize reasoning blocks into 1-2 spoken sentences instead of generic "Thinking about the approach"
3. **Smarter batching** — Group rapid file operations into one sentence (e.g., "Edited three files in src/components")
4. **Voice selection UI** — Let users pick a voice and TTS provider in settings
5. **CLI support** — Play narration in the terminal via platform-native TTS (`say` on macOS, `espeak` on Linux)

**What already exists from Phase 1** (do not recreate these):

| File | Purpose |
|------|---------|
| `src/shared/NarrationSettings.ts` | Settings type with `narrationEnabled`, `narrationRate`, `narrationVerbosity` |
| `src/services/narration/NarrationSynthesizer.ts` | Template-based event → spoken text |
| `src/services/narration/NarrationEventBus.ts` | Debounce + batching + event collection |
| `src/services/narration/index.ts` | Barrel export |
| `src/core/controller/ui/subscribeToNarration.ts` | gRPC streaming handler + `sendNarrationEvent()` |
| `webview-ui/src/services/NarrationPlayer.ts` | Web Speech API player (browser `speechSynthesis`) |
| `webview-ui/src/hooks/useNarration.ts` | React hook subscribing to gRPC narration stream |
| `proto/cline/ui.proto` | `NarrationTextEvent` message + `subscribeToNarration` RPC |
| `proto/cline/state.proto` | `NarrationSettings` proto message (field 41 in `UpdateSettingsRequest`) |

---

## Part A: Extend NarrationSettings for Phase 2

### Step 1: Extend the NarrationSettings type

**File**: `src/shared/NarrationSettings.ts`

Replace the entire file with:

```typescript
export type NarrationProvider = "browser" | "openai"
export type OpenAiTtsVoice = "alloy" | "ash" | "coral" | "echo" | "fable" | "nova" | "onyx" | "sage" | "shimmer"
export type OpenAiTtsModel = "tts-1" | "tts-1-hd"

export interface NarrationSettings {
	/** Whether the narration feature is enabled by the user */
	narrationEnabled: boolean
	/** Speech rate (0.5 to 2.0, default 1.1) */
	narrationRate: number
	/** Verbosity level */
	narrationVerbosity: "minimal" | "normal" | "verbose"
	/** TTS provider: browser (free, local) or openai (cloud, paid) */
	narrationProvider: NarrationProvider
	/** Voice to use with OpenAI TTS */
	openaiTtsVoice: OpenAiTtsVoice
	/** OpenAI TTS model quality */
	openaiTtsModel: OpenAiTtsModel
	/** Whether to use LLM to summarize reasoning blocks before narrating */
	reasoningSummarization: boolean
}

export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
	narrationEnabled: false,
	narrationRate: 1.1,
	narrationVerbosity: "normal",
	narrationProvider: "browser",
	openaiTtsVoice: "nova",
	openaiTtsModel: "tts-1",
	reasoningSummarization: false,
}

export const OPENAI_TTS_VOICES: { id: OpenAiTtsVoice; label: string }[] = [
	{ id: "alloy", label: "Alloy" },
	{ id: "ash", label: "Ash" },
	{ id: "coral", label: "Coral" },
	{ id: "echo", label: "Echo" },
	{ id: "fable", label: "Fable" },
	{ id: "nova", label: "Nova" },
	{ id: "onyx", label: "Onyx" },
	{ id: "sage", label: "Sage" },
	{ id: "shimmer", label: "Shimmer" },
]
```

**Why**: The `transform` in `state-keys.ts` already does `{ ...DEFAULT_NARRATION_SETTINGS, ...v }`, so adding new fields with defaults is backward-compatible. Existing users' stored settings will be merged with the new defaults.

---

### Step 2: Update the NarrationSettings proto message

**File**: `proto/cline/state.proto`

Find the existing `NarrationSettings` message (currently has 3 fields). Replace it with:

```protobuf
message NarrationSettings {
  bool narration_enabled = 1;
  double narration_rate = 2;
  string narration_verbosity = 3;
  string narration_provider = 4;
  string openai_tts_voice = 5;
  string openai_tts_model = 6;
  bool reasoning_summarization = 7;
}
```

Run `npm run protos` after this change.

---

### Step 3: Update the updateSettings handler for new fields

**File**: `src/core/controller/state/updateSettings.ts`

Find the block that handles `request.narrationSettings`. Replace the entire block with:

```typescript
		if (request.narrationSettings !== undefined) {
			const narrationSettings = {
				narrationEnabled: request.narrationSettings.narrationEnabled ?? false,
				narrationRate: request.narrationSettings.narrationRate || 1.1,
				narrationVerbosity: (request.narrationSettings.narrationVerbosity as "minimal" | "normal" | "verbose") || "normal",
				narrationProvider: (request.narrationSettings.narrationProvider as "browser" | "openai") || "browser",
				openaiTtsVoice: request.narrationSettings.openaiTtsVoice || "nova",
				openaiTtsModel: (request.narrationSettings.openaiTtsModel as "tts-1" | "tts-1-hd") || "tts-1",
				reasoningSummarization: request.narrationSettings.reasoningSummarization ?? false,
			}
			controller.stateManager.setGlobalState("narrationSettings", narrationSettings)
		}
```

---

## Part B: OpenAI TTS Cloud Integration

### Step 4: Add a secret key for TTS API key (optional, reuses existing)

Phase 2 does NOT add a separate TTS API key. Instead, it reuses the user's existing `openAiApiKey` secret (the one they already configured for the OpenAI provider). The user does not need to enter a separate key.

To read the key at runtime:

```typescript
const apiKey = this.stateManager.getSecretKey("openAiApiKey")
```

If the user hasn't configured an OpenAI API key but selects `openai` as narration provider, the system should fall back to the `browser` provider silently.

**No code changes needed for this step.** Just understand the pattern.

---

### Step 5: Create the OpenAI TTS service

Create the file `src/services/narration/OpenAiTtsService.ts`:

```typescript
import { createOpenAIClient } from "@shared/net"
import { Logger } from "@/shared/services/Logger"
import type { OpenAiTtsModel, OpenAiTtsVoice } from "@shared/NarrationSettings"

/**
 * Calls the OpenAI TTS API and returns audio data as a base64-encoded string.
 * The audio is in AAC format, which is widely supported for browser playback.
 */
export async function synthesizeSpeechOpenAi(options: {
	text: string
	apiKey: string
	voice: OpenAiTtsVoice
	model: OpenAiTtsModel
	speed: number
}): Promise<string | null> {
	const { text, apiKey, voice, model, speed } = options

	if (!text || !apiKey) return null

	try {
		const client = createOpenAIClient({ apiKey })
		const response = await client.audio.speech.create({
			model,
			voice,
			input: text,
			response_format: "aac",
			speed: Math.max(0.25, Math.min(4.0, speed)),
		})

		// Convert response to ArrayBuffer, then to base64
		const arrayBuffer = await response.arrayBuffer()
		const uint8Array = new Uint8Array(arrayBuffer)
		let binary = ""
		for (let i = 0; i < uint8Array.length; i++) {
			binary += String.fromCharCode(uint8Array[i])
		}
		const base64 = btoa(binary)
		return base64
	} catch (error) {
		Logger.error("[Narration] OpenAI TTS error:", error)
		return null
	}
}
```

**Why**: Uses `createOpenAIClient` from `@shared/net` which handles proxy configuration. Returns base64 audio so it can be sent to the webview via gRPC and played as an `<audio>` element or AudioContext.

---

### Step 6: Extend the gRPC NarrationTextEvent to carry audio data

**File**: `proto/cline/ui.proto`

Find the existing `NarrationTextEvent` message. Replace it with:

```protobuf
message NarrationTextEvent {
  string text = 1;
  bool interrupt = 2;
  string audio_base64 = 3;
  string audio_format = 4;
}
```

- `text` — The narration text (used for browser TTS fallback and subtitles)
- `interrupt` — Whether to cancel current speech
- `audio_base64` — Base64-encoded audio data from cloud TTS (empty string if using browser TTS)
- `audio_format` — Audio MIME type, e.g. `"audio/aac"` (empty string if using browser TTS)

Run `npm run protos` after this change.

---

### Step 7: Update sendNarrationEvent to support audio data

**File**: `src/core/controller/ui/subscribeToNarration.ts`

Replace the existing `sendNarrationEvent` function with:

```typescript
/**
 * Send narration text (and optional audio) to all active subscribers
 */
export async function sendNarrationEvent(
	text: string,
	interrupt: boolean = false,
	audioBase64: string = "",
	audioFormat: string = "",
): Promise<void> {
	const promises = Array.from(activeNarrationSubscriptions).map(async (responseStream) => {
		try {
			await responseStream({ text, interrupt, audioBase64, audioFormat }, false)
		} catch (error) {
			Logger.error("Error sending narration event:", error)
			activeNarrationSubscriptions.delete(responseStream)
		}
	})
	await Promise.all(promises)
}
```

Also add a callback registration function for CLI (add at the bottom of the file):

```typescript
// Callback-based subscriptions for CLI and non-gRPC consumers
export type NarrationCallback = (text: string, interrupt: boolean) => void
const callbackSubscriptions = new Set<NarrationCallback>()

/**
 * Register a callback to receive narration events (for CLI)
 */
export function registerNarrationCallback(callback: NarrationCallback): () => void {
	callbackSubscriptions.add(callback)
	return () => {
		callbackSubscriptions.delete(callback)
	}
}
```

Then update `sendNarrationEvent` to also call callbacks:

```typescript
export async function sendNarrationEvent(
	text: string,
	interrupt: boolean = false,
	audioBase64: string = "",
	audioFormat: string = "",
): Promise<void> {
	// Send to gRPC stream subscribers (webview)
	const promises = Array.from(activeNarrationSubscriptions).map(async (responseStream) => {
		try {
			await responseStream({ text, interrupt, audioBase64, audioFormat }, false)
		} catch (error) {
			Logger.error("Error sending narration event:", error)
			activeNarrationSubscriptions.delete(responseStream)
		}
	})

	// Send to callback subscribers (CLI)
	for (const callback of callbackSubscriptions) {
		try {
			callback(text, interrupt)
		} catch (error) {
			Logger.error("Error in narration callback:", error)
		}
	}

	await Promise.all(promises)
}
```

**Why**: Follows the exact pattern of `subscribeToPartialMessage.ts` which has both gRPC streaming subscriptions and `registerPartialMessageCallback()` for CLI consumers.

---

### Step 8: Update NarrationEventBus to support cloud TTS

**File**: `src/services/narration/NarrationEventBus.ts`

The NarrationEventBus currently calls `synthesizeNarration()` and broadcasts plain text. For cloud TTS, it also needs to call the OpenAI TTS API and send audio data.

Replace the entire file with:

```typescript
import { Logger } from "@/shared/services/Logger"
import type { NarrationSettings } from "@shared/NarrationSettings"
import { synthesizeNarration, type NarrationEvent } from "./NarrationSynthesizer"
import { synthesizeSpeechOpenAi } from "./OpenAiTtsService"

export type NarrationTextCallback = (text: string, audioBase64?: string, audioFormat?: string) => void

/**
 * Collects say/ask events, synthesizes narration text, debounces,
 * and emits narration strings to subscribers.
 * In Phase 2, also calls OpenAI TTS to generate audio when provider is "openai".
 */
export class NarrationEventBus {
	private subscribers = new Set<NarrationTextCallback>()
	private pendingEvents: NarrationEvent[] = []
	private debounceTimer: ReturnType<typeof setTimeout> | null = null
	private readonly DEBOUNCE_MS = 200
	private settings: NarrationSettings
	private openAiApiKey: string | undefined

	constructor(settings: NarrationSettings, openAiApiKey?: string) {
		this.settings = settings
		this.openAiApiKey = openAiApiKey
	}

	/** Update settings (called when user changes narration preferences) */
	updateSettings(settings: NarrationSettings): void {
		this.settings = settings
	}

	/** Register a callback to receive narration text */
	subscribe(callback: NarrationTextCallback): () => void {
		this.subscribers.add(callback)
		return () => {
			this.subscribers.delete(callback)
		}
	}

	/** Called from say() and ask() to emit an event */
	emit(event: NarrationEvent): void {
		if (!this.settings.narrationEnabled) return

		// Skip partial (streaming) updates — only narrate final messages
		if (event.partial) return

		const label = event.type === "say" ? `say(${event.say})` : `ask(${event.ask})`
		Logger.info(`[Narration] event: ${label} | text: ${event.text?.slice(0, 60) ?? ""}`)

		// High-priority events skip debounce
		if (isHighPriority(event)) {
			this.flushPending()
			const text = synthesizeNarration(event, this.settings.narrationVerbosity)
			Logger.info(`[Narration] synthesized (high-priority): ${text ?? "null (skipped)"}`)
			if (text) this.processAndBroadcast(text)
			return
		}

		this.pendingEvents.push(event)
		this.scheduleDrain()
	}

	/** Flush any pending events and clear timers */
	dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
		this.pendingEvents = []
		this.subscribers.clear()
	}

	private scheduleDrain(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = setTimeout(() => this.drain(), this.DEBOUNCE_MS)
	}

	private drain(): void {
		const events = this.pendingEvents.splice(0)
		if (events.length === 0) return

		// Smarter batching: group consecutive file tool events
		const narrations: string[] = []
		const fileOps: { tool: string; path: string }[] = []

		for (const event of events) {
			const fileOp = extractFileOp(event)
			if (fileOp) {
				fileOps.push(fileOp)
			} else {
				// Flush accumulated file ops before processing non-file event
				if (fileOps.length > 0) {
					narrations.push(batchFileOps(fileOps))
					fileOps.length = 0
				}
				const text = synthesizeNarration(event, this.settings.narrationVerbosity)
				const label = event.type === "say" ? `say(${event.say})` : `ask(${event.ask})`
				Logger.info(`[Narration] synthesized ${label}: ${text ?? "null (skipped)"}`)
				if (text) narrations.push(text)
			}
		}

		// Flush any remaining file ops
		if (fileOps.length > 0) {
			narrations.push(batchFileOps(fileOps))
		}

		if (narrations.length === 0) return

		const combined = narrations.join(". ")
		this.processAndBroadcast(combined)
	}

	private flushPending(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
		this.drain()
	}

	/**
	 * Process text through cloud TTS if configured, then broadcast.
	 * For browser provider, just broadcasts text (webview handles speech).
	 * For openai provider, calls the TTS API, gets audio, broadcasts both.
	 */
	private processAndBroadcast(text: string): void {
		if (this.settings.narrationProvider === "openai" && this.openAiApiKey) {
			// Fire-and-forget: call OpenAI TTS in background, broadcast when ready
			synthesizeSpeechOpenAi({
				text,
				apiKey: this.openAiApiKey,
				voice: this.settings.openaiTtsVoice,
				model: this.settings.openaiTtsModel,
				speed: this.settings.narrationRate,
			})
				.then((audioBase64) => {
					if (audioBase64) {
						this.broadcast(text, audioBase64, "audio/aac")
					} else {
						// Fallback to browser TTS if API fails
						this.broadcast(text)
					}
				})
				.catch(() => {
					this.broadcast(text)
				})
		} else {
			this.broadcast(text)
		}
	}

	private broadcast(text: string, audioBase64?: string, audioFormat?: string): void {
		Logger.info(`[Narration] broadcasting: "${text}" (audio: ${audioBase64 ? "yes" : "no"})`)
		for (const callback of this.subscribers) {
			try {
				callback(text, audioBase64, audioFormat)
			} catch {
				// Don't let subscriber errors break narration
			}
		}
	}
}

function isHighPriority(event: NarrationEvent): boolean {
	if (event.type === "say") {
		return event.say === "error" || event.say === "completion_result"
	}
	return false
}

/** Extract file operation info from a tool event, or null if not a file tool */
function extractFileOp(event: NarrationEvent): { tool: string; path: string } | null {
	if (event.type !== "say" || event.say !== "tool" || !event.text) return null
	try {
		const info = JSON.parse(event.text)
		const tool = info.tool as string | undefined
		const path = info.path as string | undefined
		if (!tool || !path) return null
		const fileTools = ["readFile", "editedExistingFile", "newFileCreated", "fileDeleted"]
		if (fileTools.includes(tool)) return { tool, path }
		return null
	} catch {
		return null
	}
}

/** Batch multiple file operations into a single narration sentence */
function batchFileOps(ops: { tool: string; path: string }[]): string {
	if (ops.length === 1) {
		return describeSingleFileOp(ops[0])
	}

	// Group by operation type
	const edits = ops.filter((o) => o.tool === "editedExistingFile")
	const reads = ops.filter((o) => o.tool === "readFile")
	const creates = ops.filter((o) => o.tool === "newFileCreated")
	const deletes = ops.filter((o) => o.tool === "fileDeleted")

	const parts: string[] = []

	if (edits.length > 0) {
		const names = edits.map((o) => basename(o.path)).join(", ")
		parts.push(edits.length === 1 ? `Editing ${names}` : `Editing ${edits.length} files: ${names}`)
	}
	if (reads.length > 0) {
		const names = reads.map((o) => basename(o.path)).join(", ")
		parts.push(reads.length === 1 ? `Reading ${names}` : `Reading ${reads.length} files: ${names}`)
	}
	if (creates.length > 0) {
		const names = creates.map((o) => basename(o.path)).join(", ")
		parts.push(creates.length === 1 ? `Creating ${names}` : `Creating ${creates.length} files: ${names}`)
	}
	if (deletes.length > 0) {
		const names = deletes.map((o) => basename(o.path)).join(", ")
		parts.push(deletes.length === 1 ? `Deleting ${names}` : `Deleting ${deletes.length} files: ${names}`)
	}

	return parts.join(". ")
}

function describeSingleFileOp(op: { tool: string; path: string }): string {
	const name = basename(op.path)
	switch (op.tool) {
		case "readFile":
			return `Reading ${name}`
		case "editedExistingFile":
			return `Editing ${name}`
		case "newFileCreated":
			return `Creating ${name}`
		case "fileDeleted":
			return `Deleting ${name}`
		default:
			return `Working on ${name}`
	}
}

function basename(filePath: string): string {
	const parts = filePath.split("/")
	return parts[parts.length - 1] || filePath
}
```

**Why**: This replaces the Phase 1 NarrationEventBus with an enhanced version that: (a) supports OpenAI TTS audio generation, (b) batches multiple file operations into one narration sentence ("Editing 3 files: foo.ts, bar.ts, baz.ts"), (c) adds a callback signature that can carry audio data.

---

### Step 9: Update the Task class NarrationEventBus initialization

**File**: `src/core/task/index.ts`

Find the narration initialization block in the constructor (currently around line ~322):

```typescript
		// Initialize narration
		const narrationSettings = this.stateManager.getGlobalSettingsKey("narrationSettings")
		if (narrationSettings?.narrationEnabled) {
			this.narrationBus = new NarrationEventBus(narrationSettings)
			this.narrationBus.subscribe((text) => {
				sendNarrationEvent(text).catch(() => {})
			})
		}
```

Replace with:

```typescript
		// Initialize narration
		const narrationSettings = this.stateManager.getGlobalSettingsKey("narrationSettings")
		if (narrationSettings?.narrationEnabled) {
			const openAiApiKey = narrationSettings.narrationProvider === "openai"
				? this.stateManager.getSecretKey("openAiApiKey")
				: undefined
			this.narrationBus = new NarrationEventBus(narrationSettings, openAiApiKey)
			this.narrationBus.subscribe((text, audioBase64, audioFormat) => {
				sendNarrationEvent(text, false, audioBase64 ?? "", audioFormat ?? "").catch(() => {})
			})
		}
```

**Why**: Passes the OpenAI API key to the event bus so it can call the TTS API. Uses the existing `openAiApiKey` secret — no new API key storage needed.

---

### Step 10: Update the barrel export

**File**: `src/services/narration/index.ts`

Replace with:

```typescript
export { NarrationEventBus, type NarrationTextCallback } from "./NarrationEventBus"
export { synthesizeNarration, type NarrationEvent } from "./NarrationSynthesizer"
export { synthesizeSpeechOpenAi } from "./OpenAiTtsService"
```

---

## Part C: LLM-Based Thinking Summarization

### Step 11: Create the reasoning summarizer

Create the file `src/services/narration/ReasoningSummarizer.ts`:

```typescript
import { createOpenAIClient } from "@shared/net"
import { Logger } from "@/shared/services/Logger"

const SUMMARIZE_PROMPT = `You are a narration assistant. Summarize the following AI reasoning into one or two short spoken sentences for a developer who is listening (not reading). Be concise, natural, and focus on the key plan or conclusion. Do not use code formatting, markdown, or technical jargon. Just speak naturally as if explaining to a colleague.

Reasoning:
`

/**
 * Summarizes a block of AI reasoning text into 1-2 spoken sentences
 * using a fast OpenAI model (gpt-4o-mini).
 * Returns null if summarization fails (caller should fall back to template).
 */
export async function summarizeReasoning(reasoningText: string, apiKey: string): Promise<string | null> {
	if (!reasoningText || !apiKey) return null

	// Don't summarize very short reasoning (< 100 chars) — just truncate
	if (reasoningText.length < 100) {
		return `Thinking: ${reasoningText.slice(0, 150)}`
	}

	try {
		const client = createOpenAIClient({ apiKey })
		const response = await client.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "user",
					content: SUMMARIZE_PROMPT + reasoningText.slice(0, 2000), // Limit input to save tokens
				},
			],
			max_tokens: 100,
			temperature: 0.3,
		})

		const summary = response.choices[0]?.message?.content?.trim()
		if (summary) {
			Logger.info(`[Narration] Reasoning summarized: "${summary}"`)
			return summary
		}
		return null
	} catch (error) {
		Logger.error("[Narration] Reasoning summarization error:", error)
		return null
	}
}
```

**Why**: Uses `gpt-4o-mini` which is fast (~200ms) and cheap. The 2000-char input limit prevents expensive calls on very long reasoning blocks. Returns null on failure so the caller can fall back to the Phase 1 template.

---

### Step 12: Integrate reasoning summarization into NarrationSynthesizer

**File**: `src/services/narration/NarrationSynthesizer.ts`

The existing synthesizer is synchronous. LLM summarization is async. Rather than making `synthesizeNarration` async (which would break the EventBus), we add a separate async function that the EventBus calls for reasoning events.

Add the following export to the bottom of the file (before the `basename` and `truncate` helper functions):

```typescript
/**
 * Check if a narration event is a reasoning event that could benefit from
 * LLM summarization. Called by NarrationEventBus to decide whether to
 * call ReasoningSummarizer.
 */
export function isReasoningEvent(event: NarrationEvent): boolean {
	return event.type === "say" && event.say === "reasoning" && !event.partial && !!event.text
}
```

---

### Step 13: Wire reasoning summarization into NarrationEventBus

**File**: `src/services/narration/NarrationEventBus.ts`

Add the import at the top:

```typescript
import { summarizeReasoning } from "./ReasoningSummarizer"
import { isReasoningEvent } from "./NarrationSynthesizer"
```

Find the `drain()` method. Inside the event loop (the `for (const event of events)` block), add reasoning summarization handling. Replace the drain method's event loop with:

```typescript
	private async drain(): Promise<void> {
		const events = this.pendingEvents.splice(0)
		if (events.length === 0) return

		// Smarter batching: group consecutive file tool events
		const narrations: string[] = []
		const fileOps: { tool: string; path: string }[] = []

		for (const event of events) {
			const fileOp = extractFileOp(event)
			if (fileOp) {
				fileOps.push(fileOp)
			} else {
				// Flush accumulated file ops before processing non-file event
				if (fileOps.length > 0) {
					narrations.push(batchFileOps(fileOps))
					fileOps.length = 0
				}

				// Reasoning summarization
				if (
					isReasoningEvent(event) &&
					this.settings.reasoningSummarization &&
					this.settings.narrationVerbosity !== "minimal" &&
					this.openAiApiKey
				) {
					const summary = await summarizeReasoning(event.text!, this.openAiApiKey)
					if (summary) {
						narrations.push(summary)
						continue
					}
				}

				// Default: template-based synthesis
				const text = synthesizeNarration(event, this.settings.narrationVerbosity)
				const label = event.type === "say" ? `say(${event.say})` : `ask(${event.ask})`
				Logger.info(`[Narration] synthesized ${label}: ${text ?? "null (skipped)"}`)
				if (text) narrations.push(text)
			}
		}

		// Flush any remaining file ops
		if (fileOps.length > 0) {
			narrations.push(batchFileOps(fileOps))
		}

		if (narrations.length === 0) return

		const combined = narrations.join(". ")
		this.processAndBroadcast(combined)
	}
```

Also update `scheduleDrain`:

```typescript
	private scheduleDrain(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = setTimeout(() => {
			this.drain().catch((err) => Logger.error("[Narration] drain error:", err))
		}, this.DEBOUNCE_MS)
	}
```

And update `flushPending`:

```typescript
	private flushPending(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
		this.drain().catch((err) => Logger.error("[Narration] drain error:", err))
	}
```

**Why**: Reasoning summarization is async because it calls the OpenAI API. If summarization fails or is disabled, it falls back to the template-based approach. The `reasoningSummarization` setting is checked so users can opt out.

---

## Part D: Voice Selection UI

### Step 14: Update the settings UI with voice/provider controls

**File**: `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx`

Find the "Thinking Out Loud" entry in the `experimentalFeatures` array. After the `FeatureRow` for "Thinking Out Loud" is rendered, add conditional settings that show when narration is enabled.

First, add the import at the top:

```typescript
import {
	OPENAI_TTS_VOICES,
	type NarrationProvider,
	type OpenAiTtsVoice,
	type OpenAiTtsModel,
} from "@shared/NarrationSettings"
```

Then find where experimental features are rendered (the `{experimentalFeatures.map(...)}`block). After the Thinking Out Loud feature row (it has `id: "thinking-out-loud"`), add a conditional settings panel. The cleanest way is to add it after the `.map()` block, right before the closing `</div>` of the experimental features container:

```tsx
							{/* Thinking Out Loud expanded settings */}
							{narrationSettings?.narrationEnabled && (
								<div className="px-3 pb-3 space-y-3 border-t border-editor-widget-border/30 pt-3">
									{/* TTS Provider */}
									<div className="space-y-1">
										<Label className="text-xs">TTS Provider</Label>
										<Select
											onValueChange={(v) =>
												updateSetting("narrationSettings", {
													...narrationSettings,
													narrationProvider: v,
												})
											}
											value={narrationSettings.narrationProvider || "browser"}>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="browser">Browser (Free, Local)</SelectItem>
												<SelectItem value="openai">OpenAI TTS (Cloud, Higher Quality)</SelectItem>
											</SelectContent>
										</Select>
										{narrationSettings.narrationProvider === "openai" && (
											<p className="text-xs text-description">
												Uses your OpenAI API key. Costs ~$15/1M characters.
											</p>
										)}
									</div>

									{/* OpenAI Voice (only when openai provider selected) */}
									{narrationSettings.narrationProvider === "openai" && (
										<div className="space-y-1">
											<Label className="text-xs">Voice</Label>
											<Select
												onValueChange={(v) =>
													updateSetting("narrationSettings", {
														...narrationSettings,
														openaiTtsVoice: v,
													})
												}
												value={narrationSettings.openaiTtsVoice || "nova"}>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{OPENAI_TTS_VOICES.map((voice) => (
														<SelectItem key={voice.id} value={voice.id}>
															{voice.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									)}

									{/* OpenAI Model Quality (only when openai provider selected) */}
									{narrationSettings.narrationProvider === "openai" && (
										<div className="space-y-1">
											<Label className="text-xs">Quality</Label>
											<Select
												onValueChange={(v) =>
													updateSetting("narrationSettings", {
														...narrationSettings,
														openaiTtsModel: v,
													})
												}
												value={narrationSettings.openaiTtsModel || "tts-1"}>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="tts-1">Standard (faster, ~$15/1M chars)</SelectItem>
													<SelectItem value="tts-1-hd">HD (slower, ~$30/1M chars)</SelectItem>
												</SelectContent>
											</Select>
										</div>
									)}

									{/* Verbosity */}
									<div className="space-y-1">
										<Label className="text-xs">Verbosity</Label>
										<Select
											onValueChange={(v) =>
												updateSetting("narrationSettings", {
													...narrationSettings,
													narrationVerbosity: v,
												})
											}
											value={narrationSettings.narrationVerbosity || "normal"}>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="minimal">Minimal (actions only)</SelectItem>
												<SelectItem value="normal">Normal (actions + thinking summary)</SelectItem>
												<SelectItem value="verbose">Verbose (everything)</SelectItem>
											</SelectContent>
										</Select>
									</div>

									{/* Reasoning Summarization toggle */}
									{narrationSettings.narrationProvider === "openai" && (
										<div className="flex items-center justify-between">
											<div>
												<Label className="text-xs">Summarize Thinking</Label>
												<p className="text-xs text-description">
													Use AI to summarize reasoning into natural speech
												</p>
											</div>
											<Switch
												checked={narrationSettings.reasoningSummarization ?? false}
												onCheckedChange={(checked) =>
													updateSetting("narrationSettings", {
														...narrationSettings,
														reasoningSummarization: checked,
													})
												}
												size="lg"
											/>
										</div>
									)}
								</div>
							)}
```

Make sure the `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` components are imported. They are already imported in this file (used for OpenAI Reasoning Effort dropdown). Also make sure `Label` and `Switch` are already imported (they are).

---

## Part E: Webview Cloud Audio Playback

### Step 15: Update the NarrationPlayer to support audio data playback

**File**: `webview-ui/src/services/NarrationPlayer.ts`

Replace the entire file with:

```typescript
/**
 * Browser-based narration player.
 * Supports two modes:
 * 1. Web Speech API (speechSynthesis) — free, local, used for "browser" provider
 * 2. Audio playback — plays base64-encoded audio from cloud TTS (OpenAI)
 */
export class NarrationPlayer {
	private synth: SpeechSynthesis
	private currentUtterance: SpeechSynthesisUtterance | null = null
	private currentAudio: HTMLAudioElement | null = null
	private rate: number = 1.1

	constructor() {
		this.synth = window.speechSynthesis
	}

	/** Update the speech rate (only affects Web Speech API) */
	setRate(rate: number): void {
		this.rate = Math.max(0.5, Math.min(2.0, rate))
	}

	/**
	 * Speak text using Web Speech API.
	 * Queues after any currently playing speech.
	 */
	speak(text: string): void {
		if (!this.synth) return
		const utterance = new SpeechSynthesisUtterance(text)
		utterance.rate = this.rate
		utterance.pitch = 1.0
		this.currentUtterance = utterance
		this.synth.speak(utterance)
	}

	/**
	 * Play base64-encoded audio data from cloud TTS.
	 * Stops any current speech/audio first.
	 */
	playAudio(base64Audio: string, mimeType: string): void {
		this.cancel()
		try {
			const dataUrl = `data:${mimeType};base64,${base64Audio}`
			const audio = new Audio(dataUrl)
			this.currentAudio = audio
			audio.onended = () => {
				this.currentAudio = null
			}
			audio.onerror = () => {
				this.currentAudio = null
			}
			audio.play().catch(() => {
				this.currentAudio = null
			})
		} catch {
			// Fallback: do nothing, let caller handle
		}
	}

	/** Cancel current speech and speak this text immediately */
	interrupt(text: string): void {
		this.cancel()
		this.speak(text)
	}

	/** Cancel current speech and play audio immediately */
	interruptWithAudio(base64Audio: string, mimeType: string): void {
		this.cancel()
		this.playAudio(base64Audio, mimeType)
	}

	/** Stop all speech and audio */
	cancel(): void {
		if (this.synth) {
			this.synth.cancel()
		}
		this.currentUtterance = null
		if (this.currentAudio) {
			this.currentAudio.pause()
			this.currentAudio.src = ""
			this.currentAudio = null
		}
	}

	/** Check if speech synthesis is supported in this environment */
	isSupported(): boolean {
		return typeof window !== "undefined" && "speechSynthesis" in window
	}
}

// Singleton instance
let narrationPlayerInstance: NarrationPlayer | null = null

export function getNarrationPlayer(): NarrationPlayer {
	if (!narrationPlayerInstance) {
		narrationPlayerInstance = new NarrationPlayer()
	}
	return narrationPlayerInstance
}
```

---

### Step 16: Update the useNarration hook to handle audio data

**File**: `webview-ui/src/hooks/useNarration.ts`

Replace the entire file with:

```typescript
import { useEffect, useRef } from "react"
import type { NarrationSettings } from "@shared/NarrationSettings"
import { EmptyRequest } from "@shared/proto/cline/common"
import { getNarrationPlayer } from "../services/NarrationPlayer"
import { UiServiceClient } from "../services/grpc-client"

/**
 * Hook that subscribes to narration events via gRPC streaming
 * and plays them via Web Speech API or audio element.
 */
export function useNarration(narrationSettings: NarrationSettings | undefined): void {
	const subscriptionRef = useRef<(() => void) | null>(null)

	useEffect(() => {
		const enabled = narrationSettings?.narrationEnabled ?? false
		const player = getNarrationPlayer()

		if (!enabled || !player.isSupported()) {
			player.cancel()
			if (subscriptionRef.current) {
				subscriptionRef.current()
				subscriptionRef.current = null
			}
			return
		}

		player.setRate(narrationSettings?.narrationRate ?? 1.1)

		// Clean up previous subscription
		if (subscriptionRef.current) {
			subscriptionRef.current()
		}

		const subscription = UiServiceClient.subscribeToNarration(EmptyRequest.create({}), {
			onResponse: (event) => {
				const hasAudio = event.audioBase64 && event.audioBase64.length > 0

				if (hasAudio) {
					// Cloud TTS: play audio data
					if (event.interrupt) {
						player.interruptWithAudio(event.audioBase64, event.audioFormat || "audio/aac")
					} else {
						player.playAudio(event.audioBase64, event.audioFormat || "audio/aac")
					}
				} else {
					// Browser TTS: use Web Speech API
					if (event.interrupt) {
						player.interrupt(event.text)
					} else {
						player.speak(event.text)
					}
				}
			},
			onError: (error) => {
				console.error("Narration subscription error:", error)
			},
			onComplete: () => {
				// Stream completed
			},
		})

		subscriptionRef.current = subscription

		return () => {
			player.cancel()
			if (subscriptionRef.current) {
				subscriptionRef.current()
				subscriptionRef.current = null
			}
		}
	}, [narrationSettings?.narrationEnabled, narrationSettings?.narrationRate])
}
```

---

## Part F: CLI Support

### Step 17: Create the CLI narration player

Create the file `cli/src/services/CliNarrationPlayer.ts`:

```typescript
import { spawn, execFileSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"

/**
 * CLI narration player using platform-native TTS.
 * macOS: `say` command
 * Linux: `espeak` command (or `espeak-ng`)
 * Windows: PowerShell SpeechSynthesizer
 */
export class CliNarrationPlayer {
	private currentProcess: ChildProcess | null = null
	private enabled: boolean = false

	/** Enable or disable narration */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		if (!enabled) this.cancel()
	}

	/** Speak the given text */
	speak(text: string): void {
		if (!this.enabled || !text) return
		// Cancel previous speech before starting new one
		this.cancel()
		this.currentProcess = spawnTts(text)
	}

	/** Stop current speech */
	cancel(): void {
		if (this.currentProcess) {
			this.currentProcess.kill()
			this.currentProcess = null
		}
	}

	/** Check if a TTS command is available on this platform */
	static isAvailable(): boolean {
		return getTtsCommand() !== null
	}
}

function spawnTts(text: string): ChildProcess | null {
	const cmd = getTtsCommand()
	if (!cmd) return null

	const args = getTtsArgs(text)
	if (!args) return null

	try {
		const proc = spawn(cmd, args, { stdio: "ignore" })
		proc.on("error", () => {
			// Silently ignore errors (e.g., command not found)
		})
		return proc
	} catch {
		return null
	}
}

function getTtsCommand(): string | null {
	switch (process.platform) {
		case "darwin":
			return "say"
		case "linux":
			// Try espeak-ng first, then espeak
			try {
				execFileSync("which", ["espeak-ng"], { stdio: "ignore" })
				return "espeak-ng"
			} catch {
				try {
					execFileSync("which", ["espeak"], { stdio: "ignore" })
					return "espeak"
				} catch {
					return null
				}
			}
		case "win32":
			return "powershell"
		default:
			return null
	}
}

function getTtsArgs(text: string): string[] | null {
	// Sanitize text: remove characters that could break shell commands
	const sanitized = text.replace(/['"\\`$]/g, "")

	switch (process.platform) {
		case "darwin":
			return [sanitized]
		case "linux":
			return [sanitized]
		case "win32":
			return [
				"-Command",
				`Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${sanitized}')`,
			]
		default:
			return null
	}
}

// Singleton
let cliNarrationPlayerInstance: CliNarrationPlayer | null = null

export function getCliNarrationPlayer(): CliNarrationPlayer {
	if (!cliNarrationPlayerInstance) {
		cliNarrationPlayerInstance = new CliNarrationPlayer()
	}
	return cliNarrationPlayerInstance
}
```

**Why**: Uses platform-native TTS commands which are free, fast, and require no API keys. On macOS, `say` is always available. On Linux, `espeak`/`espeak-ng` must be installed. Falls back gracefully if unavailable.

---

### Step 18: Wire CLI narration into TaskContext

**File**: `cli/src/context/TaskContext.tsx`

Add the import at the top:

```typescript
import { registerNarrationCallback } from "@core/controller/ui/subscribeToNarration"
import { getCliNarrationPlayer } from "../services/CliNarrationPlayer"
```

Inside the `useEffect` that sets up subscriptions (the one that calls `registerPartialMessageCallback`), add narration subscription right after the partial message subscription:

```typescript
		// Subscribe to narration events (for CLI TTS)
		const narrationPlayer = getCliNarrationPlayer()
		const narrationSettings = controller.stateManager?.getGlobalSettingsKey?.("narrationSettings")
		narrationPlayer.setEnabled(narrationSettings?.narrationEnabled ?? false)

		const unsubscribeNarration = registerNarrationCallback((text, interrupt) => {
			if (interrupt) {
				narrationPlayer.cancel()
			}
			narrationPlayer.speak(text)
		})
```

And in the cleanup return function, add:

```typescript
			unsubscribeNarration()
			narrationPlayer.cancel()
```

So the cleanup block looks like:

```typescript
		return () => {
			controller.postStateToWebview = originalPostState
			unsubscribePartial()
			unsubscribeNarration()
			narrationPlayer.cancel()
		}
```

---

## Part G: Build and Verify

### Step 19: Regenerate protos

```bash
npm run protos
```

### Step 20: Format and lint

```bash
npm run format:fix
npm run lint
```

### Step 21: Type check

```bash
npm run check-types
```

Fix any type errors. Common issues:
- `audioBase64` / `audioFormat` not recognized in `NarrationTextEvent` — run `npm run protos` again
- `NarrationTextCallback` signature changed — update all callers
- `drain()` is now async — make sure `scheduleDrain` handles the promise

### Step 22: Compile

```bash
npm run compile
```

### Step 23: Run unit tests

```bash
npm run test:unit
```

If snapshot tests fail:

```bash
UPDATE_SNAPSHOTS=true npm run test:unit
```

---

## Step 24: Manual testing checklist

### Browser TTS (existing Phase 1 functionality should still work)
1. Open VS Code extension development host
2. Settings > Features > Experimental > Enable "Thinking Out Loud"
3. Leave provider as "Browser"
4. Start a task — verify browser speech narration works

### OpenAI TTS
5. In settings, switch provider to "OpenAI TTS"
6. Verify voice selector appears (defaulting to "Nova")
7. Verify quality selector appears (defaulting to "Standard")
8. Make sure you have an OpenAI API key configured in Cline's API settings
9. Start a task — verify you hear high-quality cloud voice
10. If no API key is configured, verify it falls back to browser TTS silently

### Voice selection
11. Try different voices (Alloy, Echo, Shimmer, etc.)
12. Verify voice changes on the next narration event

### Reasoning summarization
13. Enable "Summarize Thinking" toggle
14. Start a task that involves reasoning
15. Verify the reasoning narration is a natural summary (not "Thinking about the approach")
16. Disable "Summarize Thinking" — verify it falls back to template

### Verbosity
17. Set verbosity to "Minimal" — verify only actions are narrated
18. Set verbosity to "Verbose" — verify reasoning content is included

### File operation batching
19. Start a task that reads/edits multiple files quickly
20. Verify narration batches them: "Editing 3 files: foo.ts, bar.ts, baz.ts"

### CLI
21. Run `cline` in terminal
22. Enable narration in settings
23. Start a task — verify you hear platform TTS narration (macOS `say`, Linux `espeak`)
24. If TTS command is not available, verify no errors are thrown

---

## File Summary

Files to **create** (3 new files):

| File | Purpose |
|------|---------|
| `src/services/narration/OpenAiTtsService.ts` | OpenAI TTS API caller |
| `src/services/narration/ReasoningSummarizer.ts` | LLM reasoning summarization |
| `cli/src/services/CliNarrationPlayer.ts` | Platform-native CLI TTS player |

Files to **modify** (10 files):

| File | Change |
|------|--------|
| `src/shared/NarrationSettings.ts` | Add `narrationProvider`, `openaiTtsVoice`, `openaiTtsModel`, `reasoningSummarization` |
| `proto/cline/state.proto` | Add fields 4-7 to `NarrationSettings` message |
| `proto/cline/ui.proto` | Add `audio_base64`, `audio_format` to `NarrationTextEvent` |
| `src/core/controller/state/updateSettings.ts` | Handle new narration settings fields |
| `src/services/narration/NarrationEventBus.ts` | Cloud TTS, smarter batching, async drain |
| `src/services/narration/NarrationSynthesizer.ts` | Add `isReasoningEvent()` export |
| `src/services/narration/index.ts` | Export new modules |
| `src/core/task/index.ts` | Pass API key to NarrationEventBus, update callback signature |
| `src/core/controller/ui/subscribeToNarration.ts` | Add audio params to `sendNarrationEvent`, add `registerNarrationCallback` |
| `webview-ui/src/services/NarrationPlayer.ts` | Add audio playback via `<audio>` element |
| `webview-ui/src/hooks/useNarration.ts` | Handle audio data in narration events |
| `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx` | Add provider/voice/quality/verbosity/summarization controls |
| `cli/src/context/TaskContext.tsx` | Wire CLI narration callback |

Commands to run:
```bash
npm run protos          # After proto changes (Steps 2, 6)
npm run format:fix      # After all code changes
npm run lint            # Verify no lint errors
npm run check-types     # Verify type safety
npm run compile         # Build
npm run test:unit       # Run tests
```

---

## What is NOT in Phase 2

Do NOT implement any of these (they are Phase 3):
- Contextual tone (adjusting voice for errors vs completion)
- Sound effects
- Multi-language narration
- Custom narration prompts
- Podcast/recording mode
- ElevenLabs or other non-OpenAI cloud providers
- Narration control bar in chat view (play/pause/mute buttons)
- Subtitle display in chat view
