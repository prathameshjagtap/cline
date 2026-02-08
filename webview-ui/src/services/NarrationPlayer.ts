/**
 * Browser-based narration player using the Web Speech API (speechSynthesis).
 * Zero dependencies, zero cost, works offline.
 */
export class NarrationPlayer {
	private synth: SpeechSynthesis
	private currentUtterance: SpeechSynthesisUtterance | null = null
	private rate = 1.1

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
