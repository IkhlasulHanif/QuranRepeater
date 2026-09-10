import { useEffect, useRef, useState } from 'react';
import { CheckCircle, DownloadSimple, Pause, Play, ArrowsClockwise } from '@phosphor-icons/react';

function formatBytes(bytes) {
  if (bytes >= 1000 ** 3) return `${(bytes / 1000 ** 3).toFixed(2)} GB`;
  return `${Math.round(bytes / 1000 ** 2)} MB`;
}

export default function OfflineSetup({ onCacheChange }) {
  const [status, setStatus] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const changing = useRef(false);
  const revision = useRef(0);
  const lastRefresh = useRef(0);
  const actionController = useRef(null);

  useEffect(() => {
    let disposed = false;
    let timer;
    let controller;
    async function poll() {
      let delay = 2000;
      if (!changing.current) {
        controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const version = revision.current;
        try {
          const response = await fetch('/api/offline-status', { signal: controller.signal });
          if (!response.ok) throw new Error();
          const next = await response.json();
          if (!next.state || !Number.isFinite(next.total)) throw new Error();
          if (!disposed && version === revision.current) {
            setStatus(next); setUnavailable(false);
            if (Date.now() - lastRefresh.current > 10000 || next.state === 'complete') {
              lastRefresh.current = Date.now();
              onCacheChange?.();
            }
            delay = ['complete', 'paused', 'choice', 'on-demand'].includes(next.state) ? 15000 : 2000;
          }
        } catch {
          if (!disposed && version === revision.current) { setUnavailable(true); delay = 5000; }
        } finally { clearTimeout(timeout); }
      }
      if (!disposed) timer = setTimeout(poll, delay);
    }
    poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); actionController.current?.abort(); };
  }, [onCacheChange]);

  async function changeDownload(action) {
    if (changing.current) return;
    revision.current++; changing.current = true;
    setBusy(true); setActionError('');
    const controller = new AbortController(); actionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/offline-download/${action}`, { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error();
      setStatus(await response.json()); setUnavailable(false);
    } catch { if (!controller.signal.aborted) setActionError('Could not update the download. Please try again.'); else setActionError('The download server did not respond. Please try again.'); }
    finally { clearTimeout(timeout); changing.current = false; setBusy(false); }
  }

  const state = unavailable ? 'unavailable' : status?.state || 'starting';
  const titles = {
    starting: 'Checking your offline Quran',
    choice: 'Choose how to listen',
    'on-demand': 'Audio saved as needed',
    downloading: 'Preparing your offline Quran',
    paused: 'Offline download paused',
    waiting: 'Offline download will retry',
    complete: 'Your Quran is ready offline',
    unavailable: 'Download status unavailable',
  };
  const descriptions = {
    starting: 'Checking the recitations already saved on this computer.',
    choice: 'Quran text is already available offline. Download all recitations (about 1.5 GB), or save audio only as you listen. Your choice is remembered.',
    'on-demand': 'Only the ayahs you play or choose to save are downloaded. Unsaved audio needs internet. You can download everything later.',
    downloading: 'Downloading Yasser Al-Dosari’s complete recitation (about 1.5 GB). You can read now. Keep the app running until it finishes.',
    paused: 'Your saved ayahs are kept. Resume when you’re ready to download the rest.',
    waiting: status?.error || 'Check your internet connection. Completed ayahs are saved; the download will retry automatically.',
    complete: 'All 114 surahs are saved on this computer. Reading and listening now work without internet.',
    unavailable: 'Keep the local server running. This status will reconnect automatically.',
  };
  const complete = state === 'complete';
  const asNeeded = status?.preference === 'as-needed' || state === 'on-demand';
  const canPause = ['downloading', 'waiting'].includes(state) && status?.preference === 'all';
  const canResume = ['paused', 'waiting'].includes(state) && status?.preference === 'all';
  const canDownloadAll = ['choice', 'on-demand'].includes(state) || (complete && asNeeded);
  const canUseAsNeeded = state === 'choice' || (status?.preference === 'all' && !unavailable);
  return <section className={`offline-setup ${complete ? 'is-complete' : ''}`} aria-label="Offline setup">
    <span className="offline-setup-icon" aria-hidden="true">{complete ? <CheckCircle size={26}/> : <DownloadSimple size={25}/>}</span>
    <div className="offline-setup-content">
      <h2>{titles[state] || titles.starting}</h2>
      <p>{descriptions[state] || descriptions.starting}</p>
      <span className="sr-only" role="status">{titles[state] || titles.starting}</span>
      {status?.total > 0 && <div className="offline-setup-progress">
        {!['complete', 'choice', 'on-demand'].includes(state) && <progress value={status.completed} max={status.total} aria-label="Full recitation download"/>}
        <span>{status.completed.toLocaleString()} / {status.total.toLocaleString()} ayahs<span aria-hidden="true"> · </span>{formatBytes(status.bytes)}{status.totalBytes ? ` of ${formatBytes(status.totalBytes)}` : ''} saved</span>
      </div>}
      {complete && <p className="offline-preference">{asNeeded ? 'Preference: save audio as needed.' : 'Preference: keep the full recitation downloaded.'}</p>}
      {actionError && <p role="alert">{actionError}</p>}
    </div>
    {(canPause || canResume || canDownloadAll || canUseAsNeeded) && <div className="offline-setup-actions">
      {canDownloadAll && <button disabled={busy} onClick={() => changeDownload('resume')}><DownloadSimple size={15}/> Download all audio</button>}
      {canUseAsNeeded && <button disabled={busy} onClick={() => changeDownload('as-needed')}><Play size={15}/> Use as needed</button>}
      {canPause && <button disabled={busy} onClick={() => changeDownload('pause')}><Pause size={15}/> Pause download</button>}
      {canResume && <button disabled={busy} onClick={() => changeDownload('resume')}>{state === 'waiting' ? <ArrowsClockwise size={15}/> : <Play size={15}/>} {state === 'waiting' ? 'Retry download now' : 'Resume download'}</button>}
    </div>}
  </section>;
}
