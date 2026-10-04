/**
 * Earcons: short, quiet tones that say what voice typing is doing without
 * looking at the screen (for blind and low-vision users, and anyone looking
 * at their notes rather than the window). Synthesized with Web Audio, so no
 * audio files ship. Each event has a different contour:
 *
 *   start   two rising notes      (listening)
 *   stop    two falling notes     (finished, text typed)
 *   typed   one soft high blip    (a pause typed text, still listening)
 *   cancel  one low note          (nothing typed)
 *   error   two low notes         (something needs attention)
 *   command two level notes       (listening for a command, nothing is typed)
 *
 * Kept short (under 200 ms) and soft so they don't get transcribed and don't
 * drown a screen reader. Off with Settings > Voice > Sounds.
 */
import { voiceSounds } from "./config";

export type Earcon = "start" | "stop" | "typed" | "cancel" | "error" | "command";

const NOTES: Record<Earcon, [number, number][]> = {
  start: [[660, 0], [880, 0.08]],
  stop: [[880, 0], [660, 0.08]],
  typed: [[990, 0]],
  cancel: [[440, 0]],
  error: [[330, 0], [330, 0.12]],
  command: [[587, 0], [587, 0.09]],
};

let ctx: AudioContext | null = null;

export function playEarcon(kind: Earcon) {
  if (!voiceSounds()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, at] of NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // A soft attack and release: no clicks.
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.12, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.07);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.08);
    }
  } catch {
    // No audio output: the visual and screen-reader cues still work.
  }
}
