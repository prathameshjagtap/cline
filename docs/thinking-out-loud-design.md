# Thinking Out Loud: Real-Time Voice Narration for Cline

Design document for synthesizing Cline's thinking and actions into a streamed human voice narration for the developer.

---

## Table of Contents

1. [Concept](#1-concept)
2. [What Gets Narrated](#2-what-gets-narrated)
3. [Architecture Overview](#3-architecture-overview)
4. [Interception Points in Cline](#4-interception-points-in-cline)
5. [Narration Synthesis Pipeline](#5-narration-synthesis-pipeline)
6. [TTS Streaming Integration](#6-tts-streaming-integration)
7. [Webview / UI Integration](#7-webview--ui-integration)
8. [Implementation Plan](#8-implementation-plan)
9. [Key Design Decisions](#9-key-design-decisions)

---

## 1. Concept

When Cline works on a task, it silently thinks (reasoning/chain-of-thought) and acts (editing files, running commands, searching). The developer has to read through the chat to follow along. **Thinking Out Loud** narrates this process as streaming human speech so the developer can listen while doing other things.

The flow:

```
Cline thinks + acts
       |
       v
Intercept thinking & action events
       |
       v
Synthesize into natural narration text
       |
       v
Stream through TTS engine
       |
       v
Play as audio in VS Code / CLI
```

---

## 2. What Gets Narrated

### 2.1 Thinking Events

These are the AI's reasoning/chain-of-thought streamed from the model.

| Event | Source | Example Narration |
|-------|--------|-------------------|
| Reasoning starts | `say("reasoning", ...)` partial=true | "Let me think about this..." |
| Reasoning chunk | `say("reasoning", ...)` partial=true | (summarized thinking content) |
| Reasoning complete | `say("reasoning", ...)` partial=false | "Okay, I have a plan." |

**Source in code**: `src/core/task/index.ts:2615-2635` - The `case "reasoning"` block in the streaming loop.

### 2.2 Action Events

These are tool calls - the actual things Cline does.

| Event | Source | Example Narration |
|-------|--------|-------------------|
| Reading a file | `say("tool", { tool: "readFile", path })` | "Reading the file src/main.ts..." |
| Editing a file | `say("tool", { tool: "editedExistingFile", path })` | "Editing src/utils.ts..." |
| Creating a file | `say("tool", { tool: "newFileCreated", path })` | "Creating a new file tests/app.test.ts..." |
| Running a command | `say("command", ...)` or `ask("command", ...)` | "Running npm test..." |
| Command output | `say("command_output", ...)` | "Tests passed." / "Got an error..." |
| Searching files | `say("tool", { tool: "searchFiles" })` | "Searching for references to handleClick..." |
| Browser action | `say("browser_action_launch", ...)` | "Opening the browser..." |
| MCP tool use | `ask("use_mcp_server", ...)` | "Using the database tool..." |
| Completion | `ask("completion_result", ...)` | "I've finished the task." |
| Text output | `say("text", ...)` | (summarized assistant text) |

**Source in code**: `src/core/task/index.ts:717-822` - The `say()` method where all messages are created.

### 2.3 Lifecycle Events

| Event | Source | Example Narration |
|-------|--------|-------------------|
| Task starts | `say("task", ...)` | "Starting work on: <task summary>" |
| API request | `say("api_req_started", ...)` | (silence or subtle sound) |
| Error + retry | `say("error_retry", ...)` | "Got an error, retrying..." |
| Waiting for approval | `ask("tool", ...)` | "Waiting for your approval..." |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Cline Task Engine                      │
│                  src/core/task/index.ts                   │
│                                                          │
│  say("reasoning", text)  say("tool", json)  say("text") │
│         │                      │                  │      │
└─────────┼──────────────────────┼──────────────────┼──────┘
          │                      │                  │
          ▼                      ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│              NarrationEventBus (new)                      │
│         src/services/narration/EventBus.ts                │
│                                                          │
│  Collects events, debounces, batches into narration      │
│  chunks. Maintains a queue of "what to say next."        │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│            NarrationSynthesizer (new)                     │
│       src/services/narration/Synthesizer.ts               │
│                                                          │
│  Converts raw events into natural English sentences.     │
│  Deduplicates, summarizes long thinking, prioritizes     │
│  action descriptions over verbose reasoning.             │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│              TTSStreamService (new)                       │
│         src/services/narration/TTSStream.ts               │
│                                                          │
│  Sends narration text to TTS API (streaming).            │
│  Receives audio chunks. Manages playback queue.          │
│  Handles interruption when new high-priority events      │
│  arrive (e.g., error overrides current narration).       │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│              AudioPlaybackService (new)                   │
│       src/services/narration/AudioPlayback.ts             │
│                                                          │
│  VS Code: play in webview via Web Audio API              │
│  CLI: pipe to system audio (e.g., ffplay, mpv, aplay)   │
│  Supports: pause, resume, volume, mute                   │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Interception Points in Cline

### 4.1 Primary Interception: The `say()` Method

**File**: `src/core/task/index.ts:717`

Every piece of visible output flows through `say()`. This is the single best place to tap into the narration pipeline.

```typescript
async say(
    type: ClineSay,   // "reasoning" | "text" | "tool" | "command" | ...
    text?: string,     // The content
    images?: string[],
    files?: string[],
    partial?: boolean, // true = still streaming, false = complete
): Promise<number | undefined>
```

**Integration approach**: Add a narration hook at the top of `say()`:

```typescript
async say(type: ClineSay, text?: string, ...) {
    // Emit to narration pipeline
    this.narrationBus?.emit({ type, text, partial })

    // ... existing say() logic unchanged ...
}
```

The narration bus receives every event and decides what to narrate.

### 4.2 Secondary Interception: The `ask()` Method

**File**: `src/core/task/index.ts:578`

For events that require user approval (tool approval, command approval), these go through `ask()`. Tapping here lets us narrate "Waiting for your approval to edit this file."

### 4.3 Reasoning Interception: The Streaming Loop

**File**: `src/core/task/index.ts:2615`

For more granular control over reasoning content (before it hits `say()`), intercept inside the `case "reasoning"` branch:

```typescript
case "reasoning": {
    reasonsHandler.processReasoningDelta({ ... })

    // Emit raw reasoning delta to narration (more granular than say())
    this.narrationBus?.emitReasoning(chunk.reasoning)

    if (!this.taskState.abort) {
        const thinkingBlock = reasonsHandler.getCurrentReasoning()
        if (thinkingBlock?.thinking && chunk.reasoning) {
            await this.say("reasoning", thinkingBlock.thinking, ...)
        }
    }
    break
}
```

### 4.4 Action Interception: ToolExecutor

**File**: `src/core/task/ToolExecutor.ts`

For richer action context (tool name, parameters, result), intercept at the tool executor level:

- **Before execution** (line ~601): Know what tool is about to run
- **After execution** (line ~603): Know the result (success/failure)

This gives narration access to structured data like `{ tool: "read_file", params: { path: "src/main.ts" } }` rather than just the serialized JSON string.

### 4.5 Hook-Based Interception (Zero Core Changes)

For a non-invasive prototype, use the existing **hooks system**:

- **PreToolUse hook** (`src/core/hooks/hook-factory.ts:101`): Receives tool name + params before execution
- **PostToolUse hook** (`src/core/hooks/hook-factory.ts:104`): Receives tool name + params + result after execution
- **TaskStart/TaskComplete hooks**: Narrate task lifecycle

Hook scripts would forward events to a narration service running as a sidecar process or local server.

---

## 5. Narration Synthesis Pipeline

Raw events are too verbose for speech. The synthesizer converts them into concise, natural narration.

### 5.1 Event Types and Narration Templates

```typescript
// src/services/narration/Synthesizer.ts

interface NarrationEvent {
    type: ClineSay | ClineAsk
    text?: string
    partial?: boolean
    timestamp: number
}

const NARRATION_TEMPLATES: Record<string, (event: NarrationEvent) => string | null> = {
    // Thinking - summarize, don't read verbatim
    "reasoning": (e) => {
        if (e.partial) return null // Skip partials, wait for complete
        return summarizeThinking(e.text, 2) // 2-sentence max summary
    },

    // File operations
    "tool": (e) => {
        const info = JSON.parse(e.text || "{}")
        switch (info.tool) {
            case "readFile":       return `Reading ${basename(info.path)}`
            case "editedExistingFile": return `Editing ${basename(info.path)}`
            case "newFileCreated": return `Creating ${basename(info.path)}`
            case "searchFiles":    return `Searching for ${info.regex || "files"}`
            case "listFilesTopLevel": return `Listing files in ${info.path || "workspace"}`
            default: return null
        }
    },

    // Commands
    "command": (e) => `Running: ${truncate(e.text, 60)}`,

    // Command output - only narrate errors or key results
    "command_output": (e) => {
        if (containsError(e.text)) return "The command returned an error."
        return null // Skip successful output (too verbose)
    },

    // Text - assistant's conversational output
    "text": (e) => {
        if (e.partial) return null
        return summarizeText(e.text, 3) // 3-sentence max
    },

    // Task lifecycle
    "task": (e) => `Starting: ${truncate(e.text, 80)}`,
    "error_retry": () => "Got an error, retrying the request.",
    "completion_result": () => "I've finished the task.",
}
```

### 5.2 Thinking Summarization Strategy

Raw reasoning can be hundreds of words. The synthesizer should:

1. **Skip partial updates** - Only narrate when reasoning is complete (`partial=false`)
2. **Summarize to 1-2 sentences** - Extract the key conclusion or plan
3. **Use an LLM summary call** (optional) - For high-quality summaries, send the thinking text to a fast small model with a prompt like: *"Summarize this AI reasoning into one spoken sentence for a developer listening."*
4. **Template-based fallback** - If no LLM available, extract the last sentence or use a generic "Thinking about the approach."

### 5.3 Debouncing and Batching

Actions often come in rapid succession (read file -> edit file -> read another file). The synthesizer should:

- **Debounce** rapid events (100-300ms window)
- **Batch** related events: "Reading and editing three files in src/components"
- **Skip** redundant narration (don't narrate partial + complete for same event)
- **Interrupt** current narration for high-priority events (errors, user approval)

```typescript
class NarrationQueue {
    private queue: NarrationItem[] = []
    private debounceTimer: NodeJS.Timeout | null = null
    private readonly DEBOUNCE_MS = 200

    enqueue(item: NarrationItem) {
        // High priority items (errors, completion) skip the queue
        if (item.priority === "high") {
            this.interrupt()
            this.speakNow(item)
            return
        }

        this.queue.push(item)
        this.scheduleDrain()
    }

    private scheduleDrain() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => this.drain(), this.DEBOUNCE_MS)
    }

    private drain() {
        const batch = this.queue.splice(0)
        const narration = this.synthesizer.batchToSpeech(batch)
        if (narration) this.tts.speak(narration)
    }
}
```

---

## 6. TTS Streaming Integration

### 6.1 TTS Provider Options

| Provider | Streaming | Latency | Quality | Cost |
|----------|-----------|---------|---------|------|
| **OpenAI TTS** (`tts-1`) | Yes (chunked) | ~200ms | Good | $15/1M chars |
| **OpenAI TTS HD** (`tts-1-hd`) | Yes (chunked) | ~400ms | Excellent | $30/1M chars |
| **ElevenLabs** | Yes (WebSocket) | ~150ms | Excellent | Free tier available |
| **Google Cloud TTS** | Yes (streaming) | ~200ms | Good | Free tier 4M chars/mo |
| **Azure Speech** | Yes (WebSocket) | ~100ms | Good | Free tier 500K chars/mo |
| **Coqui / local** | N/A (on-device) | ~50ms | Moderate | Free |
| **Web Speech API** | Yes (browser-native) | ~0ms | Varies by OS | Free |

### 6.2 Recommended: Dual-Mode Architecture

**VS Code Extension** - Use Web Speech API (browser `speechSynthesis`) in the webview for zero-latency, zero-cost narration with an optional upgrade path to cloud TTS:

```typescript
// webview-ui/src/services/NarrationPlayer.ts
class NarrationPlayer {
    private synth = window.speechSynthesis
    private utteranceQueue: SpeechSynthesisUtterance[] = []

    speak(text: string) {
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.1   // Slightly faster than normal
        utterance.pitch = 1.0
        utterance.voice = this.getPreferredVoice()
        this.synth.speak(utterance)
    }

    interrupt() {
        this.synth.cancel()
    }
}
```

**CLI** - Pipe to a local TTS process or cloud API:

```typescript
// cli/src/services/NarrationPlayer.ts
class CLINarrationPlayer {
    // Option A: Local TTS via say (macOS) / espeak (Linux) / powershell (Windows)
    speakLocal(text: string) {
        const cmd = process.platform === "darwin" ? ["say", text]
                  : process.platform === "win32"  ? ["powershell", "-c", `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text}')`]
                  : ["espeak", text]
        spawn(cmd[0], cmd.slice(1), { stdio: "ignore" })
    }

    // Option B: Cloud TTS (OpenAI) - streamed
    async speakCloud(text: string) {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "tts-1", input: text, voice: "nova", response_format: "opus" }),
        })
        // Pipe audio stream to ffplay or similar
        const player = spawn("ffplay", ["-nodisp", "-autoexit", "-i", "pipe:0"], { stdio: ["pipe", "ignore", "ignore"] })
        for await (const chunk of response.body) {
            player.stdin.write(chunk)
        }
        player.stdin.end()
    }
}
```

### 6.3 Streaming Protocol (Extension to Webview)

Narration text flows from the extension to the webview via the existing gRPC message bus. Add a new message type:

```protobuf
// proto/cline/narration.proto
message NarrationEvent {
    string text = 1;         // Text to speak
    string priority = 2;     // "low", "normal", "high"
    bool interrupt = 3;      // Cancel current speech first
}
```

Or use the simpler `postStateToWebview` approach with a new field in the extension state.

### 6.4 Existing Audio Infrastructure

Cline already has audio infrastructure for **dictation** (speech-to-text):

| Component | File | What it does |
|-----------|------|-------------|
| `AudioRecordingService` | `src/services/dictation/AudioRecordingService.ts` | Records microphone via ffmpeg |
| `VoiceTranscriptionService` | `src/services/dictation/VoiceTranscriptionService.ts` | Sends audio to transcription API |
| `AUDIO_PROGRAM_CONFIG` | `src/shared/audioProgramConstants.ts` | Platform-specific ffmpeg args |
| `startRecording` | `src/core/controller/dictation/startRecording.ts` | gRPC handler to start recording |
| `stopRecording` | `src/core/controller/dictation/stopRecording.ts` | gRPC handler to stop recording |

The dictation system provides a reference for:
- Platform-specific audio binary detection (ffmpeg fallback paths)
- gRPC controller patterns for audio features
- Audio service lifecycle management

The new TTS/narration service follows the same patterns but in the **reverse direction** (text -> audio instead of audio -> text).

---

## 7. Webview / UI Integration

### 7.1 Narration Controls

Add a narration control bar to the chat view:

```
┌─────────────────────────────────────────┐
│ 🔊 Thinking Out Loud    ▶ ⏸  🔇  ⚙️   │
│ "Editing the main component file..."    │
└─────────────────────────────────────────┘
```

- **Toggle on/off**: Enable/disable narration
- **Play/Pause**: Pause current narration
- **Mute**: Mute audio but keep generating text (subtitle mode)
- **Settings**: Voice, speed, verbosity level, TTS provider
- **Subtitle text**: Shows what is currently being spoken

### 7.2 Verbosity Levels

| Level | What gets narrated |
|-------|-------------------|
| **Minimal** | Only actions (file edits, commands, errors, completion) |
| **Normal** | Actions + summarized thinking (1-2 sentences) |
| **Verbose** | Actions + full thinking content (for deep understanding) |
| **Everything** | All events including command output, file contents |

### 7.3 Settings Storage

Add to `src/shared/storage/state-keys.ts`:

```typescript
// In Settings interface
narrationEnabled?: boolean
narrationVerbosity?: "minimal" | "normal" | "verbose" | "everything"
narrationVoice?: string           // Voice ID
narrationSpeed?: number           // 0.5 - 2.0
narrationTtsProvider?: "browser" | "openai" | "elevenlabs" | "local"
narrationTtsApiKey?: string       // For cloud TTS providers
```

---

## 8. Implementation Plan

### Phase 1: Minimal Viable Narration (Browser Speech API)

**Goal**: Get voice narration working with zero external dependencies.

1. **Add NarrationEventBus** to `src/services/narration/EventBus.ts`
   - Simple event emitter that collects `ClineSay` events from `say()`
   - Debounces and queues events

2. **Add NarrationSynthesizer** to `src/services/narration/Synthesizer.ts`
   - Template-based narration (no LLM summarization yet)
   - Converts tool/command/text events to spoken sentences
   - Skips reasoning partials, only narrates complete thinking with truncation

3. **Hook into `say()` method** in `src/core/task/index.ts:717`
   - One-line addition: `this.narrationBus?.emit({ type, text, partial })`

4. **Add NarrationPlayer in webview** at `webview-ui/src/services/NarrationPlayer.ts`
   - Uses browser `speechSynthesis` API (Web Speech API)
   - Receives narration text via existing state/message system

5. **Add narration toggle** to settings UI
   - Simple on/off toggle + verbosity dropdown

### Phase 2: Cloud TTS + Quality Improvements

1. **Add OpenAI TTS integration** for higher-quality voice
2. **Add LLM-based summarization** for thinking content
3. **Smarter batching** - group rapid file operations into one sentence
4. **Voice selection UI** - let users pick voice/accent
5. **CLI support** via local TTS (`say`/`espeak`) or cloud TTS + ffplay

### Phase 3: Advanced Features

1. **Contextual tone** - adjust voice tone for errors (concerned) vs completion (upbeat)
2. **Sound effects** - subtle audio cues for events (file save chime, error buzz)
3. **Multi-language** - leverage Cline's i18n system for narration in 8 languages
4. **Custom narration prompts** - let users customize narration style via settings
5. **Podcast mode** - record full narration for later playback/sharing

---

## 9. Key Design Decisions

### Why intercept at `say()` rather than deeper?

The `say()` method at `src/core/task/index.ts:717` is the convergence point for ALL visible output. Intercepting here means:
- One integration point, not 23+ tool handlers
- Consistent event format (`ClineSay` type + text)
- Automatic coverage when new tools/events are added
- No risk of missing events

### Why not use hooks for everything?

Hooks (`PreToolUse`/`PostToolUse`) are external scripts with process spawn overhead (~50-100ms). For real-time narration, the in-process event bus approach is much faster. Hooks are better for the zero-code-changes prototype.

### Why debounce rather than narrate every event?

Cline can emit dozens of events per second during streaming. Speaking every event would:
- Create audio overlap/chaos
- Lag behind actual progress
- Be annoying rather than helpful

Debouncing (200ms window) batches rapid events into coherent narration chunks.

### Why Browser Speech API as default?

- Zero cost (no API keys needed)
- Zero latency (runs locally)
- Works offline
- Available in all VS Code webviews (Chromium-based)
- Good enough quality for narration (not trying to be a podcast)
- Easy upgrade path to cloud TTS later

### Why keep thinking summarization simple initially?

Full LLM summarization for every thinking block would:
- Add latency (API call per thinking block)
- Cost money
- Sometimes lag behind the actual work

Template-based summarization ("I'm thinking about the approach...") is instant and can be enhanced later with an optional LLM pass.

---

## Appendix: Code Reference Quick Links

| Component | File | Line | Purpose |
|-----------|------|------|---------|
| `say()` method | `src/core/task/index.ts` | 717 | Primary interception point |
| `ask()` method | `src/core/task/index.ts` | 578 | Approval event interception |
| Reasoning stream | `src/core/task/index.ts` | 2615 | Raw thinking chunks |
| `ReasoningHandler` | `src/core/task/StreamResponseHandler.ts` | 273 | Thinking accumulation |
| `ToolExecutor` | `src/core/task/ToolExecutor.ts` | 341 | Tool dispatch point |
| `ClineSay` type | `src/shared/ExtensionMessage.ts` | 158 | All say event types |
| `ClineDefaultTool` | `src/shared/tools.ts` | 8 | All tool names |
| Tool handlers | `src/core/task/tools/handlers/` | - | Individual tool logic |
| PreToolUse hook | `src/core/task/tools/utils/ToolHookUtils.ts` | 21 | Hook-based interception |
| PostToolUse hook | `src/core/task/ToolExecutor.ts` | 488 | Post-action hook |
| Audio recording | `src/services/dictation/AudioRecordingService.ts` | - | Existing audio infra |
| Voice transcription | `src/services/dictation/VoiceTranscriptionService.ts` | - | Existing speech-to-text |
| Partial message stream | `src/core/controller/ui/subscribeToPartialMessage.ts` | - | Real-time webview updates |
| State keys | `src/shared/storage/state-keys.ts` | - | Settings storage |
