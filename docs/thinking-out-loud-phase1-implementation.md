# Thinking Out Loud: Phase 1 Implementation Plan

Step-by-step implementation guide for Phase 1 (Minimal Viable Narration using Browser Speech API). Follow each step in order. Do not skip steps. Do not add features beyond what is described.

**Pre-requisite**: Read `docs/thinking-out-loud-design.md` for context on the overall feature.

---

## Overview

Phase 1 delivers a working TTS narration system that:
- Intercepts `say()` and `ask()` events in the Task engine
- Converts them to natural spoken sentences via templates
- Streams narration text to the webview via a new gRPC streaming RPC
- Plays speech using the browser's built-in `speechSynthesis` API (Web Speech API)
- Provides a toggle in settings to enable/disable narration

**No external dependencies. No API keys. No cloud TTS.**

---

## Step 1: Create the NarrationSettings shared type

Create the file `src/shared/NarrationSettings.ts`:

```typescript
export interface NarrationSettings {
	/** Whether the narration feature is enabled by the user */
	narrationEnabled: boolean
	/** Speech rate (0.5 to 2.0, default 1.1) */
	narrationRate: number
	/** Verbosity level */
	narrationVerbosity: "minimal" | "normal" | "verbose"
}

export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
	narrationEnabled: false,
	narrationRate: 1.1,
	narrationVerbosity: "normal",
}
```

**Why**: This defines the settings shape used by both extension and webview. Follows the exact pattern of `src/shared/DictationSettings.ts`.

---

## Step 2: Register the setting in state-keys.ts

**File**: `src/shared/storage/state-keys.ts`

### 2a. Add import at top of file

Add this import alongside the existing settings imports (find the line `import { DEFAULT_DICTATION_SETTINGS, DictationSettings } from "@shared/DictationSettings"` and add below it):

```typescript
import { DEFAULT_NARRATION_SETTINGS, type NarrationSettings } from "@shared/NarrationSettings"
```

### 2b. Add to USER_SETTINGS_FIELDS

Find the `USER_SETTINGS_FIELDS` object (line ~235). Add the following entry inside the object, after the `dictationSettings` entry (line ~267):

```typescript
	narrationSettings: {
		default: DEFAULT_NARRATION_SETTINGS as NarrationSettings,
		transform: (v: any) => ({ ...DEFAULT_NARRATION_SETTINGS, ...v }),
	},
```

**Why**: The `transform` function merges stored values with defaults, so adding new fields later won't break existing users. This is the same pattern used by `dictationSettings` and `browserSettings`.

**Verification**: After this step, `Settings` type (auto-generated via `BuildInterface<>`) will include `narrationSettings: NarrationSettings`. No further type definition needed.

---

## Step 3: Add narrationSettings to ExtensionState

**File**: `src/shared/ExtensionMessage.ts`

Find the `ExtensionState` interface. Add this field after the `dictationSettings` field:

```typescript
	narrationSettings: NarrationSettings
```

Also add the import at the top of the file:

```typescript
import type { NarrationSettings } from "@shared/NarrationSettings"
```

**Why**: This makes the setting available in the webview via the state subscription mechanism.

---

## Step 4: Include narrationSettings in getStateToPostToWebview()

**File**: `src/core/controller/index.ts`

### 4a. Read the setting

Find the `getStateToPostToWebview()` method (line ~848). Find where `dictationSettings` is read from stateManager. Add below it:

```typescript
		const narrationSettings = this.stateManager.getGlobalSettingsKey("narrationSettings")
```

### 4b. Include in return object

Find the return object in the same method (line ~932). Find where `dictationSettings` is included. Add below it:

```typescript
			narrationSettings,
```

**Why**: This ensures the setting value flows to the webview on every state update.

---

## Step 5: Create the NarrationSynthesizer

This is the core logic that converts raw `say()`/`ask()` events into natural spoken sentences.

Create the file `src/services/narration/NarrationSynthesizer.ts`:

