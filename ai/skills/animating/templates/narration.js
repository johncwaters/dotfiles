const VOICE_LEAD_SECONDS = 0.15;
const VOICE_TAIL_SECONDS = 0.45;
const NARRATION_DRIFT_SECONDS = 0.12;
const VOLUME_STORAGE_KEY = "explainer-volume";

function narrationWindowSeconds(line) {
  return Math.max(line.to - line.from, VOICE_LEAD_SECONDS + line.voiceSeconds + VOICE_TAIL_SECONDS);
}

function voiceCue(lineIndex, voiceOffsetSeconds) {
  const line = SUBTITLES[lineIndex];
  return line.from + (VOICE_LEAD_SECONDS + voiceOffsetSeconds) / narrationWindowSeconds(line) * (line.to - line.from);
}

function currentCaption(line, storyTime) {
  const voiceElapsedSeconds = realTimeAt(storyTime) - realTimeAt(line.from) - VOICE_LEAD_SECONDS;
  return line.captions.findLast(caption => caption[0] <= voiceElapsedSeconds) ?? line.captions[0];
}

const narration = document.getElementById("narration");
const soundHint = document.getElementById("sound-hint");
const volumeSlider = document.getElementById("volume");
let isNarrationBlocked = false;

function readStoredVolume() {
  try {
    const storedVolume = localStorage.getItem(VOLUME_STORAGE_KEY);
    const hasStoredVolume = storedVolume !== null && Number.isFinite(Number(storedVolume));
    return hasStoredVolume ? Number(storedVolume) : Number(volumeSlider.value);
  } catch {
    return Number(volumeSlider.value);
  }
}

function applyVolume(volume) {
  narration.volume = Math.min(1, Math.max(0, volume));
  volumeSlider.value = String(narration.volume);
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(narration.volume));
  } catch {}
}

function isNarrationAudible() {
  return !narration.paused && !narration.seeking;
}

function syncNarration() {
  if (!isPlaying) {
    narration.pause();
    return;
  }
  if (Math.abs(narration.currentTime - currentTime) > NARRATION_DRIFT_SECONDS) narration.currentTime = currentTime;
  if (!narration.paused || isNarrationBlocked) return;
  narration.play().then(() => { soundHint.hidden = true; }).catch(() => {
    isNarrationBlocked = true;
    soundHint.hidden = false;
  });
}

function unblockNarration() {
  isNarrationBlocked = false;
  syncNarration();
}

function wireNarrationControls() {
  applyVolume(readStoredVolume());
  volumeSlider.addEventListener("input", () => applyVolume(Number(volumeSlider.value)));
  document.addEventListener("click", unblockNarration);
  document.addEventListener("keydown", unblockNarration);
}
