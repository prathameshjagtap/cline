import type { NarrationSettings } from "@shared/NarrationSettings"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useRef } from "react"
import { UiServiceClient } from "../services/grpc-client"
import { getNarrationPlayer } from "../services/NarrationPlayer"

/**
 * Hook that subscribes to narration events via gRPC streaming
 * and plays them via the Web Speech API.
 */
export function useNarration(narrationSettings: NarrationSettings | undefined): void {
	const subscriptionRef = useRef<(() => void) | null>(null)

	useEffect(() => {
		const enabled = narrationSettings?.narrationEnabled ?? false
		const player = getNarrationPlayer()

		if (!enabled || !player.isSupported()) {
			// If narration was just disabled, cancel any playing speech
			player.cancel()
			// Clean up any existing subscription
			if (subscriptionRef.current) {
				subscriptionRef.current()
				subscriptionRef.current = null
			}
			return
		}

		// Update player settings
		player.setRate(narrationSettings?.narrationRate ?? 1.1)

		// Clean up previous subscription
		if (subscriptionRef.current) {
			subscriptionRef.current()
		}

		// Subscribe to narration events via gRPC streaming
		console.log("[DEBUG] Starting narration subscription")
		const subscription = UiServiceClient.subscribeToNarration(EmptyRequest.create({}), {
			onResponse: (event) => {
				console.log("[DEBUG] Received narration event:", event.text)
				if (event.interrupt) {
					player.interrupt(event.text)
				} else {
					player.speak(event.text)
				}
			},
			onError: (error) => {
				console.error("Narration subscription error:", error)
			},
			onComplete: () => {
				console.log("[DEBUG] Narration subscription completed")
			},
		})

		subscriptionRef.current = subscription

		return () => {
			player.cancel()
			if (subscriptionRef.current) {
				subscriptionRef.current()
				subscriptionRef.current = null
			}
		}
	}, [narrationSettings?.narrationEnabled, narrationSettings?.narrationRate])
}
