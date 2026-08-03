type AudioContextConstructor = new () => AudioContext;

export type PlaybackNormalizer = {
  activate: () => Promise<void>;
};

const VOLUME_STORAGE_KEY = "gezamenlijke-top-50-volume";
const VOLUME_EVENT = "gezamenlijke-top-50-volume-change";
const DEFAULT_VOLUME = 85;

export function getGlobalPlaybackVolume(): number {
  const stored = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= 0 && stored <= 100 ? Math.round(stored) : DEFAULT_VOLUME;
}

export function setGlobalPlaybackVolume(value: number) {
  const volume = Math.max(0, Math.min(100, Math.round(value)));
  localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
  window.dispatchEvent(new CustomEvent<number>(VOLUME_EVENT, { detail: volume }));
}

export function createPlaybackNormalizer(audio: HTMLAudioElement): PlaybackNormalizer {
  let context: AudioContext | undefined;
  let outputGain: GainNode | undefined;
  let initialized = false;
  let unavailable = false;

  function applyVolume(percent: number) {
    const volume = percent / 100;
    if (outputGain) {
      audio.volume = 1;
      outputGain.gain.value = volume;
    } else {
      audio.volume = volume;
    }
  }

  applyVolume(getGlobalPlaybackVolume());
  window.addEventListener(VOLUME_EVENT, (event) => applyVolume((event as CustomEvent<number>).detail));

  async function activate() {
    if (unavailable) return;
    try {
      if (!initialized) {
        const Context = window.AudioContext
          ?? (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
        if (!Context) {
          unavailable = true;
          return;
        }

        context = new Context();
        const source = context.createMediaElementSource(audio);
        const preGain = context.createGain();
        const leveler = context.createDynamicsCompressor();
        const limiter = context.createDynamicsCompressor();
        outputGain = context.createGain();

        // Extra headroom gaat een zachte compressor in. Daardoor worden grote
        // volumeverschillen kleiner, terwijl een tweede trap pieken begrenst.
        preGain.gain.value = 4;
        leveler.threshold.value = -18;
        leveler.knee.value = 6;
        leveler.ratio.value = 4;
        leveler.attack.value = 0.005;
        leveler.release.value = 0.25;
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        outputGain.gain.value = getGlobalPlaybackVolume() / 100;

        source.connect(preGain).connect(leveler).connect(limiter).connect(outputGain).connect(context.destination);
        audio.volume = 1;
        initialized = true;
      }
      if (context?.state === "suspended") await context.resume();
    } catch {
      unavailable = true;
      await context?.close().catch(() => undefined);
      context = undefined;
      outputGain = undefined;
      applyVolume(getGlobalPlaybackVolume());
    }
  }

  return { activate };
}