```typescript
import type { ClineAsk, ClineSay } from "@shared/ExtensionMessage"

export interface NarrationEvent {
	type: "say" | "ask"
	say?: ClineSay
	ask?: ClineAsk
	text?: string
	partial?: boolean
}

type NarrationVerbosity = "minimal" | "normal" | "verbose"

/**
 * Converts raw Cline say/ask events into natural spoken sentences.
 * Returns null when the event should not be narrated.
 */
export function synthesizeNarration(event: NarrationEvent, verbosity: NarrationVerbosity): string | null {
	if (event.type === "say" && event.say) {
		return synthesizeSay(event.say, event.text, event.partial, verbosity)
	}
	if (event.type === "ask" && event.ask) {
		return synthesizeAsk(event.ask, event.text, verbosity)
	}
	return null
}

function synthesizeSay(
	say: ClineSay,
	text: string | undefined,
	partial: boolean | undefined,
	verbosity: NarrationVerbosity,
): string | null {
	switch (say) {
		// --- Task lifecycle ---
		case "task":
			return text ? `Starting work on: ${truncate(text, 80)}` : "Starting a new task."

		case "completion_result":
			return "I've finished the task."

		case "error":
			return "An error occurred."

		case "error_retry":
			return "Got an error, retrying the request."

		// --- Reasoning / thinking ---
		case "reasoning": {
			// Skip partial reasoning updates - too noisy
			if (partial) return null
			// Minimal verbosity skips all reasoning
			if (verbosity === "minimal") return null
			// For normal/verbose, provide a short summary
			if (!text) return null
			if (verbosity === "verbose") {
				return `Thinking: ${truncate(text, 200)}`
			}
			// Normal: just acknowledge thinking happened
			return "Thinking about the approach."
		}

		// --- Tool actions ---
		case "tool": {
			return synthesizeToolSay(text)
		}

		// --- Commands ---
		case "command":
			return text ? `Running command: ${truncate(text, 60)}` : "Running a command."

		case "command_output": {
			if (verbosity === "minimal") return null
			if (!text) return null
			// Only narrate errors in command output
			const lowerText = text.toLowerCase()
			if (lowerText.includes("error") || lowerText.includes("failed") || lowerText.includes("exception")) {
				return "The command returned an error."
			}
			return null // Skip successful output (too verbose for speech)
		}

		// --- Text (assistant's conversational output) ---
		case "text": {
			if (partial) return null // Skip partial text updates
			if (!text) return null
			if (verbosity === "minimal") return null
			return truncate(text, 150)
		}

		// --- Browser ---
		case "browser_action_launch":
			return "Opening the browser."

		// --- MCP ---
		case "use_mcp_server":
			return "Using an MCP tool."

		// --- Events we always skip ---
		case "api_req_started":
		case "api_req_finished":
		case "api_req_retried":
		case "user_feedback":
		case "user_feedback_diff":
		case "shell_integration_warning":
		case "shell_integration_warning_with_suggestion":
		case "browser_action":
		case "browser_action_result":
		case "mcp_server_request_started":
		case "mcp_server_response":
		case "mcp_notification":
		case "diff_error":
		case "deleted_api_reqs":
		case "clineignore_error":
		case "command_permission_denied":
		case "checkpoint_created":
		case "load_mcp_documentation":
		case "generate_explanation":
		case "info":
		case "task_progress":
		case "hook_status":
		case "hook_output_stream":
		case "conditional_rules_applied":
			return null

		default:
			return null
	}
}

function synthesizeToolSay(text: string | undefined): string | null {
	if (!text) return null
	try {
		const info = JSON.parse(text)
		const tool = info.tool as string | undefined
		const path = info.path as string | undefined
		const shortPath = path ? basename(path) : undefined

		switch (tool) {
			case "readFile":
				return shortPath ? `Reading ${shortPath}` : "Reading a file."
			case "editedExistingFile":
				return shortPath ? `Editing ${shortPath}` : "Editing a file."
			case "newFileCreated":
				return shortPath ? `Creating ${shortPath}` : "Creating a new file."
			case "fileDeleted":
				return shortPath ? `Deleting ${shortPath}` : "Deleting a file."
			case "listFilesTopLevel":
			case "listFilesRecursive":
				return shortPath ? `Listing files in ${shortPath}` : "Listing files."
			case "listCodeDefinitionNames":
				return shortPath ? `Scanning code definitions in ${shortPath}` : "Scanning code definitions."
			case "searchFiles":
				return info.regex ? `Searching for ${truncate(info.regex, 40)}` : "Searching files."
			case "webFetch":
				return "Fetching a web page."
			case "webSearch":
				return "Searching the web."
			case "summarizeTask":
				return "Summarizing the task."
			default:
				return null
		}
	} catch {
		return null
	}
}

function synthesizeAsk(ask: ClineAsk, text: string | undefined, verbosity: NarrationVerbosity): string | null {
	switch (ask) {
		case "tool":
			return "Waiting for your approval."
		case "command":
			return text ? `Requesting to run: ${truncate(text, 60)}` : "Requesting to run a command."
		case "completion_result":
			return "I've finished the task."
		case "followup":
			return text ? truncate(text, 100) : "I have a question."
		case "browser_action_launch":
			return "Requesting to open the browser."
		case "use_mcp_server":
			return "Requesting to use an MCP tool."

		// Skip these
		case "plan_mode_respond":
		case "act_mode_respond":
		case "command_output":
		case "api_req_failed":
		case "resume_task":
		case "resume_completed_task":
		case "mistake_limit_reached":
		case "new_task":
		case "condense":
		case "summarize_task":
		case "report_bug":
			return null

		default:
			return null
	}
}

/** Extract the filename from a path */
function basename(filePath: string): string {
	const parts = filePath.split("/")
	return parts[parts.length - 1] || filePath
}

/** Truncate text to maxLen characters, adding "..." if truncated */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text
	return text.slice(0, maxLen - 3) + "..."
}
```

