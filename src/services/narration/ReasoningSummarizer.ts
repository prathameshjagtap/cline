import { createOpenAIClient } from "@shared/net"
import { Logger } from "@/shared/services/Logger"

const SUMMARIZE_PROMPT = `You are a narration assistant. Summarize the following AI reasoning into one or two short spoken sentences for a developer who is listening (not reading). Be concise, natural, and focus on the key plan or conclusion. Do not use code formatting, markdown, or technical jargon. Just speak naturally as if explaining to a colleague.

Reasoning:
`

/**
 * Summarizes a block of AI reasoning text into 1-2 spoken sentences
 * using a fast OpenAI model (gpt-4o-mini).
 * Returns null if summarization fails (caller should fall back to template).
 */
export async function summarizeReasoning(reasoningText: string, apiKey: string): Promise<string | null> {
	if (!reasoningText || !apiKey) return null

	// Don't summarize very short reasoning (< 100 chars) — just truncate
	if (reasoningText.length < 100) {
		return `Thinking: ${reasoningText.slice(0, 150)}`
	}

	try {
		const client = createOpenAIClient({ apiKey })
		const response = await client.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "user",
					content: SUMMARIZE_PROMPT + reasoningText.slice(0, 2000), // Limit input to save tokens
				},
			],
			max_tokens: 100,
			temperature: 0.3,
		})

		const summary = response.choices[0]?.message?.content?.trim()
		if (summary) {
			Logger.info(`[Narration] Reasoning summarized: "${summary}"`)
			return summary
		}
		return null
	} catch (error) {
		Logger.error("[Narration] Reasoning summarization error:", error)
		return null
	}
}
