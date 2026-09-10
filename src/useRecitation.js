import { useCallback, useEffect, useRef, useState } from 'react';
import { audioUrl, nextPlayback } from './playback.mjs';

export function useRecitation(verses, { repeats, gap, speed, volume }) {
  const audioRef = useRef(null);
  const timer = useRef(null);
  const generation = useRef(0);
  const pending = useRef(null);
  const desiredPlay = useRef(false);
  const activeSource = useRef('');
  const position = useRef({ index: 0, round: 1 });
  const statusRef = useRef('idle');
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(1);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const settings = useRef({ verses, repeats, gap, speed, volume });
  settings.current = { verses, repeats, gap, speed, volume };
  const updateStatus = useCallback(value => { statusRef.current = value; setStatus(value); }, []);
  const cancel = useCallback(() => {
    generation.current += 1;
    desiredPlay.current = false;
    clearTimeout(timer.current);
    timer.current = null;
    audioRef.current?.pause();
  }, []);
  const stop = useCallback(() => {
    cancel();
    pending.current = null;
    activeSource.current = '';
    position.current = { index: 0, round: 1 };
    const audio = audioRef.current;
    if (audio) { audio.removeAttribute('src'); audio.load(); }
    setIndex(0); setRound(1); updateStatus('idle'); setError(''); setTime(0); setDuration(0);
  }, [cancel, updateStatus]);
  useEffect(() => { stop(); return cancel; }, [verses, stop, cancel]);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  const matchesSource = useCallback(audio => !!audio && audio === audioRef.current &&
    !!activeSource.current && audio.getAttribute('src') === activeSource.current &&
    (!audio.currentSrc || audio.currentSrc === audio.src), []);

  const finish = useCallback(() => {
    cancel(); pending.current = null; updateStatus('finished');
  }, [cancel, updateStatus]);

  // A repeat limit changed during a pause also applies to the already scheduled round.
  useEffect(() => {
    if (pending.current && repeats !== 'forever' && pending.current.round > Number(repeats)) finish();
  }, [repeats, finish]);

  const playAt = useCallback(async (target, nextRound = 1, resume = false) => {
    cancel(); pending.current = null;
    const token = generation.current;
    const audio = audioRef.current;
    const verse = settings.current.verses[target];
    if (!audio || !verse) { updateStatus('idle'); return; }
    const source = audioUrl(verse);
    const canResume = resume && activeSource.current === source && matchesSource(audio);
    position.current = { index: target, round: nextRound };
    activeSource.current = source;
    desiredPlay.current = true;
    setIndex(target); setRound(nextRound); setError(''); updateStatus('loading');
    if (!canResume) {
      setTime(0); setDuration(0);
      audio.src = source;
      audio.load();
    }
    audio.playbackRate = settings.current.speed;
    audio.volume = settings.current.volume;
    try {
      await audio.play();
      if (token === generation.current && desiredPlay.current && !pending.current && matchesSource(audio)) updateStatus('playing');
    } catch (err) {
      if (token !== generation.current || !desiredPlay.current) return;
      cancel(); updateStatus('error');
      setError('This ayah could not play. Connect to the internet to download it, then try again. Saved audio can play offline.');
    }
  }, [cancel, matchesSource, updateStatus]);

  function resumePending() {
    const next = pending.current;
    if (!next) return;
    if (settings.current.repeats !== 'forever' && next.round > Number(settings.current.repeats)) { finish(); return; }
    playAt(next.index, next.round);
  }

  function toggle() {
    if (desiredPlay.current) { cancel(); updateStatus('paused'); return; }
    if (pending.current) { resumePending(); return; }
    if (statusRef.current === 'finished') { playAt(0, 1); return; }
    if (statusRef.current === 'paused' && settings.current.repeats !== 'forever' &&
        position.current.round > Number(settings.current.repeats)) { finish(); return; }
    playAt(position.current.index, position.current.round, statusRef.current === 'paused');
  }
  function onEnded(event) {
    if (!desiredPlay.current || pending.current || !matchesSource(event.currentTarget)) return;
    const latest = settings.current;
    const next = nextPlayback(latest.verses.length, position.current.index, position.current.round, latest.repeats);
    if (!next) { finish(); return; }
    if (next.round > position.current.round && latest.gap > 0) {
      cancel(); desiredPlay.current = true;
      pending.current = next;
      updateStatus('gap');
      const token = generation.current;
      timer.current = setTimeout(() => {
        if (token === generation.current && desiredPlay.current) resumePending();
      }, latest.gap * 1000);
    } else playAt(next.index, next.round);
  }
  function move(delta) {
    const target = Math.max(0, Math.min(settings.current.verses.length - 1, position.current.index + delta));
    if (desiredPlay.current) playAt(target, position.current.round);
    else {
      cancel(); pending.current = null; activeSource.current = '';
      const nextRound = statusRef.current === 'finished' ? 1 : position.current.round;
      position.current = { index: target, round: nextRound };
      setIndex(target); setRound(nextRound); setTime(0); setDuration(0); setError(''); updateStatus('idle');
      const audio = audioRef.current;
      if (audio) { audio.removeAttribute('src'); audio.load(); }
    }
  }
  return {
    audioRef, index, round, status, error, time, duration, toggle, stop, move,
    playAt: target => playAt(target, 1),
    seek: value => { if (audioRef.current && Number.isFinite(audioRef.current.duration)) { audioRef.current.currentTime = value; setTime(value); } },
    audioProps: {
      onEnded,
      onTimeUpdate: event => { if (matchesSource(event.currentTarget)) setTime(event.currentTarget.currentTime); },
      onLoadedMetadata: event => {
        if (matchesSource(event.currentTarget)) setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
      },
      onWaiting: event => {
        if (desiredPlay.current && !pending.current && matchesSource(event.currentTarget) && statusRef.current === 'playing') updateStatus('loading');
      },
      onPlaying: event => {
        if (!desiredPlay.current || pending.current || !matchesSource(event.currentTarget)) { event.currentTarget.pause(); return; }
        updateStatus('playing');
      },
      onError: event => {
        if (desiredPlay.current && !pending.current && matchesSource(event.currentTarget)) {
          cancel(); updateStatus('error');
          setError('Audio is unavailable. Check your internet connection, or save this selection for offline listening.');
        }
      },
    },
  };
}
