# Voice Input (Speech to Text): Plan

Status: built on `feat/ai-assistant` (2026-10-01); see §13 for what changed from
the plan, §14 for the accessibility research behind the design, and §15 for
platform permissions. Plan written 2026-09-30.

Goal: an **opt-in** dictation feature. After a user turns it on (in Settings or
the first-run prompt), they can press a shortcut or the mic button, speak, and
have the words typed into the document (or into the AI chat box). Everything
runs **on the device**: no cloud speech API, no account, no keys. That is the
same privacy promise as the AI assistant.

The design follows [Handy](https://github.com/cjpais/Handy) (MIT, Tauri 2 +
Rust), which does exactly this system-wide. Sarala only needs the in-app half
of what Handy does, so the build is much smaller.

---

## 1. How Handy does it

Checked at commit `29bd2c0` (2026-09-28). About 31k lines of Rust in `src-tauri/src`.

| Stage | Handy's choice | Where |
|---|---|---|
| Trigger | Global hotkey (`handy-keys`, `rdev`, `tauri-plugin-global-shortcut`). Hold to talk, tap to toggle, or both. Also CLI flags and a SIGUSR2 signal. | `shortcut/`, `transcription_coordinator.rs` |
| Mic capture | `cpal` input stream. The audio callback writes into a wait-free SPSC ring (`rtrb`) and must never allocate, lock or log. A consumer thread drains it every 10 ms. | `audio_toolkit/audio/recorder.rs` |
| Resample | `rubato` down to 16 kHz mono f32, which every speech model expects. | `audio_toolkit/audio/resampler.rs` |
| Silence filter (VAD) | Silero VAD v4 (1.7 MB ONNX, bundled) or **Earshot** (pure Rust, 16 ms frames, no ONNX). Smoothed with a hangover tail so word endings are not clipped. | `audio_toolkit/vad/` |
| Speech engine | **`transcribe-cpp`** (ggml/GGUF; Metal on macOS, Vulkan on Windows x64 and Linux, CPU elsewhere) for Whisper, Parakeet, Moonshine, Canary and others. **`transcribe-rs`** (ONNX Runtime) for a few older formats. Both are the Handy author's crates. | `managers/transcription.rs` |
| Streaming | Some models (Parakeet Unified, Nemotron, Moonshine Streaming) stream. The engine emits `committed` text (never changes) plus `tentative` text (may still be rewritten). | `StreamTextEvent` |
| Models | JSON catalog of about 45 GGUF models on Hugging Face (`handy-computer/*`), with a mirror. Each file has a size and a SHA-256. Downloads resume with HTTP Range, a 60 s stall watchdog and hash verification. | `catalog/`, `managers/model/` |
| Memory | The model is loaded on first use and unloaded after an idle timeout (never, immediately, or 2 to 60 minutes). | `settings.rs` `ModelUnloadTimeout` |
| Output | Pastes into whatever app has focus: clipboard plus a synthesized Cmd/Ctrl+V (`enigo`), `xdotool` or `wtype` on Linux. This needs the macOS **Accessibility** permission. | `clipboard.rs`, `paste_tx/` |
| Clean-up | Filler word removal, a custom word list (fuzzy matched), and optional LLM post-processing. | `audio_toolkit/text.rs` |
| Permissions | `NSMicrophoneUsageDescription` in `Info.plist`, `com.apple.security.device.audio-input` entitlement, and `tauri-plugin-macos-permissions` so onboarding can check and request mic and Accessibility access. | `Info.plist`, `Entitlements.plist`, `onboarding/` |
| Feedback | Floating overlay window (NSPanel on macOS, layer-shell on Wayland) with a level meter, plus start and stop sounds. | `overlay.rs`, `audio_feedback.rs` |

### What Sarala does not need

Handy's hardest code exists because it types into *other* apps. Sarala only
types into its own editor, so we can skip:

- **Global hotkeys** (`rdev`, `handy-keys`, X11 auto-repeat workarounds). An in-app keydown handler is enough.
- **Paste simulation and the Accessibility permission** (`enigo`, `paste_tx`, `xdotool`/`wtype`). We insert the text directly.
- **Overlay windows** (NSPanel, gtk-layer-shell). The indicator lives inside our own window.
- **Tray, autostart, single-instance, CLI remote control, history database.**

What we keep is the core pipeline: **cpal, resample, VAD, local model, text**,
plus model download and the mic permission.

---

## 2. Decisions

### 2.1 Capture in Rust, not in the webview

We could call `getUserMedia` from JavaScript. We will not, because:

- WKWebView (macOS) and WebKitGTK (Linux) have uneven `getUserMedia` support
  inside Tauri, and permission prompts come from the webview, not the app.
- The Web Speech API (`webkitSpeechRecognition`) sends audio to Apple or Google
  servers. That breaks the no-cloud rule, and it is missing on Linux.
- The audio has to reach Rust for the model anyway. Capturing there avoids
  sending raw PCM over IPC.

So: **`cpal` in Rust**, like Handy.

### 2.2 Speech engine: `transcribe-cpp` (GGUF), with `whisper-rs` as the fallback

