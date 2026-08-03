type AudioContextConstructor = new () => AudioContext;

export type PlaybackNormalizer = {
  activate: () => Promise<void>;
  seek: (position: number) => void;
};

const VOLUME_STORAGE_KEY = "gezamenlijke-top-50-volume";
const VOLUME_EVENT = "gezamenlijke-top-50-volume-change";
const DEFAULT_VOLUME = 85;
const START_FADE_SECONDS = 0.06;
const SEEK_FADE_OUT_SECONDS = 0.012;
const SEEK_FADE_IN_SECONDS = 0.04;

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
  let startGain: GainNode | undefined;
  let outputGain: GainNode | undefined;
  let initialized = false;
  let unavailable = false;
  let seekGeneration = 0;
  let seekTimer: number | undefined;
  let seekRestoreTimer: number | undefined;

  function cancelPendingSeek() {
    seekGeneration += 1;
    window.clearTimeout(seekTimer);
    window.clearTimeout(seekRestoreTimer);
    seekTimer = undefined;
    seekRestoreTimer = undefined;
  }

  function fadeIn(seconds: number) {
    if (!context || !startGain) return;
    const now = context.currentTime;
    startGain.gain.cancelScheduledValues(now);
    startGain.gain.setValueAtTime(0, now);
    startGain.gain.linearRampToValueAtTime(1, now + seconds);
  }

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
    cancelPendingSeek();
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
        startGain = context.createGain();
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
        startGain.gain.value = 0;
        outputGain.gain.value = getGlobalPlaybackVolume() / 100;

        source.connect(preGain).connect(leveler).connect(limiter).connect(startGain).connect(outputGain).connect(context.destination);
        audio.volume = 1;
        initialized = true;
      }
      if (context?.state === "suspended") await context.resume();
      fadeIn(START_FADE_SECONDS);
    } catch {
      unavailable = true;
      await context?.close().catch(() => undefined);
      context = undefined;
      startGain = undefined;
      outputGain = undefined;
      applyVolume(getGlobalPlaybackVolume());
    }
  }

  function seek(position: number) {
    if (!Number.isFinite(position)) return;
    const target = Math.max(0, position);
    cancelPendingSeek();
    const generation = seekGeneration;

    if (!context || !startGain || audio.paused) {
      audio.currentTime = target;
      return;
    }

    const now = context.currentTime;
    if (typeof startGain.gain.cancelAndHoldAtTime === "function") {
      startGain.gain.cancelAndHoldAtTime(now);
    } else {
      startGain.gain.cancelScheduledValues(now);
      startGain.gain.setValueAtTime(1, now);
    }
    startGain.gain.linearRampToValueAtTime(0, now + SEEK_FADE_OUT_SECONDS);

    seekTimer = window.setTimeout(() => {
      if (generation !== seekGeneration) return;
      let restored = false;
      const restore = () => {
        if (restored || generation !== seekGeneration) return;
        restored = true;
        window.clearTimeout(seekRestoreTimer);
        audio.removeEventListener("seeked", restore);
        fadeIn(SEEK_FADE_IN_SECONDS);
      };
      audio.addEventListener("seeked", restore, { once: true });
      seekRestoreTimer = window.setTimeout(restore, 250);
      try {
        audio.currentTime = target;
      } catch {
        restore();
      }
    }, SEEK_FADE_OUT_SECONDS * 1000);
  }

  audio.addEventListener("pause", cancelPendingSeek);

  return { activate, seek };
}
