import type { ChildProcess } from "node:child_process"
import { execFileSync, spawn } from "node:child_process"

/**
 * CLI narration player using platform-native TTS.
 * macOS: `say` command
 * Linux: `espeak` command (or `espeak-ng`)
 * Windows: PowerShell SpeechSynthesizer
 */
export class CliNarrationPlayer {
	private currentProcess: ChildProcess | null = null
	private enabled = false

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
