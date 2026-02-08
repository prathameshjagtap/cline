import { EmptyRequest } from "@shared/proto/cline/common"
import type { NarrationTextEvent } from "@shared/proto/cline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Active subscriptions for narration text events
const activeNarrationSubscriptions = new Set<StreamingResponseHandler<NarrationTextEvent>>()

/**
 * Subscribe to narration text events (gRPC streaming)
 */
export async function subscribeToNarration(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<NarrationTextEvent>,
	requestId?: string,
): Promise<void> {
	Logger.info("[Narration] Client subscribed to narration events")
	activeNarrationSubscriptions.add(responseStream)
	Logger.info(`[Narration] Active subscriptions: ${activeNarrationSubscriptions.size}`)

	const cleanup = () => {
		Logger.info("[Narration] Cleaning up subscription")
		activeNarrationSubscriptions.delete(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "narration_subscription" }, responseStream)
	}
}

/**
 * Send narration text to all active subscribers
 */
export async function sendNarrationEvent(text: string, interrupt = false): Promise<void> {
	Logger.info(`[Narration] Sending event to ${activeNarrationSubscriptions.size} subscribers: "${text}"`)
	const promises = Array.from(activeNarrationSubscriptions).map(async (responseStream) => {
		try {
			await responseStream({ text, interrupt }, false)
			Logger.info("[Narration] Event sent successfully")
		} catch (error) {
			Logger.error("Error sending narration event:", error)
			activeNarrationSubscriptions.delete(responseStream)
		}
	})
	await Promise.all(promises)
}
