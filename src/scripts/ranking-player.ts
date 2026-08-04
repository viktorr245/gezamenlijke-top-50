import { formatDuration, type Track } from "../data/tracks";
import { createPlaybackNormalizer } from "./playback-normalization";

type RankingPlayerTrack = Track & {
  rank: number;
  selected: boolean;
};

type QueueMode = "top50" | "all";

type StoredPlayerState = {
  queueMode: QueueMode;
  trackId: string;
  position: number;
};

const PLAYER_STORAGE_KEY = "gezamenlijke-top-50-ranking-player";
const SEEK_SECONDS = 10;

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]!);
}

function finiteDuration(audio: HTMLAudioElement, fallback = 0): number {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Math.max(0, fallback);
}

function setText(selector: string, value: string) {
  document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    element.textContent = value;
  });
}

export function createRankingPlayer() {
  const root = document.querySelector<HTMLElement>("#ranking-player")!;
  const drawer = document.querySelector<HTMLElement>("#ranking-player-drawer")!;
  const audio = document.querySelector<HTMLAudioElement>("#ranking-audio")!;
  const seek = root.querySelector<HTMLInputElement>("[data-player-seek]")!;
  const toggle = root.querySelector<HTMLButtonElement>("[data-player-toggle]")!;
  const previous = root.querySelector<HTMLButtonElement>("[data-player-previous]")!;
  const next = root.querySelector<HTMLButtonElement>("[data-player-next]")!;
  const queueList = root.querySelector<HTMLOListElement>("#ranking-player-queue")!;
  const announcement = root.querySelector<HTMLElement>("[data-player-announcement]")!;
  const normalizer = createPlaybackNormalizer(audio);

  let allTracks: RankingPlayerTrack[] = [];
  let queue: RankingPlayerTrack[] = [];
  let queueMode: QueueMode = "top50";
  let currentIndex = -1;
  let sourceGeneration = 0;
  let pendingPosition: number | undefined;
  let restored = false;
  let expanded = false;
  let playerStatus = "Klaar om af te spelen";
  let lastStoredSecond = -1;

  function currentTrack(): RankingPlayerTrack | undefined {
    return queue[currentIndex];
  }

  function setMediaPlaybackState(state: MediaSessionPlaybackState) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // Sommige ingebouwde browsers tonen metadata, maar accepteren deze status niet.
    }
  }

  function updateMediaPosition() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const track = currentTrack();
    const duration = finiteDuration(audio, track?.duration);
    if (!track || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.max(0, Math.min(audio.currentTime || 0, duration)),
      });
    } catch {
      // Metadata en de overige knoppen blijven bruikbaar als position state ontbreekt.
    }
  }

  function updateMediaMetadata(track: RankingPlayerTrack) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const artwork = new URL(track.cover, window.location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album ?? `De gezamenlijke top ${queueMode === "top50" ? "50" : "100"}`,
      artwork: [{ src: artwork }],
    });
  }

  function saveState(force = false) {
    const track = currentTrack();
    if (!track) return;
    const position = Math.max(0, Number.isFinite(audio.currentTime) ? audio.currentTime : pendingPosition ?? 0);
    const second = Math.floor(position);
    if (!force && second === lastStoredSecond) return;
    lastStoredSecond = second;
    const state: StoredPlayerState = { queueMode, trackId: track.id, position };
    localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(state));
  }

  function updateTimeline() {
    const track = currentTrack();
    const duration = finiteDuration(audio, track?.duration);
    const position = Math.max(0, Math.min(audio.currentTime || pendingPosition || 0, duration || Number.POSITIVE_INFINITY));
    seek.max = String(duration || 0);
    seek.value = String(position);
    seek.style.setProperty("--player-progress", `${duration ? position / duration * 100 : 0}%`);
    seek.setAttribute("aria-valuetext", `${formatDuration(position)} van ${formatDuration(duration)}`);
    setText("[data-player-elapsed]", formatDuration(position));
    setText("[data-player-duration]", formatDuration(duration));
    updateMediaPosition();
    saveState();
  }

  function updateRowStates() {
    const track = currentTrack();
    const playing = Boolean(track && !audio.paused);
    document.querySelectorAll<HTMLElement>("[data-ranking-track-id]").forEach((row) => {
      const isCurrent = row.dataset.rankingTrackId === track?.id;
      row.classList.toggle("is-audio-current", isCurrent);
      row.classList.toggle("is-audio-playing", isCurrent && playing);
    });
    document.querySelectorAll<HTMLButtonElement>("[data-play-track-id]").forEach((button) => {
      const rankedTrack = allTracks.find((candidate) => candidate.id === button.dataset.playTrackId);
      const isCurrent = rankedTrack?.id === track?.id;
      const isPlaying = isCurrent && playing;
      button.setAttribute("aria-pressed", String(isPlaying));
      button.setAttribute("aria-label", isPlaying
        ? `Pauzeer ${rankedTrack?.title ?? "dit nummer"}`
        : `Speel ${rankedTrack?.title ?? "dit nummer"} vanaf plek ${rankedTrack?.rank ?? ""}`.trim());
      const icon = button.querySelector<HTMLElement>("i");
      if (icon) icon.className = `ph ph-${isPlaying ? "pause" : "play"}`;
    });
  }

  function updatePlaybackState() {
    const playing = !audio.paused && Boolean(currentTrack());
    toggle.setAttribute("aria-pressed", String(playing));
    toggle.setAttribute("aria-label", playing ? "Pauzeren" : "Afspelen");
    const icon = toggle.querySelector<HTMLElement>("i");
    if (icon) icon.className = `ph ph-${playing ? "pause" : "play"}`;
    previous.disabled = currentIndex <= 0;
    next.disabled = currentIndex < 0 || currentIndex >= queue.length - 1;
    setText("[data-player-status]", playerStatus);
    updateRowStates();
    setMediaPlaybackState(playing ? "playing" : currentTrack() ? "paused" : "none");
  }

  function scrollCurrentQueueItem() {
    if (!expanded) return;
    queueList.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView({ block: "nearest" });
  }

  function renderQueue() {
    queueList.innerHTML = queue.map((track, index) => `
      <li>
        <button type="button" data-player-queue-index="${index}" aria-current="${index === currentIndex ? "true" : "false"}">
          <span>${String(track.rank).padStart(2, "0")}</span>
          <img src="${escapeHtml(track.cover)}" alt="" width="46" height="46" />
          <span><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)}</small></span>
          ${index === currentIndex ? '<i class="ph ph-speaker-high" aria-hidden="true"></i>' : ""}
        </button>
      </li>`).join("");
    scrollCurrentQueueItem();
  }

  function renderCurrentTrack(announce = false) {
    const track = currentTrack();
    if (!track) return;
    root.hidden = false;
    document.querySelector(".app-shell")?.classList.add("has-ranking-player");
    root.querySelectorAll<HTMLImageElement>("[data-player-cover], [data-player-cover-large]").forEach((image) => {
      image.src = track.cover;
      image.alt = `Cover van ${track.title}`;
    });
    setText("[data-player-title], [data-player-title-large]", track.title);
    setText("[data-player-artist], [data-player-artist-large]", track.artist);
    setText("[data-player-position]", `${queueMode === "top50" ? "Top 50" : "Alle 100"} · ${currentIndex + 1} van ${queue.length}`);
    setText("[data-player-queue-label]", `${queueMode === "top50" ? "De top 50" : "De volledige ranglijst"} · plek ${track.rank}`);
    setText("[data-player-queue-count]", `${queue.length} nummers · ${Math.max(0, queue.length - currentIndex - 1)} hierna`);
    document.querySelectorAll<HTMLButtonElement>("[data-play-queue]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.playQueue === queueMode));
    });
    renderQueue();
    updateTimeline();
    updatePlaybackState();
    updateMediaMetadata(track);
    if (announce) announcement.textContent = `Nu speelt ${track.title} van ${track.artist}, plek ${track.rank}.`;
  }

  function setExpanded(nextExpanded: boolean) {
    expanded = nextExpanded;
    drawer.hidden = !expanded;
    root.classList.toggle("is-expanded", expanded);
    root.querySelectorAll<HTMLButtonElement>("[data-player-expand]").forEach((button) => {
      button.setAttribute("aria-expanded", String(expanded));
    });
    const icon = root.querySelector<HTMLElement>(".ranking-player-expand i");
    if (icon) icon.className = `ph ph-caret-${expanded ? "down" : "up"}`;
    if (expanded) requestAnimationFrame(scrollCurrentQueueItem);
  }

  function waitForMetadata(generation: number): Promise<void> {
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener("loadedmetadata", done);
        audio.removeEventListener("error", done);
        resolve();
      };
      const timeout = window.setTimeout(done, 4_000);
      audio.addEventListener("loadedmetadata", done, { once: true });
      audio.addEventListener("error", done, { once: true });
      if (generation !== sourceGeneration) done();
    });
  }

  async function selectTrack(index: number, autoplay: boolean, position = 0) {
    const track = queue[index];
    if (!track) return;
    const generation = ++sourceGeneration;
    audio.pause();
    currentIndex = index;
    pendingPosition = Math.max(0, position);
    lastStoredSecond = -1;
    playerStatus = autoplay ? "Laden…" : position > 0 ? "Klaar om verder te luisteren" : "Klaar om af te spelen";
    audio.src = `/api/audio/${encodeURIComponent(track.id)}`;
    audio.load();
    renderCurrentTrack(autoplay);

    const requestedPosition = pendingPosition;
    if (requestedPosition > 0) {
      await waitForMetadata(generation);
      if (generation !== sourceGeneration) return;
      normalizer.seek(Math.min(requestedPosition, finiteDuration(audio, track.duration)));
      pendingPosition = undefined;
      updateTimeline();
    }
    if (!autoplay) {
      saveState(true);
      return;
    }

    try {
      await normalizer.activate();
      if (generation !== sourceGeneration) return;
      await audio.play();
      if (generation !== sourceGeneration) return;
      playerStatus = "Speelt via deze telefoon";
      updatePlaybackState();
    } catch {
      if (generation !== sourceGeneration) return;
      playerStatus = "Afspelen lukte niet · probeer opnieuw";
      updatePlaybackState();
    }
  }

  async function playCurrent() {
    if (!currentTrack()) {
      await playQueue("top50");
      return;
    }
    try {
      await normalizer.activate();
      await audio.play();
      playerStatus = "Speelt via deze telefoon";
    } catch {
      playerStatus = "Afspelen lukte niet · probeer opnieuw";
    }
    updatePlaybackState();
  }

  function pause() {
    audio.pause();
    playerStatus = "Gepauzeerd";
    saveState(true);
    updatePlaybackState();
  }

  function seekTo(position: number) {
    const track = currentTrack();
    if (!track) return;
    const duration = finiteDuration(audio, track.duration);
    normalizer.seek(Math.max(0, Math.min(position, duration)));
    pendingPosition = undefined;
    updateTimeline();
    saveState(true);
  }

  function seekBy(offset: number) {
    seekTo((audio.currentTime || 0) + offset);
  }

  async function goTo(index: number, autoplay = true) {
    if (index < 0 || index >= queue.length) return;
    await selectTrack(index, autoplay);
  }

  async function goNext() {
    if (currentIndex >= queue.length - 1) {
      pause();
      playerStatus = "Einde van de afspeellijst";
      updatePlaybackState();
      return;
    }
    await goTo(currentIndex + 1);
  }

  async function goPrevious() {
    if (currentIndex <= 0) {
      seekTo(0);
      return;
    }
    await goTo(currentIndex - 1);
  }

  async function playQueue(mode: QueueMode) {
    if (allTracks.length === 0) return;
    queueMode = mode;
    queue = mode === "top50" ? allTracks.filter((track) => track.selected).slice(0, 50) : [...allTracks];
    await selectTrack(0, true);
  }

  async function playTrack(trackId: string) {
    if (currentTrack()?.id === trackId) {
      if (audio.paused) await playCurrent();
      else pause();
      return;
    }
    queueMode = "all";
    queue = [...allTracks];
    const index = queue.findIndex((track) => track.id === trackId);
    if (index >= 0) await selectTrack(index, true);
  }

  function closePlayer() {
    sourceGeneration += 1;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentIndex = -1;
    queue = [];
    pendingPosition = undefined;
    setExpanded(false);
    root.hidden = true;
    document.querySelector(".app-shell")?.classList.remove("has-ranking-player");
    localStorage.removeItem(PLAYER_STORAGE_KEY);
    updateRowStates();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      setMediaPlaybackState("none");
    }
  }

  function restoreState() {
    if (restored || allTracks.length === 0) return;
    restored = true;
    try {
      const parsed = JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY) ?? "null") as Partial<StoredPlayerState> | null;
      if (!parsed || (parsed.queueMode !== "top50" && parsed.queueMode !== "all") || typeof parsed.trackId !== "string") return;
      queueMode = parsed.queueMode;
      queue = queueMode === "top50" ? allTracks.filter((track) => track.selected).slice(0, 50) : [...allTracks];
      const index = queue.findIndex((track) => track.id === parsed.trackId);
      if (index < 0) return;
      void selectTrack(index, false, Number.isFinite(parsed.position) ? Math.max(0, Number(parsed.position)) : 0);
    } catch {
      localStorage.removeItem(PLAYER_STORAGE_KEY);
    }
  }

  document.querySelectorAll<HTMLButtonElement>("[data-play-queue]").forEach((button) => {
    button.addEventListener("click", () => void playQueue(button.dataset.playQueue === "all" ? "all" : "top50"));
  });
  document.querySelector("#ranking-list")?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-play-track-id]");
    if (button?.dataset.playTrackId) void playTrack(button.dataset.playTrackId);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-player-expand]").forEach((button) => {
    button.addEventListener("click", () => setExpanded(!expanded));
  });
  root.querySelector<HTMLButtonElement>("[data-player-collapse]")?.addEventListener("click", () => setExpanded(false));
  root.querySelector<HTMLButtonElement>("[data-player-close]")?.addEventListener("click", closePlayer);
  toggle.addEventListener("click", () => audio.paused ? void playCurrent() : pause());
  previous.addEventListener("click", () => void goPrevious());
  next.addEventListener("click", () => void goNext());
  root.querySelector<HTMLButtonElement>("[data-player-back]")?.addEventListener("click", () => seekBy(-SEEK_SECONDS));
  root.querySelector<HTMLButtonElement>("[data-player-forward]")?.addEventListener("click", () => seekBy(SEEK_SECONDS));
  seek.addEventListener("input", () => seekTo(Number(seek.value)));
  queueList.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-player-queue-index]");
    if (!button) return;
    void goTo(Number(button.dataset.playerQueueIndex));
  });

  audio.addEventListener("loadedmetadata", () => {
    updateTimeline();
  });
  audio.addEventListener("durationchange", updateTimeline);
  audio.addEventListener("timeupdate", updateTimeline);
  audio.addEventListener("play", () => {
    playerStatus = "Speelt via deze telefoon";
    updatePlaybackState();
  });
  audio.addEventListener("pause", () => {
    if (currentTrack() && !audio.ended && playerStatus !== "Laden…") playerStatus = "Gepauzeerd";
    updatePlaybackState();
  });
  audio.addEventListener("waiting", () => {
    if (!audio.paused) {
      playerStatus = "Even laden…";
      updatePlaybackState();
    }
  });
  audio.addEventListener("playing", () => {
    playerStatus = "Speelt via deze telefoon";
    updatePlaybackState();
  });
  audio.addEventListener("ended", () => void goNext());
  audio.addEventListener("error", () => {
    if (!currentTrack() || !audio.src) return;
    playerStatus = "Dit audiobestand kon niet worden afgespeeld";
    updatePlaybackState();
  });
  window.addEventListener("pagehide", () => saveState(true));

  if ("mediaSession" in navigator) {
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
      ["play", () => void playCurrent()],
      ["pause", pause],
      ["previoustrack", () => void goPrevious()],
      ["nexttrack", () => void goNext()],
      ["seekbackward", (details) => seekBy(-(details.seekOffset ?? SEEK_SECONDS))],
      ["seekforward", (details) => seekBy(details.seekOffset ?? SEEK_SECONDS)],
      ["seekto", (details) => {
        if (details.seekTime !== undefined) seekTo(details.seekTime);
      }],
    ];
    for (const [action, handler] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Niet alle acties worden door iedere browser of autoradio ondersteund.
      }
    }
  }

  return {
    setRanking(tracks: RankingPlayerTrack[]) {
      allTracks = [...tracks].sort((left, right) => left.rank - right.rank);
      restoreState();
    },
  };
}