**Why**: Pure function, no side effects, easy to test. Handles every `ClineSay` and `ClineAsk` type to avoid missing cases. The design doc specifies template-based narration for Phase 1 (no LLM summarization).

---

## Step 6: Create the NarrationEventBus

This collects events from `say()`/`ask()`, debounces them, and sends narration text to subscribers.

Create the file `src/services/narration/NarrationEventBus.ts`:

```typescript
import type { NarrationSettings } from "@shared/NarrationSettings"
import { synthesizeNarration, type NarrationEvent } from "./NarrationSynthesizer"

export type NarrationTextCallback = (text: string) => void

/**
 * Collects say/ask events, synthesizes narration text, debounces,
 * and emits narration strings to subscribers.
 */
export class NarrationEventBus {
	private subscribers = new Set<NarrationTextCallback>()
	private pendingEvents: NarrationEvent[] = []
	private debounceTimer: ReturnType<typeof setTimeout> | null = null
	private readonly DEBOUNCE_MS = 200
	private settings: NarrationSettings

	constructor(settings: NarrationSettings) {
		this.settings = settings
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

		// High-priority events skip debounce
		if (isHighPriority(event)) {
			this.flushPending()
			const text = synthesizeNarration(event, this.settings.narrationVerbosity)
			if (text) this.broadcast(text)
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

		// Synthesize each event, collect non-null narration strings
		const narrations: string[] = []
		for (const event of events) {
			const text = synthesizeNarration(event, this.settings.narrationVerbosity)
			if (text) narrations.push(text)
		}

		if (narrations.length === 0) return

		// Batch into a single narration string
		const combined = narrations.join(". ")
		this.broadcast(combined)
	}

	private flushPending(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
		this.drain()
	}

	private broadcast(text: string): void {
		for (const callback of this.subscribers) {
			try {
				callback(text)
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
	if (event.type === "ask") {
		return event.ask === "completion_result"
	}
	return false
}
```

**Why**: Debouncing prevents audio overlap when Cline emits many events rapidly. High-priority events (errors, completion) skip the queue for immediate delivery.

---

## Step 7: Create the narration barrel export

Create the file `src/services/narration/index.ts`:

```typescript
export { NarrationEventBus, type NarrationTextCallback } from "./NarrationEventBus"
export { synthesizeNarration, type NarrationEvent } from "./NarrationSynthesizer"
```

---

## Step 8: Add a gRPC streaming RPC for narration events

The webview needs to receive narration text in real-time. We'll add a new streaming RPC to the existing `UiService`.

### 8a. Add proto definition

**File**: `proto/cline/ui.proto`

Find the `UiService` service definition. Add this RPC at the end of the service block:

```protobuf
  rpc subscribeToNarration(EmptyRequest) returns (stream NarrationTextEvent);
```

Find the end of the file (after the last message definition). Add this message:

```protobuf
message NarrationTextEvent {
  string text = 1;
  bool interrupt = 2;
}
```

