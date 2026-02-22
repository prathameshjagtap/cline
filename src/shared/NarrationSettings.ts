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
