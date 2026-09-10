import { useCallback, useEffect, useRef, useState } from 'react';

// One media source covers the entire selection. Ayah changes update only the
// highlight; they never pause, seek, or reload the recording.
export function useContinuousRecitation(verses, { mode, selected, repeats, gap, speed, volume }) {
  const audioRef = useRef(null);
  const settings = useRef(null);
  settings.current = { verses, mode, selected, repeats, gap, speed, volume };
  const generation = useRef(0);
  const controller = useRef(null);
  const timer = useRef(null);
  const desiredPlay = useRef(false);
  const activeSource = useRef('');
  const metadata = useRef(null);
  const pendingSeek = useRef(null);
  const pendingRound = useRef(null);
  const position = useRef({ index: 0, round: 1 });
  const statusRef = useRef('idle');
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(1);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const updateStatus = useCallback(value => { statusRef.current = value; setStatus(value); }, []);
  const cancel = useCallback(() => {
    generation.current++;
    desiredPlay.current = false;
    controller.current?.abort();
    clearTimeout(timer.current);
    timer.current = null;
    audioRef.current?.pause();
  }, []);
  const stop = useCallback(() => {
    cancel();
    metadata.current = null; pendingSeek.current = null; pendingRound.current = null;
    activeSource.current = '';
    position.current = { index: 0, round: 1 };
    const audio = audioRef.current;
    if (audio) { audio.removeAttribute('src'); audio.load(); }
    setIndex(0); setRound(1); setTime(0); setDuration(0); setError(''); updateStatus('idle');
  }, [cancel, updateStatus]);
  useEffect(() => { stop(); return cancel; }, [verses, mode, selected, stop, cancel]);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);
  const matchesSource = useCallback(audio => !!audio && audio === audioRef.current &&
    !!activeSource.current && audio.getAttribute('src') === activeSource.current &&
    (!audio.currentSrc || audio.currentSrc === audio.src), []);

  const syncClock = useCallback(audio => {
    if (!matchesSource(audio) || !metadata.current) return;
    const clock = audio.currentTime;
    const markers = metadata.current.verses;
    let target = 0;
    for (let i = 1; i < markers.length && markers[i].start <= clock; i++) target = i;
    position.current.index = target;
    setIndex(target); setTime(clock);
  }, [matchesSource]);
  const finish = useCallback(() => {
    cancel(); pendingRound.current = null; updateStatus('finished');
  }, [cancel, updateStatus]);
  useEffect(() => {
    if (pendingRound.current && repeats !== 'forever' && pendingRound.current > Number(repeats)) finish();
  }, [repeats, finish]);

  const playAt = useCallback(async (target, nextRound = 1, resume = false) => {
    cancel(); pendingRound.current = null;
    const token = generation.current;
    const audio = audioRef.current;
    const latest = settings.current;
    if (!audio || !latest.verses[target]) return;
    desiredPlay.current = true;
    position.current = { index: target, round: nextRound };
    setIndex(target); setRound(nextRound); setError(''); updateStatus('loading');
    try {
      if (!metadata.current) {
        controller.current = new AbortController();
        const response = await fetch(`/api/continuous/selection/${latest.mode}/${latest.selected}`, { signal: controller.current.signal });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (token !== generation.current || !desiredPlay.current) return;
        if (!Array.isArray(result.verses) || result.verses.length !== latest.verses.length ||
            result.verses.some((v, i) => v.number !== latest.verses[i].number || !Number.isFinite(v.start) || v.start < 0) ||
            !result.audioUrl?.startsWith('/api/continuous/audio/')) throw new Error();
        metadata.current = result;
      }
      if (token !== generation.current || !desiredPlay.current) return;
      const source = metadata.current.audioUrl;
      const sameSource = activeSource.current === source && matchesSource(audio) && !audio.error;
      const targetTime = target === 0 ? 0 : metadata.current.verses[target].start;
      if (!(resume && sameSource)) {
        pendingSeek.current = targetTime;
        setTime(targetTime);
        if (!sameSource) {
          activeSource.current = source;
          setDuration(metadata.current.duration || 0);
          audio.src = source;
          audio.load();
        }
        if (audio.readyState >= 1) { audio.currentTime = targetTime; pendingSeek.current = null; }
      }
      audio.playbackRate = settings.current.speed;
      audio.volume = settings.current.volume;
      await audio.play();
      if (token === generation.current && desiredPlay.current && !pendingRound.current && matchesSource(audio)) updateStatus('playing');
    } catch {
      if (token !== generation.current || !desiredPlay.current) return;
      cancel(); updateStatus('error');
      setError('Continuous audio could not play. Connect to the internet to save this surah, or choose Individual ayah files to use your earlier downloads.');
    }
  }, [cancel, matchesSource, updateStatus]);

  function resumePending() {
    const nextRound = pendingRound.current;
    if (!nextRound) return;
    if (settings.current.repeats !== 'forever' && nextRound > Number(settings.current.repeats)) { finish(); return; }
    playAt(0, nextRound);
  }
  function toggle() {
    if (desiredPlay.current) { cancel(); updateStatus('paused'); return; }
    if (pendingRound.current) { resumePending(); return; }
    if (statusRef.current === 'finished') { playAt(0, 1); return; }
    if (statusRef.current === 'paused' && settings.current.repeats !== 'forever' && position.current.round > Number(settings.current.repeats)) { finish(); return; }
    playAt(position.current.index, position.current.round, statusRef.current === 'paused');
  }
  function onEnded(event) {
    if (!desiredPlay.current || pendingRound.current || !matchesSource(event.currentTarget)) return;
    syncClock(event.currentTarget);
    const latest = settings.current;
    if (latest.repeats !== 'forever' && position.current.round >= Number(latest.repeats)) { finish(); return; }
    const nextRound = position.current.round + 1;
    if (latest.gap > 0) {
      cancel(); desiredPlay.current = true; pendingRound.current = nextRound; updateStatus('gap');
      const token = generation.current;
      timer.current = setTimeout(() => { if (token === generation.current && desiredPlay.current) resumePending(); }, latest.gap * 1000);
    } else playAt(0, nextRound);
  }
  function move(delta) {
    const target = Math.max(0, Math.min(settings.current.verses.length - 1, position.current.index + delta));
    if (desiredPlay.current) playAt(target, position.current.round);
    else {
      cancel(); pendingRound.current = null;
      const nextRound = statusRef.current === 'finished' ? 1 : position.current.round;
      position.current = { index: target, round: nextRound };
      setIndex(target); setRound(nextRound); setError(''); updateStatus('idle');
      const targetTime = metadata.current?.verses[target]?.start || 0;
      setTime(targetTime);
      const audio = audioRef.current;
      // A recording can still be downloading after Pause. Preserve an ayah
      // jump until loadedmetadata arrives instead of accepting its old clock.
      pendingSeek.current = metadata.current ? targetTime : null;
      if (matchesSource(audio) && audio.readyState >= 1) {
        audio.currentTime = targetTime; pendingSeek.current = null;
      }
    }
  }
  return {
    audioRef, index, round, status, error, time, duration, toggle, stop, move,
    playAt: target => playAt(target, 1),
    seek: value => {
      const audio = audioRef.current;
      if (matchesSource(audio) && audio.readyState >= 1 && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.max(0, Math.min(value, audio.duration)); syncClock(audio);
      }
    },
    audioProps: {
      onEnded,
      onTimeUpdate: event => { if (pendingSeek.current === null) syncClock(event.currentTarget); },
      onLoadedMetadata: event => {
        const audio = event.currentTarget;
        if (!matchesSource(audio)) return;
        if (Number.isFinite(audio.duration)) setDuration(audio.duration);
        if (pendingSeek.current !== null) { audio.currentTime = pendingSeek.current; pendingSeek.current = null; }
        syncClock(audio);
      },
      onWaiting: event => { if (desiredPlay.current && !pendingRound.current && matchesSource(event.currentTarget) && statusRef.current === 'playing') updateStatus('loading'); },
      onPlaying: event => {
        if (!desiredPlay.current || pendingRound.current || !matchesSource(event.currentTarget)) { event.currentTarget.pause(); return; }
        updateStatus('playing');
      },
      onError: event => {
        if (desiredPlay.current && !pendingRound.current && matchesSource(event.currentTarget)) {
          cancel(); updateStatus('error');
          setError('Continuous audio is unavailable. Connect to save this surah, or choose Individual ayah files to listen to your earlier downloads.');
        }
      },
    },
  };
}