Also make sure `EmptyRequest` is imported. It should already be imported via `import "cline/common.proto";` at the top of the file.

### 8b. Regenerate proto types

Run:

```bash
npm run protos
```

**Why**: This generates the TypeScript types and gRPC service stubs for the new RPC. The webview's gRPC client will automatically get the new `subscribeToNarration` method.

---

## Step 9: Create the narration gRPC controller handler

Create the file `src/core/controller/ui/subscribeToNarration.ts`:

```typescript
import { EmptyRequest } from "@shared/proto/cline/common"
import type { NarrationTextEvent } from "@shared/proto/cline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Active subscriptions for narration text events
const activeNarrationSubscriptions = new Set<StreamingResponseHandler<NarrationTextEvent>>()

/**
 * Subscribe to narration text events (gRPC streaming)
 */
export async function subscribeToNarration(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<NarrationTextEvent>,
	requestId?: string,
): Promise<void> {
	activeNarrationSubscriptions.add(responseStream)

	const cleanup = () => {
		activeNarrationSubscriptions.delete(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "narration_subscription" }, responseStream)
	}
}

/**
 * Send narration text to all active subscribers
 */
export async function sendNarrationEvent(text: string, interrupt: boolean = false): Promise<void> {
	const promises = Array.from(activeNarrationSubscriptions).map(async (responseStream) => {
		try {
			await responseStream({ text, interrupt }, false)
		} catch (error) {
			Logger.error("Error sending narration event:", error)
			activeNarrationSubscriptions.delete(responseStream)
		}
	})
	await Promise.all(promises)
}
```

**Why**: Follows the exact same pattern as `subscribeToPartialMessage.ts` (see `src/core/controller/ui/subscribeToPartialMessage.ts`). This is a streaming RPC that the webview subscribes to once, then receives narration text in real-time.

---

## Step 10: Register the new RPC handler in the controller

**File**: `src/core/controller/index.ts`

### 10a. Import the handler

Find the import block where other `ui/` handlers are imported (search for `subscribeToPartialMessage`). Add nearby:

```typescript
import { subscribeToNarration } from "./ui/subscribeToNarration"
```

### 10b. Register in the handler map

Find where `subscribeToPartialMessage` is registered in the gRPC handler map (search for `"subscribeToPartialMessage"` in the controller). Add the new handler in the same pattern:

```typescript
subscribeToNarration: (request, responseStream, requestId) =>
	subscribeToNarration(this, request, responseStream, requestId),
```

> **Note**: The exact registration pattern depends on how `subscribeToPartialMessage` is registered. Follow that exact pattern. It may be in a `registerHandlers()` method or a handler object. Search for `subscribeToPartialMessage` in the controller file to find the pattern.

---

## Step 11: Wire the NarrationEventBus into the Task class

**File**: `src/core/task/index.ts`

### 11a. Import

Add this import at the top of the file (with other service imports):

```typescript
import { NarrationEventBus } from "@services/narration"
import { sendNarrationEvent } from "@core/controller/ui/subscribeToNarration"
```

### 11b. Add property to Task class

Find the class property declarations (near line ~250, where `browserSession`, `contextManager`, etc. are declared). Add:

```typescript
	narrationBus: NarrationEventBus | undefined
```

### 11c. Initialize in constructor

Find the constructor body, after `this.stateManager = params.stateManager` (line ~313). Add:

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

### 11d. Hook into say() method

Find the `say()` method (line ~717). Add this as the FIRST line inside the method body, BEFORE the abort check:

```typescript
		// Emit to narration pipeline
		this.narrationBus?.emit({ type: "say", say: type, text, partial })
```

So the method starts like:

```typescript
	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
	): Promise<number | undefined> {
		// Emit to narration pipeline
		this.narrationBus?.emit({ type: "say", say: type, text, partial })

		// Allow hook messages even when aborted to enable proper cleanup
		if (this.taskState.abort && type !== "hook_status" && type !== "hook_output_stream") {
			throw new Error("Cline instance aborted")
		}
		// ... rest of method unchanged
```

### 11e. Hook into ask() method

Find the `ask()` method (line ~578). Add this as the FIRST line inside the method body, BEFORE the abort check:

