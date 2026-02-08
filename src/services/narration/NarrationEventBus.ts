import type { NarrationSettings } from "@shared/NarrationSettings"
import { Logger } from "@/shared/services/Logger"
import { type NarrationEvent, synthesizeNarration } from "./NarrationSynthesizer"

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

		// Skip partial (streaming) updates — only narrate final messages
		if (event.partial) return

		const label = event.type === "say" ? `say(${event.say})` : `ask(${event.ask})`
		Logger.info(`[Narration] event: ${label} | text: ${event.text?.slice(0, 60) ?? ""}`)

		// High-priority events skip debounce
		if (isHighPriority(event)) {
			this.flushPending()
			const text = synthesizeNarration(event, this.settings.narrationVerbosity)
			Logger.info(`[Narration] synthesized (high-priority): ${text ?? "null (skipped)"}`)
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
			const label = event.type === "say" ? `say(${event.say})` : `ask(${event.ask})`
			Logger.info(`[Narration] synthesized ${label}: ${text ?? "null (skipped)"}`)
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
		Logger.info(`[Narration] broadcasting: "${text}"`)
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
	return false
}
