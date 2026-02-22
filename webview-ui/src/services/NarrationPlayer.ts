/**
 * Browser-based narration player.
 * Supports two modes:
 * 1. Web Speech API (speechSynthesis) — free, local, used for "browser" provider
 * 2. Audio playback — plays base64-encoded audio from cloud TTS (OpenAI)
 */
export class NarrationPlayer {
	private synth: SpeechSynthesis
	private currentAudio: HTMLAudioElement | null = null
	private rate = 1.1

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