```typescript
		// Emit to narration pipeline
		this.narrationBus?.emit({ type: "ask", ask: type, text, partial })
```

### 11f. Dispose on task cleanup

Find where the Task cleans up resources (search for `dispose` or `abort` or cleanup methods). Add:

```typescript
		this.narrationBus?.dispose()
```

If there's no explicit dispose, find where `this.taskState.abort = true` is set and add the dispose call nearby.

---

## Step 12: Add the narration setting to UpdateSettingsRequest proto

**File**: `proto/cline/state.proto`

### 12a. Add NarrationSettings message

Find the `DictationSettings` message in the file. Add after it:

```protobuf
message NarrationSettings {
  bool narration_enabled = 1;
  double narration_rate = 2;
  string narration_verbosity = 3;
}
```

### 12b. Add to UpdateSettingsRequest

Find the `UpdateSettingsRequest` message. Add a new field at the end (use the next available field number — look at the highest existing number and add 1):

```protobuf
  optional NarrationSettings narration_settings = 41;
```

> **Important**: Check the actual highest field number in `UpdateSettingsRequest`. At time of writing, the highest is `40` (worktrees_enabled). Use `41`. If the number has changed, use the next available.

### 12c. Regenerate protos

```bash
npm run protos
```

---

## Step 13: Handle narrationSettings in updateSettings handler

**File**: `src/core/controller/state/updateSettings.ts`

Find the block that handles `dictationSettings` (line ~203). Add after it:

```typescript
		if (request.narrationSettings !== undefined) {
			const narrationSettings = {
				narrationEnabled: request.narrationSettings.narrationEnabled ?? false,
				narrationRate: request.narrationSettings.narrationRate || 1.1,
				narrationVerbosity: (request.narrationSettings.narrationVerbosity as "minimal" | "normal" | "verbose") || "normal",
			}
			controller.stateManager.setGlobalState("narrationSettings", narrationSettings)
		}
```

**Why**: Converts the proto message to our TypeScript settings type and persists it via StateManager.

---

## Step 14: Create the webview NarrationPlayer service

Create the file `webview-ui/src/services/NarrationPlayer.ts`:

```typescript
/**
 * Browser-based narration player using the Web Speech API (speechSynthesis).
 * Zero dependencies, zero cost, works offline.
 */
export class NarrationPlayer {
	private synth: SpeechSynthesis
	private currentUtterance: SpeechSynthesisUtterance | null = null
	private rate: number = 1.1

	constructor() {
		this.synth = window.speechSynthesis
	}

	/** Update the speech rate */
	setRate(rate: number): void {
		this.rate = Math.max(0.5, Math.min(2.0, rate))
	}

	/** Speak the given text. Queues after any currently playing speech. */
	speak(text: string): void {
		if (!this.synth) return
		const utterance = new SpeechSynthesisUtterance(text)
		utterance.rate = this.rate
		utterance.pitch = 1.0
		this.currentUtterance = utterance
		this.synth.speak(utterance)
	}

	/** Cancel current speech and speak this text immediately */
	interrupt(text: string): void {
		this.cancel()
		this.speak(text)
	}

	/** Stop all speech */
	cancel(): void {
		if (!this.synth) return
		this.synth.cancel()
		this.currentUtterance = null
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

**Why**: Singleton ensures a single audio output. The Web Speech API is available in all VS Code webviews (Chromium-based). No setup needed.

---

## Step 15: Create the narration subscription hook in the webview

Create the file `webview-ui/src/hooks/useNarration.ts`:

```typescript
import { useEffect, useRef } from "react"
import type { NarrationSettings } from "@shared/NarrationSettings"
import { getNarrationPlayer } from "../services/NarrationPlayer"

/**
 * Hook that subscribes to narration events via gRPC streaming
 * and plays them via the Web Speech API.
 */