`transcribe-cpp` runs Whisper, Parakeet and Moonshine through one ggml backend.
It needs no ONNX Runtime, supports streaming, and Handy ships it on all three
OSes. Metal on macOS makes Parakeet and Whisper fast on Apple Silicon.

Risk: it is pre-1.0 (0.2.x) with a single maintainer. We mitigate by keeping
the engine behind a small Rust trait (`SpeechEngine { load, transcribe, stream }`)
so we can move to `whisper-rs` (whisper.cpp bindings, widely used, Whisper
models only) without touching the UI.

Both compile C/C++ with CMake, so CI and contributors need `cmake`. See §9.

### 2.3 VAD: Earshot, not Silero

Earshot is pure Rust (about 8 KB of state) and needs no ONNX Runtime. Silero
would pull in `ort`, which is large and has caused CPU compatibility crashes in
Handy on Windows. VAD is used to trim silence before and after speech, and to
split long dictation into chunks for models that do not stream.

### 2.4 Models: download on opt-in, never bundled

The app installer stays the same size. When the user opts in, we download one
model into `<app data>/voice/models/` with resume and SHA-256 checks. We offer
a short list, not Handy's 45:

| Choice shown to the user | Model (GGUF) | Download | Languages | Notes |
|---|---|---|---|---|
| **Fast and accurate, English** (default for English locales) | Parakeet Unified EN 0.6B, Q4_K_M | 477 MB | English | Streams live text. Best speed/accuracy in Handy's scores (79/90). CC-BY-4.0. |
| **Many languages** (default otherwise) | Whisper Small, Q4_K_M | 172 MB | about 99 | Not streaming; we use VAD chunks. Apache-2.0. |
| **Small and quick** | Moonshine Base, Q8_0 | 77 MB | English | For older machines or small disks. MIT. |
| More accurate, larger (under "More models") | Whisper Large v3 Turbo, Q4_K_M | 536 MB | about 99 | Slower. |

Source: the `handy-computer/*-gguf` repos on Hugging Face (public, no token).
We pin each file's revision and SHA-256 in a small catalog in our repo. This
keeps us independent of Handy's catalog format and mirror, and a model
update means a new pinned catalog entry.

Download transport: Sarala already downloads Pandoc with `curl` and a progress
modal (`download_pandoc` in `main.rs`, `PandocDownloadModal.tsx`). We reuse that
pattern (`curl -L -C -` resumes a partial file; curl is built into Windows 10+,
macOS and most Linux). This means we add no HTTP crate. Write to
`<file>.partial`, verify the hash, then rename. This matches the app's atomic
write rule.

### 2.5 Where the text goes

1. **Editing a block:** insert at the caret with `document.execCommand("insertText", ...)`
   on the focused block. This takes the same path as typing: `Block.tsx` `onInput`
   reads `textContent` and calls `updateBlock`. So the **block invariant** holds
   (we insert plain source text, and live styling runs afterwards as it does
   for keystrokes), native undo works, and one dictation is one undo step.
2. **AI chat box focused:** insert into the textarea. Dictating a prompt to the
   assistant is a natural pairing.
3. **Nothing focused:** append a new paragraph after the current block through
   `spliceMany`, then place the caret at its end.
4. **Live text while speaking** is **not** written into the block. It is shown
   as a floating "ghost" line at the caret (like the selection toolbar),
   because tentative words change and writing them into the block would fight
   the caret logic. On stop, the final text is inserted once.
5. **Paragraphs:** a spoken "new paragraph" (or a long pause, a setting that is
   off by default) splits into a new block. We use `spliceMany` so it stays one
   undo step.

**IME safety:** do not start or insert while a composition is active
(`isComposing` / `compositionstart`). If a composition starts during
recording, hold the final text until `compositionend`.

### 2.6 Trigger

- **Shortcut:** default **Fn/Globe hold is not used** (it only works on Apple
  keyboards, as Handy documents). Default is **Option+Space hold to talk** on
  macOS and **Ctrl+Alt+Space** elsewhere, with a tap toggling it on and off
  (Handy's "hold or toggle" mode: a hold over 400 ms stops on release, a
  shorter tap latches). The shortcut can be changed in Settings. It only works
  while the Sarala window is focused.
- **Mic button:** in the top bar beside Focus mode (moved from the status bar, where it was too faint), and inside the AI composer.
- **Menu and palette:** Edit > Start Dictation (menu.rs, menudata.ts), and the
  command palette entry `voice.toggle`.
- **Escape** cancels and throws the audio away.

---

## 3. User experience

### 3.1 Opt-in

Voice input is **off** and costs nothing until turned on: no model, no mic
access, no background thread.

Entry points:
- **Settings > Voice Input** section: toggle, model picker, microphone picker,
  language, shortcut, "unload model when idle" timer, "remove model" button.
- **The mic button** (only shown once the feature is enabled, or as a dimmed
  "Set up dictation" item in the command palette).
- **First-run onboarding card** (one card, skippable): "Type with your voice.
  Runs on this Mac, nothing is uploaded." with Set up / Not now.

