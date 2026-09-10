export function nextPlayback(length, index, round, repeats) {
  if (!Number.isInteger(length) || length < 1) return null;
  if (index < length - 1) return { index: index + 1, round };
  if (repeats === 'forever' || round < Number(repeats)) return { index: 0, round: round + 1 };
  return null;
}
export function audioKey(verse) {
  return String(verse.surah).padStart(3, '0') + String(verse.numberInSurah).padStart(3, '0');
}
export function audioUrl(verse) {
  return `/api/audio/${verse.surah}/${verse.numberInSurah}`;
}
export function selectVerses(data, mode, selected) {
  return data.ayahs.filter(verse => mode === 'page' ? verse.page === selected : verse.surah === selected);
}
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