export function useNarration(narrationSettings: NarrationSettings | undefined): void {
	const subscriptionRef = useRef<{ cancel: () => void } | null>(null)

	useEffect(() => {
		const enabled = narrationSettings?.narrationEnabled ?? false
		const player = getNarrationPlayer()

		if (!enabled || !player.isSupported()) {
			// If narration was just disabled, cancel any playing speech
			player.cancel()
			// Clean up any existing subscription
			if (subscriptionRef.current) {
				subscriptionRef.current.cancel()
				subscriptionRef.current = null
			}
			return
		}

		// Update player settings
		player.setRate(narrationSettings?.narrationRate ?? 1.1)

		// Subscribe to narration events via gRPC streaming
		// Import dynamically to avoid issues if the generated client doesn't exist yet
		import("../services/grpc-client").then(({ UiServiceClient }) => {
			// Clean up previous subscription
			if (subscriptionRef.current) {
				subscriptionRef.current.cancel()
			}

			const { EmptyRequest } = require("@shared/proto/cline/common")

			const subscription = UiServiceClient.subscribeToNarration(EmptyRequest.create({}), {
				onResponse: (event: { text: string; interrupt: boolean }) => {
					if (event.interrupt) {
						player.interrupt(event.text)
					} else {
						player.speak(event.text)
					}
				},
				onError: (error: Error) => {
					console.error("Narration subscription error:", error)
				},
				onComplete: () => {
					// Stream completed
				},
			})

			subscriptionRef.current = subscription
		})

		return () => {
			player.cancel()
			if (subscriptionRef.current) {
				subscriptionRef.current.cancel()
				subscriptionRef.current = null
			}
		}
	}, [narrationSettings?.narrationEnabled, narrationSettings?.narrationRate])
}
```

> **Important**: After `npm run protos`, check how `UiServiceClient.subscribeToNarration` is actually generated. The subscription pattern might differ from the above. Look at how `subscribeToPartialMessage` is called in the webview codebase (search `webview-ui/src` for `subscribeToPartialMessage`) and match that pattern exactly. The above is a best-guess based on the streaming patterns observed — adapt to the actual generated API.

---

## Step 16: Wire the narration hook into the webview app

**File**: `webview-ui/src/context/ExtensionStateContext.tsx`

### 16a. Import the hook

Add this import at the top:

```typescript
import { useNarration } from "../hooks/useNarration"
```

### 16b. Import DEFAULT_NARRATION_SETTINGS

Add alongside the existing DEFAULT_DICTATION_SETTINGS import:

```typescript
import { DEFAULT_NARRATION_SETTINGS } from "@shared/NarrationSettings"
```

### 16c. Add default value

Find where `dictationSettings: DEFAULT_DICTATION_SETTINGS` is in the initial state object. Add below it:

```typescript
narrationSettings: DEFAULT_NARRATION_SETTINGS,
```

### 16d. Call the hook in the provider component

Find the `ExtensionStateContextProvider` component function. Inside it, after the state is set up but before the return statement, add:

```typescript
	// Narration: subscribe to narration events and play via Web Speech API
	useNarration(state.narrationSettings)
```

> Look at where other hooks are called in this component and place it there.

---

## Step 17: Add the narration toggle to the settings UI

**File**: `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx`

### 17a. Import NarrationSettings

Add import:

```typescript
import type { NarrationSettings } from "@shared/NarrationSettings"
```

### 17b. Add to experimentalFeatures array

Find the `experimentalFeatures` array (line ~107). Add a new entry:

```typescript
	{
		id: "thinking-out-loud",
		label: "Thinking Out Loud",
		description: "Narrate Cline's actions and thinking as spoken audio using your browser's built-in text-to-speech.",
		stateKey: "narrationEnabled",
		settingKey: "narrationSettings",
		nestedKey: "narrationEnabled",
		isExperimental: true,
	},
```

### 17c. Add state lookup

Find the `featureState` object (line ~247). Add:

```typescript
		narrationEnabled: (state as any).narrationSettings?.narrationEnabled,
```

Wait — that won't work because `featureState` uses `useExtensionState()` destructured values. Let's do it properly:

Find where state values are destructured from `useExtensionState()` (line ~188). Add `narrationSettings` to the destructured list:

```typescript
	const {
		// ... existing values ...
		narrationSettings,  // ADD THIS
	} = useExtensionState()
```

Then in the `featureState` object, add:

```typescript
		narrationEnabled: narrationSettings?.narrationEnabled,