Set-up flow (one modal, same style as the Pandoc modal):
1. **Choose a model** (the table in §2.4, sizes shown, one recommended by locale).
2. **Download** with progress, cancel, and resume after quitting.
3. **Microphone permission.** On macOS, starting the first capture triggers
   the system prompt. If access was denied, we show "Microphone access is off
   for Sarala" with a button that opens System Settings > Privacy > Microphone.
4. **Try it:** a small test field. "Say something" with a live level meter.
   Done.

### 3.2 While dictating

- The mic button turns red with a pulsing ring driven by the input level.
- A ghost line at the caret shows live text: committed words in normal ink,
  tentative words dimmed. Non-streaming models show "Listening..." then
  "Transcribing..." with a spinner.
- The status bar shows the elapsed time. Recording stops automatically after
  about 2 minutes of silence or 10 minutes total.
- On stop, the text lands and briefly flashes (reuse `flashApplied` from the AI panel).
- `prefers-reduced-motion`: no pulse, only a static colour change.

### 3.3 Errors

| Problem | What the user sees |
|---|---|
| No input device | "No microphone found" plus a picker refresh. |
| Permission denied | Banner with an "Open Privacy Settings" link. |
| Model file missing or corrupt | "Voice model needs to be downloaded again" with a Download button. |
| Engine failed to load (for example an old CPU) | Suggest the Small model; show the error in details. |
| Nothing heard | "Didn't catch that". Nothing is inserted. |

---

## 4. Architecture

```
 Sarala window (Solid)                           Rust (src-tauri/src/voice/)
 ─────────────────────                           ─────────────────────────────
 mic button / shortcut ── invoke voice_start ──► VoiceState (managed)
                                                  ├─ Recorder: cpal stream ─► rtrb ring
                                                  │     consumer thread: resample 16k mono,
                                                  │     Earshot VAD, level meter
                                                  ├─ Engine (transcribe-cpp), loaded lazily,
                                                  │     unloaded after idle timeout
 ghost line  ◄─ event "voice" {level, committed, tentative, phase} ─┘
 insertText  ◄─ voice_stop returns final text
```

### 4.1 Rust module layout (new, about 1.2k lines)

- `voice/mod.rs`: `VoiceState` (managed state), Tauri commands, events.
- `voice/recorder.rs`: cpal input, ring buffer, consumer thread. We port the
  shape of Handy's `recorder.rs` (MIT, credited in the file header).
- `voice/resample.rs`: `rubato` wrapper.
- `voice/vad.rs`: Earshot plus a hangover tail.
- `voice/engine.rs`: `SpeechEngine` trait and the `transcribe-cpp` implementation.
- `voice/models.rs`: pinned catalog, download, verify, delete, list installed.

### 4.2 Tauri commands

| Command | Does |
|---|---|
| `voice_models()` | Catalog plus which models are installed, with sizes. |
| `voice_download(model_id)` | Downloads with `voice-download` progress events. |
| `voice_cancel_download()` / `voice_delete_model(id)` | |
| `voice_devices()` | Input device names. |
| `voice_start(device?, model_id, language?)` | Opens the mic, loads the model if needed, begins streaming. Returns quickly; progress arrives as `voice` events. |
| `voice_stop()` | Stops, flushes, returns the final text. |
| `voice_cancel()` | Stops and discards. |
| `voice_unload()` | Frees model memory (also run on the idle timer). |
| `voice_permission()` | macOS: `AVCaptureDevice.authorizationStatus` via `objc2`, or `tauri-plugin-macos-permissions`. Other OSes: "unknown", and we find out on open. |

### 4.3 Rust and Tauri notes (for a TypeScript reader)

- **Threads, not async, for audio.** cpal calls our callback on a real-time OS
  audio thread. If that callback blocks (a lock, an allocation, a log write),
  you hear clicks or lose audio. So the callback only pushes samples into a
  lock-free ring buffer (`rtrb`). The ring has one writer and one reader, and
  the ownership rules enforce that: the producer half is *moved* into the
  callback closure, and the consumer half is moved into our worker thread.
  Neither can be shared by mistake.
- **`cpal::Stream` is not `Send` on some platforms.** It must stay on the thread
  that created it. So the worker thread owns the stream and we talk to it
  through an `mpsc` channel of commands (`Start`, `Stop(reply_sender)`,
  `Shutdown`). This is the same pattern as Handy's `Cmd` enum. `voice_stop`
  sends `Stop` with a one-shot reply channel and waits for the text.
- **Managed state.** `app.manage(VoiceState::default())` stores one instance
  that every command can borrow with `State<'_, VoiceState>`. Inside it, fields
  that change are wrapped in `Mutex` (or atomics for flags like "is recording"),
  because Tauri may run commands on several threads at once. This is the same
  as `AgentRuns` in `ai.rs`.
- **Model loading is slow (0.5 to 3 s), so it runs in `spawn_blocking`**, like
  `ai_agent_status`. Otherwise it would block Tauri's async runtime. We
  pre-load when the mic button is first hovered or the window gains focus with
  voice enabled, so the first press feels instant.
