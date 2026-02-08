import type { NarrationSettings } from "@shared/NarrationSettings"
import { Logger } from "@/shared/services/Logger"
import { isReasoningEvent, type NarrationEvent, synthesizeNarration } from "./NarrationSynthesizer"
import { synthesizeSpeechOpenAi } from "./OpenAiTtsService"
import { summarizeReasoning } from "./ReasoningSummarizer"

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

		const label = event.type === "say" ? `say(${event.say})` : `ask(${event.ask})`

		// Skip partial (streaming) updates — only narrate final messages
		if (event.partial) {
			if (event.say === "reasoning") {
				Logger.info(`[Narration] SKIPPED partial reasoning event (${event.text?.length ?? 0} chars)`)
			}
			return
		}

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
		this.debounceTimer = setTimeout(() => {
			this.drain().catch((err) => Logger.error("[Narration] drain error:", err))
		}, this.DEBOUNCE_MS)
	}

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
				if (event.type === "say" && event.say === "reasoning") {
					Logger.info(
						`[Narration] Reasoning event check: isReasoningEvent=${isReasoningEvent(event)}, summarization=${this.settings.reasoningSummarization}, verbosity=${this.settings.narrationVerbosity}, hasApiKey=${!!this.openAiApiKey}`,
					)
				}
				if (
					isReasoningEvent(event) &&
					this.settings.reasoningSummarization &&
					this.settings.narrationVerbosity !== "minimal" &&
					this.openAiApiKey
				) {
					const rawText = event.text ?? ""
					Logger.info(`[Narration] Reasoning raw text (${rawText.length} chars): "${rawText.slice(0, 200)}"`)
					const summary = await summarizeReasoning(rawText, this.openAiApiKey)
					Logger.info(`[Narration] Reasoning summarized result: "${summary ?? "null (failed)"}"`)
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

	private flushPending(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
		this.drain().catch((err) => Logger.error("[Narration] drain error:", err))
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