```

### 17d. Update handleFeatureChange for narrationSettings

Find the `handleFeatureChange` callback (line ~267). It handles nested settings via `feature.nestedKey`. Currently it only handles `focusChainSettings`. Update it to also handle `narrationSettings`:

```typescript
	const handleFeatureChange = useCallback(
		(feature: FeatureToggle, checked: boolean) => {
			if (feature.nestedKey) {
				let currentValue = {}
				if (feature.settingKey === "focusChainSettings") {
					currentValue = focusChainSettings ?? {}
				} else if (feature.settingKey === "narrationSettings") {
					currentValue = narrationSettings ?? {}
				}
				updateSetting(feature.settingKey, { ...currentValue, [feature.nestedKey]: checked })
			} else {
				updateSetting(feature.settingKey, checked)
			}
		},
		[focusChainSettings, narrationSettings],
	)
```

---

## Step 18: Build and verify

### 18a. Regenerate protos (if not already done)

```bash
npm run protos
```

### 18b. Type check

```bash
npm run check-types
```

Fix any type errors. Common issues:
- Missing imports in generated proto files (run `npm run protos` again)
- `narrationSettings` not recognized in `UpdateSettingsRequest` (check the proto field was added correctly)
- Type mismatches in `NarrationSynthesizer.ts` (ensure all `ClineSay` and `ClineAsk` union members are handled)

### 18c. Lint and format

```bash
npm run format:fix
npm run lint
```

### 18d. Compile

```bash
npm run compile
```

### 18e. Run unit tests

```bash
npm run test:unit
```

If snapshot tests fail (system prompt snapshots), update them:

```bash
UPDATE_SNAPSHOTS=true npm run test:unit
```

---

## Step 19: Manual testing checklist

1. Open VS Code with the extension loaded (F5 to launch Extension Development Host)
2. Open Settings > Features > Experimental
3. Verify "Thinking Out Loud" toggle appears
4. Enable it
5. Start a task (e.g., "Read the file package.json and summarize it")
6. Verify you hear spoken narration:
   - "Starting work on: Read the file package.json..."
   - "Reading package.json"
   - The assistant's text response (summarized)
   - "I've finished the task."
7. Disable the toggle
8. Start another task
9. Verify NO narration plays
10. Re-enable, verify narration resumes

---

## File Summary

Files to **create** (5 new files):
| File | Purpose |
|------|---------|
| `src/shared/NarrationSettings.ts` | Settings type + defaults |
| `src/services/narration/NarrationSynthesizer.ts` | Event → spoken text conversion |
| `src/services/narration/NarrationEventBus.ts` | Debouncing + event collection |
| `src/services/narration/index.ts` | Barrel export |
| `src/core/controller/ui/subscribeToNarration.ts` | gRPC streaming handler |
| `webview-ui/src/services/NarrationPlayer.ts` | Web Speech API player |
| `webview-ui/src/hooks/useNarration.ts` | React hook for narration subscription |

Files to **modify** (8 files):
| File | Change |
|------|--------|
| `src/shared/storage/state-keys.ts` | Add `narrationSettings` to `USER_SETTINGS_FIELDS` |
| `src/shared/ExtensionMessage.ts` | Add `narrationSettings` to `ExtensionState` |
| `src/core/controller/index.ts` | Read + return narrationSettings in state; register RPC handler |
| `src/core/controller/state/updateSettings.ts` | Handle narrationSettings update |
| `src/core/task/index.ts` | Add NarrationEventBus, hook into `say()` and `ask()` |
| `proto/cline/ui.proto` | Add `subscribeToNarration` RPC + `NarrationTextEvent` message |
| `proto/cline/state.proto` | Add `NarrationSettings` message + field in `UpdateSettingsRequest` |
| `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx` | Add toggle UI |
| `webview-ui/src/context/ExtensionStateContext.tsx` | Wire up narration hook + default state |

Commands to run:
```bash
npm run protos          # After proto changes (Steps 8, 12)
npm run format:fix      # After all code changes
npm run lint            # Verify no lint errors
npm run check-types     # Verify type safety
npm run compile         # Build
npm run test:unit       # Run tests
```

---

## What is NOT in Phase 1

Do NOT implement any of these (they are Phase 2+):
- Cloud TTS (OpenAI, ElevenLabs, etc.)
- LLM-based thinking summarization
- Voice selection UI
- CLI support
- Narration control bar in chat view (play/pause/mute)
- Sound effects
- Subtitle display
- Volume control in UI (the browser handles volume)
- Speed control slider in UI (uses default 1.1x rate)
- Podcast/recording mode