- **Events** (`app.emit("voice", payload)`) are throttled to at most 20 per
  second so streaming text does not flood IPC.
- **No new capability permissions** are needed in `capabilities/`: those gate
  frontend access to plugins, and our own commands are allowed by being
  registered in `invoke_handler`.

### 4.4 Frontend (new, about 700 lines)

- `src/voice/config.ts`: signals and settings (`voiceEnabled`, `voiceModel`,
  `voiceDevice`, `voiceLanguage`, `voiceShortcut`, `voiceUnloadMinutes`),
  hydrated in `settings.ts` like `hydrateAiSettings`.
- `src/voice/session.ts`: start/stop/cancel, the hold-or-toggle state machine,
  the caret target (block, AI composer, or new paragraph), and insertion.
- `src/voice/transport.ts`: Tauri calls, plus a **DEV mock** that plays scripted
  text so `pnpm dev` and the e2e tests work without a mic or model (same idea
  as `src/ai/mock.ts`, and excluded from production via `import.meta.env.DEV`).
- `src/components/VoiceButton.tsx`, `VoiceGhost.tsx`, `VoiceSetup.tsx`, and a
  Settings section.
- `src/styles/voice.css`: kept out of `app.css` because `app.css` is inlined
  into HTML exports.

---

## 5. Platform setup

| Platform | Change |
|---|---|
| macOS | Add `src-tauri/Info.plist` with `NSMicrophoneUsageDescription` ("Sarala uses the microphone for dictation. Audio is processed on this Mac and never uploaded."). Add the `com.apple.security.device.audio-input` entitlement, which the hardened runtime needs for notarized builds. Metal backend. |
| Windows | Nothing required at build time. Windows can block mic access per app under Privacy settings; we detect the failed open and link to `ms-settings:privacy-microphone`. Vulkan backend on x64, CPU on ARM (as Handy does). |
| Linux | ALSA/PulseAudio/PipeWire through cpal. The build needs `libasound2-dev`. **Snap:** add the `audio-record` plug (it needs manual connection or store approval), so dictation in the snap may need `snap connect sarala:audio-record`. We state this in the setup modal when running under snap. |

---

## 6. Performance budgets

| Metric | Target |
|---|---|
| App start with voice off | No change (nothing loads). |
| App start with voice on | No change (model loads lazily). |
| Press to "listening" (model warm) | under 150 ms |
| First load of the model | under 3 s on Apple Silicon for Parakeet Q4 |
| Stop to final text (10 s clip, warm, M-series) | under 500 ms |
| Memory with the model loaded | Parakeet Q4: about 600 MB; Moonshine Base: about 150 MB. Unloaded after 5 idle minutes by default. |
| Installer size | Plus 3 to 8 MB for the engine (to be measured). |

We add a `tests/perf-voice.mjs` budget for the frontend (event handling and
ghost-line rendering), and an ignored Rust bench that times a fixture WAV.

---

## 7. Accessibility

- The mic button is a real `<button>` with `aria-pressed` and the label
  "Start dictation" or "Stop dictation", keeping 24 px or larger targets.
- State changes are announced in the existing sr-only status region:
  "Listening", "Transcribing", "Inserted 14 words".
- The ghost line is `aria-hidden`. Screen reader users hear the result when it
  is inserted, not every tentative word.
- Everything works from the keyboard (shortcut, menu, palette).
- Mind **screen reader conflicts**: VoiceOver uses Ctrl+Option, so our default
  avoids it. The setting lets users choose another key.
- Level meter and pulse respect `prefers-reduced-motion` and `forced-colors`.
- Add the new surfaces to `tests/e2e-a11y.mjs` and `tests/e2e-keyboard.mjs`.

Dictation is itself an accessibility feature (RSI, motor impairments,
dyslexia). This is a good reason to make it work well with the keyboard alone.

---

## 8. Testing

- **Rust unit tests:** resampler (48 kHz stereo to 16 kHz mono), VAD trimming
  on synthetic silence/tone, catalog hash checks, partial-file resume logic,
  hold-or-toggle timing.
- **Rust integration (ignored by default, like `live_status`):** load Moonshine
  Tiny (35 MB) and transcribe `tests/fixtures/voice/hello.wav`, checking that the
  expected words appear.
- **Frontend unit tests:** insertion target selection, IME deferral, and the
  "new paragraph" split producing one undo step.
- **e2e with the DEV mock (`tests/e2e-voice.mjs`):** opt-in flow, setup modal,
  mic button states, ghost line, text landing at the caret, Escape cancelling,
  AI composer dictation, and the block invariant (textContent equals source)
  after insertion.
- **Manual:** real mic on macOS (Intel and Apple Silicon), Windows, Linux
  (X11, Wayland, snap), with a Bluetooth headset (Handy warns this degrades
  audio on macOS), and with VoiceOver.

---

## 9. Build and CI impact

- New crates: `cpal`, `rtrb`, `rubato`, `earshot`, `transcribe-cpp`, `sha2`
  (`hound` for tests only). Also `objc2-av-foundation` on macOS for the
  permission check, unless we take `tauri-plugin-macos-permissions`.
