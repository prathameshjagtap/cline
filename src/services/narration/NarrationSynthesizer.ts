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
			// Skip: say("completion_result") already narrates this
			return null
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

/**
 * Check if a narration event is a reasoning event that could benefit from
 * LLM summarization. Called by NarrationEventBus to decide whether to
 * call ReasoningSummarizer.
 */
export function isReasoningEvent(event: NarrationEvent): boolean {
	return event.type === "say" && event.say === "reasoning" && !event.partial && !!event.text
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
