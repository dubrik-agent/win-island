import { api } from "./api";

export type SoundId = "chime" | "bell" | "pop" | "alarm" | "none";

export const SOUNDS: Array<[SoundId, string]> = [
  ["chime", "Мягкий звонок"],
  ["bell", "Колокольчик"],
  ["pop", "Щелчок"],
  ["alarm", "Тревога"],
  ["none", "Без звука"],
];

/** One context for the whole app: creating one per beep leaks audio units. */
let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (shared) return shared;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    shared = null;
  }
  return shared;
}

/**
 * WebView2 keeps the audio graph suspended until the page received a real
 * user gesture. Calling this from the first click/keypress means the alarm can
 * still be heard later, when the gesture itself is long gone.
 */
export function primeAudio(): void {
  const ctx = context();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

interface ToneOptions {
  freq: number;
  start: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
  /** Glide to this frequency over the tone's duration. */
  glideTo?: number;
}

function tone(ctx: AudioContext, now: number, opts: ToneOptions): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, now + opts.start);
  if (opts.glideTo) {
    osc.frequency.exponentialRampToValueAtTime(
      opts.glideTo,
      now + opts.start + opts.duration,
    );
  }
  const peak = Math.max(0.0002, opts.gain);
  amp.gain.setValueAtTime(0, now + opts.start);
  amp.gain.linearRampToValueAtTime(peak, now + opts.start + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + opts.start + opts.duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(now + opts.start);
  osc.stop(now + opts.start + opts.duration + 0.03);
}

/**
 * Short interface sounds for the panel itself. They are deliberately quieter
 * and shorter than notifications: the point is a tactile click, not a melody.
 * Everything is gated by the `uiSounds` setting and its volume.
 */
export type UiSound = "expand" | "collapse" | "tab" | "drop" | "toggle";

export function playUiSound(kind: UiSound, enabled: boolean, volume: number): void {
  if (!enabled) return;
  const ctx = context();
  // Never force a resume here: sounds must not unlock audio behind the user's
  // back, and a suspended graph would queue everything for later.
  if (!ctx || ctx.state !== "running") return;
  const v = Math.min(1, Math.max(0, volume));
  if (v === 0) return;
  const now = ctx.currentTime;
  const gain = 0.16 * v;
  if (kind === "expand") {
    tone(ctx, now, { freq: 620, glideTo: 940, start: 0, duration: 0.13, gain });
    tone(ctx, now, { freq: 1240, start: 0.05, duration: 0.1, gain: gain * 0.35 });
    return;
  }
  if (kind === "collapse") {
    tone(ctx, now, { freq: 880, glideTo: 540, start: 0, duration: 0.12, gain });
    return;
  }
  if (kind === "tab") {
    tone(ctx, now, { freq: 1180, start: 0, duration: 0.05, gain: gain * 0.6, type: "triangle" });
    return;
  }
  if (kind === "drop") {
    tone(ctx, now, { freq: 480, glideTo: 1080, start: 0, duration: 0.12, gain });
    return;
  }
  tone(ctx, now, { freq: 760, start: 0, duration: 0.06, gain: gain * 0.7, type: "triangle" });
}

/**
 * Plays one of the built-in notification sounds. Everything is synthesised, so
 * there are no audio files to ship and the sound never depends on the disk.
 * Falls back to the Windows notification sound while the audio graph is still
 * locked behind a user gesture.
 */
export async function playSound(id: SoundId, volume = 0.7): Promise<boolean> {
  if (id === "none") return true;
  const ctx = context();
  if (!ctx) {
    void api.beep().catch(() => undefined);
    return false;
  }
  if (ctx.state !== "running") {
    try {
      await ctx.resume();
    } catch {
      /* resume can be rejected without a user gesture; fall back below */
    }
  }
  // Queueing notes on a suspended graph would fire them all at once later, so
  // use the system sound for this pass instead.
  if (ctx.state !== "running") {
    void api.beep().catch(() => undefined);
    return false;
  }

  const v = Math.min(1, Math.max(0, volume));
  if (v === 0) return true;
  const now = ctx.currentTime;

  if (id === "bell") {
    tone(ctx, now, { freq: 1046.5, start: 0, duration: 1.15, gain: 0.3 * v });
    tone(ctx, now, { freq: 2093, start: 0, duration: 0.75, gain: 0.1 * v });
    tone(ctx, now, { freq: 1568, start: 0.02, duration: 0.9, gain: 0.06 * v, type: "triangle" });
    return true;
  }

  if (id === "pop") {
    tone(ctx, now, { freq: 520, glideTo: 1180, start: 0, duration: 0.11, gain: 0.4 * v });
    return true;
  }

  if (id === "alarm") {
    for (let i = 0; i < 3; i += 1) {
      tone(ctx, now, {
        freq: 1046.5,
        start: i * 0.24,
        duration: 0.17,
        gain: 0.26 * v,
        type: "triangle",
      });
      tone(ctx, now, {
        freq: 523.25,
        start: i * 0.24,
        duration: 0.17,
        gain: 0.12 * v,
        type: "sine",
      });
    }
    return true;
  }

  // "chime" — the default: two soft sine notes, a fifth apart.
  tone(ctx, now, { freq: 880, start: 0, duration: 0.38, gain: 0.28 * v });
  tone(ctx, now, { freq: 1318.5, start: 0.16, duration: 0.5, gain: 0.22 * v });
  return true;
}