- `transcribe-cpp` builds ggml with **CMake**. CI runners need `cmake`
  (installed on GitHub macOS and Windows images; add it to the Linux job) and
  `libasound2-dev` on Linux. The first build gets several minutes slower. Later
  builds use the cache.
- Put the whole feature behind a **Cargo feature `voice`**, on by default for
  release builds. Contributors can build without it
  (`--no-default-features`) if they lack CMake. The frontend asks
  `voice_supported()` and hides the feature when it is compiled out.
- Licences: Handy is MIT (we credit ported code). Parakeet is CC-BY-4.0, so
  we must show attribution in About > Acknowledgements. Whisper is Apache-2.0
  and Moonshine is MIT.

---

## 10. Phases

| Phase | Scope | Size |
|---|---|---|
| **1. Pipeline spike** | `voice` feature, cpal recorder, resampler, `transcribe-cpp` with Moonshine Tiny, a debug command that transcribes 5 s of mic audio. Check build size, CMake in CI, and Metal. | 2 to 3 days |
| **2. Models and opt-in** | Pinned catalog, curl download with resume and SHA-256, Settings section, setup modal, macOS `Info.plist` and entitlement, permission check. | 3 days |
| **3. Dictation in the editor** | Hold-or-toggle shortcut, mic button, `voice` events, ghost line, insertion into blocks and the AI composer, IME handling, undo, Escape. | 3 to 4 days |
| **4. Streaming and polish** | Parakeet streaming (committed/tentative), VAD chunking for Whisper, idle unload, pre-warm, "new paragraph" command, sounds (optional, off by default). | 3 days |
| **5. Hardening** | a11y and keyboard tests, e2e with the mock, perf budgets, Windows/Linux/snap checks, docs, acknowledgements. | 2 to 3 days |

Roughly **2.5 to 3 weeks** in total. Phase 1 is the go/no-go point: if
`transcribe-cpp` gives build or size trouble, switch to `whisper-rs` with
Whisper Base/Small before building the UI on top.

---

## 11. Later, if wanted

- **"Dictate to AI":** hold the shortcut in the AI panel, speak the request,
  and send on release. Pairs with the CLI agents we already support.
- **Voice commands:** "new heading", "bullet", "undo that". This is a small
  grammar applied to the final text before insertion.
- **Custom vocabulary:** a word list for names and jargon, fuzzy matched as
  Handy does.
- **Clean-up with the AI agent:** an optional "tidy dictation" quick action
  that sends the inserted text to the configured CLI agent. It reuses the
  proposal cards, so the user reviews each change.
- **System-wide dictation:** out of scope. That is what Handy is for, and it
  would need Accessibility permissions.

## 12. Decisions taken

