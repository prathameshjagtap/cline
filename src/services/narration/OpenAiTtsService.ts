import type { OpenAiTtsModel, OpenAiTtsVoice } from "@shared/NarrationSettings"
import { createOpenAIClient } from "@shared/net"
import { Logger } from "@/shared/services/Logger"

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
