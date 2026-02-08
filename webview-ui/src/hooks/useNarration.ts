import type { NarrationSettings } from "@shared/NarrationSettings"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useRef } from "react"
import { UiServiceClient } from "../services/grpc-client"
import { getNarrationPlayer } from "../services/NarrationPlayer"

/**
 * Hook that subscribes to narration events via gRPC streaming
 * and plays them via Web Speech API or audio element.
 */
export function useNarration(narrationSettings: NarrationSettings | undefined): void {
	const subscriptionRef = useRef<(() => void) | null>(null)

	useEffect(() => {
		const enabled = narrationSettings?.narrationEnabled ?? false
		const player = getNarrationPlayer()

		if (!enabled || !player.isSupported()) {
			player.cancel()
			if (subscriptionRef.current) {
				subscriptionRef.current()
				subscriptionRef.current = null
			}
			return
		}

		player.setRate(narrationSettings?.narrationRate ?? 1.1)

		// Clean up previous subscription
		if (subscriptionRef.current) {
			subscriptionRef.current()
		}

		const subscription = UiServiceClient.subscribeToNarration(EmptyRequest.create({}), {
			onResponse: (event) => {
				const hasAudio = event.audioBase64 && event.audioBase64.length > 0

				if (hasAudio) {
					// Cloud TTS: play audio data
					if (event.interrupt) {
						player.interruptWithAudio(event.audioBase64, event.audioFormat || "audio/aac")
					} else {
						player.playAudio(event.audioBase64, event.audioFormat || "audio/aac")
					}
				} else {
					// Browser TTS: use Web Speech API
					if (event.interrupt) {
						player.interrupt(event.text)
					} else {
						player.speak(event.text)
					}
				}
			},
			onError: (error) => {
				console.error("Narration subscription error:", error)
			},
			onComplete: () => {
				// Stream completed
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