1. **Default shortcut:** Cmd+Shift+D on macOS (Option+Space, first chosen,
   is Alfred's default and taken by the ChatGPT app), Ctrl+Alt+Space elsewhere.
   Any other can be recorded; see §14.
2. **No unsolicited first-run card.** The opt-in starts from Settings > Voice,
   Edit > Voice Typing, the command palette, or the shortcut. Can be revisited.
3. **Default model by locale:** Parakeet (477 MB, live words) for English,
   Whisper Small (172 MB, multilingual) for everyone else. The download size
   is on the button before anything is fetched.

## 13. As built (2026-10-01)

Files: `src-tauri/src/voice/` (`mod.rs` commands and downloads, `audio.rs`
capture, `engine.rs` engine thread, `vad.rs`, `catalog.rs`, `permission.rs`),
`src/voice/` (`config.ts`, `session.ts`, `text.ts`, `transport.ts`, `mock.ts`),
`src/components/VoiceHud.tsx`, `VoiceSetup.tsx`, `VoiceSettings.tsx`,
`src/styles/voice.css`, `src-tauri/Info.plist`, `src-tauri/Entitlements.plist`.

Different from the plan:

- **Words stream into the document as they are spoken** (revised after use:
  showing them only in a floating panel left nothing happening in the document
  until the end, and meant nothing to a screen reader). Listening opens a
  "live region" at the caret (the active block, a text field, the last caret
  position, or a new paragraph) and every recognition update rewrites just that
  region through the store, so the block's text stays its Markdown source.
  Words that may still change carry a CSS highlight (`::highlight(voice-live)`,
  no extra elements); finishing writes the final text and flashes it
  (`voice-typed`); cancelling restores the text exactly. A whole dictation is
  one undo step (`beginEditGroup`/`endEditGroup` in the store; a cancelled one
  leaves no step). If the text is edited during dictation, streaming stops and
  the result goes to the caret. The HUD keeps only status and Done/Cancel.
  Screen readers are not fed words mid-dictation on purpose: their speech would
  be picked up by the microphone and typed back; they hear the read-back when
  dictation ends.
- **Return keeps, Escape discards (recoverably).** Return is the confirm key
  in every dialog, so it finishes dictation and keeps the text; Escape
  discards. While words are arriving, Return only finishes: no line break, no
  AI message sent. The panel's buttons show their keys (Done ⏎, Cancel Esc).
  Because a stray Escape after a long dictation would silently lose work, the
  discard is its own undo step: Cmd/Ctrl+Z brings the words back at any time
  (the screen reader is told so), and the "Discarded" notice has a Restore
  button for 15 s. (macOS Dictation stops on Escape or its shortcut; Windows
  voice typing on Win+H, its mic button, or "stop listening".)
- **Audio is queued while the model loads**, so the user can start talking at
  once; the engine thread processes the queue when the model is ready.
- **Previews for non-streaming models:** while listening, Whisper and
  Moonshine re-run on the audio so far at most a third of the time (about
  every second), shown as tentative text. Streaming models (Parakeet) show
  committed and tentative words directly.
- **Microphone permission on macOS is checked with AVFoundation** before
  opening the stream, because without access macOS delivers silence rather
  than an error. The device list is not read until access is granted: listing
  devices while undecided triggers the system prompt.
- **Download** goes through `curl` like Pandoc's, into `<file>.partial`,
  resumable, SHA-256 checked against the pinned catalog, then renamed.
- **Text fitting** (`src/voice/text.ts`): a space where words would touch, none
  inside an opening emphasis marker (`**|**`), the model's capital lowered
  mid-sentence (not "I" or acronyms), and a spoken "new paragraph" splits the
  block.
- **Voice event names**: `voice` (phase, level, text, loaded, unloaded, error)
  and `voice-download` (download, verify, done, cancelled, error).

Measured on an Apple Silicon Mac (Metal):

| | |
|---|---|
| Moonshine Tiny, 4 s clip | first load 12.7 s (one-time Metal shader compile), then 49 ms load, 45 ms transcribe |
| Parakeet, 4 s clip through the engine thread | 0.3 s for load + stream + finalize with a warm shader cache |
| Release binary (macOS arm64) | 14.2 MB with voice, 9.1 MB built without it: +5.0 MB. Models are downloaded separately. |

Tests: `cargo test` (resampler, level meter, voice detection, splitting long
clips, caption cleanup, catalog, download resume/damage/oversize/failure,
event shape); ignored live tests `live_transcribe` (a WAV through the engine
thread) and `live_microphone` (real mic while `say` speaks);
`tests/voice.test.mjs` (text fitting, "new paragraph", shortcut matching);
`tests/e2e-voice.mjs` (about 70 checks against the dev mock: set-up, every
shortcut mode, hands-free pauses, commands, correction, read-back, sounds via a
fake AudioContext, the recorder and its clash and WCAG 2.1.4 checks, silent
microphone, snap and unsupported-CPU messages, the remembered caret); voice
states in `tests/e2e-a11y.mjs` in a light and a dark theme; ignored live tests
`live_commit` (two sentences through "type at each pause", on Moonshine and
Parakeet) and `live_microphone`.

Not verified yet:

- A real microphone in the app (the live mic test needs a person to answer
  the macOS permission prompt).
- Windows and Linux builds and capture; the snap's `audio-record` plug.
- The universal macOS build (x86_64 slice of the C++ engine) in CI.
- Whisper models through the app (the engine path is shared with Moonshine,
  which was tested).

Build note: `transcribe-cpp` needs CMake. On a Mac whose Command Line Tools
left a near-empty `CommandLineTools/usr/include/c++/v1` behind, C++ headers are
not found (`'array' file not found`); reinstall the Command Line Tools or
build with `CXXFLAGS="-isystem $(xcrun --show-sdk-path)/usr/include/c++/v1"`.

## 14. Accessibility research and what it changed (2026-10-01)

Voice typing is an accessibility feature first: for people with motor
impairments, repetitive strain injury or tremor it can be the main way to
write, and blind and low-vision people use dictation more than any other text
entry method on phones. What we read, and the design decision each finding led
to:

| Finding | Source | Decision |
|---|---|---|
| Blind dictation users can't tell what was recognized: dictation tools have no way to hear back what was just typed. DictationBridge exists mainly to echo dictated text through the screen reader. | [AFB AccessWorld on DictationBridge](https://afb.org/aw/19/4/15104) | **Read-back** (on by default): after typing, the screen-reader status region says "Typed: …" with the exact text inserted. It is silent for everyone else. |
| Detecting a recognition error is easy, correcting it is hard: users can't get the cursor to the error and delete whole messages instead. | [Perceptions of Blind Adults on Non-Visual Mobile Text Entry](https://arxiv.org/html/2410.22324v3) | **"Scratch that"** (also "delete that"/"undo that", and Edit > Voice Typing > Remove Last Dictation) removes the last dictation exactly; **Select Last Dictation** selects it so the next dictation replaces it. No cursor travel needed. |
| Dictation that treats every pause as "finished" cuts people off mid-thought. | same study | Pauses **never** end a dictation by default. "Type what I said, keep listening" and "type and stop" are opt-in, with a configurable pause length (1-5 s). |
| Pressing a key (or holding it) to talk is a barrier for many motor-impaired users; people need to adjust how activation works. | [voicecontrol.chat on accessible voice features](https://voicecontrol.chat/blog/posts/accessibility-and-speech-designing-voice-features-that-actually-help), push-to-talk literature | **Shortcut behaviour** setting: hold-or-tap (default), press-to-toggle only (no holding, and a long press can't stop it by accident), hold-only. **Hands-free**: with "type at each pause", one press starts a session that types as you go; "stop listening" ends it by voice. Any key can be recorded (one you can reach), and the mic button works with Voice Control / Voice Access by name ("click Voice typing"). |
| Single-character shortcuts get triggered by speech-input users and by typing. | [WCAG 2.1.4 Character Key Shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html) | The recorder refuses a printable key without Ctrl/Alt/Cmd; function keys and Insert/Pause may stand alone. Escape, Tab, Enter, arrows and other editing keys are refused. |
| Option+Space is Alfred's default hotkey and is taken by the ChatGPT desktop app; Control+Space switches input sources on macOS and toggles IMEs on Windows/Linux. A hotkey taken by another app silently never arrives. | [hotkey conflict reports](https://github.com/openai/codex/issues/49201) | Mac default is **Cmd+Shift+D**; Option+Space is offered with a warning; Control+Space is not offered. The set-up asks you to press the shortcut and shows "✓ The shortcut works" when it arrives, or says another app may own it. The recorder names any Sarala command that already uses a combination; a test checks no preset clashes. |
| Screen readers own some keys: VoiceOver Control+Option, NVDA/JAWS Insert and Caps Lock. | screen reader documentation | No default uses them; Insert is offered on Windows/Linux only with a "not with NVDA or JAWS" note. |
| Audio feedback matters when you can't see the screen, but must not drown the screen reader or leak to bystanders. | [Perceptions of Blind Adults…](https://arxiv.org/html/2410.22324v3) | **Earcons** (Settings > Sounds): two rising notes to start, two falling to finish, a soft blip when a pause types text, one low note for cancel, two low for errors. Under 200 ms and quiet. |
| macOS Dictation users know a vocabulary: "new line", "new paragraph", "comma", "period", "question mark", "open quote"… "Scratch that" belongs to Voice Control. | [Apple: Commands for dictating text](https://support.apple.com/guide/mac-help/commands-for-dictating-text-on-mac-mh40695/mac) | Same words. Layout commands are on by default; spoken punctuation is opt-in because the models already punctuate and "period" is also a word. Commands that act ("scratch that", "stop listening") only count when said on their own. |
| A mic button pressed by Voice Control, a switch or the mouse can take focus away from the text. | our testing | Sarala remembers where the caret last was (block and offset, or a text field) and types there if that text is unchanged; otherwise a new paragraph. |

Other accessibility details: every state is announced (Listening, with how to
finish; Typing; Typed …; Removed …; errors), the HUD's live words are
`aria-hidden` (tentative words change constantly), all controls have names and
24 px targets, `prefers-reduced-motion` stops the pulse and animations,
`forced-colors` is styled, and the voice surfaces are scanned with axe in a
light and a dark theme (0 violations; the dark scan found and fixed white-on-
light-accent buttons, including the shared Pandoc dialog's).

## 15. Platforms and permissions

| | macOS | Windows | Linux (deb, rpm, AppImage) | Snap | Flatpak |
|---|---|---|---|---|---|
| **Permission** | Microphone (TCC). Sarala asks via AVFoundation the first time; the prompt shows `NSMicrophoneUsageDescription` from `src-tauri/Info.plist`. | None to grant per app. Two switches in Settings > Privacy & security > Microphone ("Microphone access", "Let desktop apps access your microphone") allow all desktop apps or none. | None. | `audio-record` interface: **not auto-connected**, so the user runs `snap connect sarala:audio-record` once (or the store grants auto-connect). | `--socket=pulseaudio` in the manifest: granted at install, no prompt. |
| **Build-time change** | `Info.plist` (usage string), `Entitlements.plist` with `com.apple.security.device.audio-input` (needed once builds use the hardened runtime for notarization). | None (cpal uses WASAPI; no manifest capability for unpackaged apps). | `libasound2-dev` to build; `libasound2` / `alsa-lib` as deb/rpm dependency. | `audio-record` + `audio-playback` plugs; `libasound2` and `libasound2-plugins` staged; ALSA routed to PulseAudio/PipeWire with a bundled `asound.conf` and layouts. | `--socket=pulseaudio`; offline crate list regenerated (`flatpak/gen-sources.sh`). |
| **How Sarala checks** | `authorizationStatusForMediaType` before opening the mic: denied shows a message and an "Open Privacy Settings" button. The device list isn't read until access is granted (that alone triggers the prompt). | Reads the consent registry keys (`HKLM`/`HKCU` `…\CapabilityAccessManager\ConsentStore\microphone` and `\NonPackaged`) with `reg query`; "Deny" shows how to turn it on, with a button to `ms-settings:privacy-microphone`. | — | Detected via `$SNAP`; messages include the `snap connect` command with a Copy button. | Detected via `$FLATPAK_ID`. |
| **Fallback check, all platforms** | A blocked microphone usually records **digital silence** rather than failing. If the level is exactly zero for 2.5 s, the HUD says so (with the platform's fix) and plays the error sound; a real microphone always has some noise. | | | | |
| **Speech engine** | Metal (Apple Silicon and Intel), verified: an Intel build cross-compiled on Apple Silicon transcribes correctly under Rosetta. | CPU. | CPU. | CPU. | CPU. |

**CPU baseline.** By default ggml is compiled for the build machine's own CPU,
so a release built on a new CI runner would crash older computers with an
illegal instruction. Releases (GitHub workflow, snap, Flatpak) set
`TRANSCRIBE_CMAKE_ARGS="-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON
-DGGML_FMA=ON -DGGML_F16C=ON -DGGML_AVX512=OFF"`: x86-64 with AVX2 (Intel
Haswell / AMD Excavator, 2013 on). At runtime Sarala checks for AVX2, FMA and
F16C and, if missing, says "Voice typing needs a processor with AVX2" instead
of loading the engine. Shipping several CPU variants (ggml's dynamic backends,
as Handy does) would cover older machines, at the cost of bundling extra
libraries per platform.

**Verified here (macOS, Apple Silicon):** the build with and without the
feature; the portable flags; the Intel slice under Rosetta; the platform-
specific Rust (Windows registry check and WASAPI capture, Linux, Intel macOS)
type-checks for each target; the app starts with voice compiled in.
**Not verified:** real Windows and Linux machines, the snap and Flatpak
packages, a person answering the macOS prompt, and screen readers (VoiceOver,
NVDA, JAWS, Orca) driving it.

## 16. Commands, the command key, and the benchmark (2026-10-02)

### Commands

- **Structure** (anywhere in a dictation, always starting with "new"/"next"):
  "new paragraph", "new line", "new bullet …" / "next bullet …", "new task …",
  "new heading …". A bullet after a list line continues the list (one line
  break); elsewhere it starts a new block (blank line), as Markdown needs.
  After an article or determiner ("add a new task", "the new heading") the
  words stay text.
- **Acting on what you just said** (only as the whole utterance): "scratch
  that" (also delete/undo that), "select that", "make that bold" / "bold
  that", "make that italic" / "italicize that", "make that a heading / bullet
  / task", "stop listening", "what can I say". "That" is the last line
  dictated (the last list item after "new bullet …"). "Scratch that" removes
  the whole dictation, even one that split into several blocks, as an
  ordinary edit: Undo brings it back. Each "…that" change is one undo step.
- **Spoken punctuation** (opt-in): comma, period, question mark, exclamation
  point, colon, semicolon, ellipsis, open/close quote, open/close paren,
  hyphen.
- **"What can I say?"** opens a commands sheet (also the voice panel's
  Commands button, Edit > Voice Typing > Voice Commands…, the command
  palette). Headings and description lists, so screen readers can move by
  section.

### The command key

Right Option (Mac) or Right Ctrl (Windows/Linux), pressed on its own: **tap**
to start or stop dictating; **hold** to say a command. While dictating,
holding it types what was said so far, plays a distinct sound and shows "Say
a command"; what is said until release runs as a command and is never typed
(so "undo", "redo" and bare "new paragraph" work too, and a non-command says
so). Held while not dictating, it is a one-shot command. It is a quasimode
(the mode lasts only while the key is held, so it can't be forgotten), it
backs off if another key is pressed with it (Option+E types an accent), and
spoken commands keep working without it for anyone who can't hold keys. Not
Right Alt on Windows/Linux (AltGr types characters), not Caps Lock or Insert
(NVDA/JAWS keys), not Fn/Globe (can't be read reliably). Settings > Voice >
Command key, or Off.

### Benchmark

`node tests/voice-bench.mjs [model.gguf …]` (macOS) builds 67 spoken clips
with system voices (US, UK, Australian, Indian, Irish and South African
English; commands; silence, white noise, hum, short, fast, slow, loud,
quiet, noisy, long, paused; French) and runs each through the real engine
(the ignored Rust test `live_bench`), scoring word error rate, speed,
robustness and whether each command's real transcript does the right thing
in the app's parser. Results on Apple Silicon (2026-10-02):

| Model | WER, 6 accents | Speed (× real time) | Commands | Robustness |
|---|---|---|---|---|
| Parakeet (English) | 0.0% | 0.028 | 36/36 | all pass |
| Whisper Small | 0.0%, French 0% | 0.035 | 35/36 | all pass |
| Moonshine Base | 1.3% | 0.012 | 32/36 | all pass |
| Moonshine Tiny | 2.2% | 0.011 | 30/36 | speech in noise weak |

What it changed: steady noise made Whisper invent text (Korean, for white
noise) and Moonshine Tiny type "You", so "someone spoke" now also requires
loudness that rises and falls like syllables (steady noise measured 0.03,
every speech clip 0.46 or more; threshold 0.15). Short command words get
misheard ("bold that" → "go that", "all that"), so the longer "make that
bold / italic" are the primary phrases and common mishearings ("bolt that",
"scratched that", "coma") are accepted.
