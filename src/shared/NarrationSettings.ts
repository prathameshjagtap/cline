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
