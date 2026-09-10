import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Headphones, Play, Pause, SkipBack, SkipForward, ArrowLeft, ArrowRight, Repeat, DownloadSimple, Check, MagnifyingGlass, Moon, Sun, X, List, BookmarkSimple, Info, SpeakerHigh } from '@phosphor-icons/react';
import { audioKey, audioUrl, formatTime, selectVerses } from './playback.mjs';
import { useRecitation } from './useRecitation.js';
import PrayerPanel from './PrayerPanel.jsx';
import OfflineSetup from './OfflineSetup.jsx';

function readSaved() { try { return JSON.parse(localStorage.getItem('quran-preferences')) || {}; } catch { return {}; } }
function normalizeSearch(value) {
  return value.toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^a-z0-9\u0621-\u064a]/g, '').replace(/([aeiou])\1+/g, '$1');
}
const initial = readSaved();
function IconButton({ label, children, ...props }) { return <button type="button" className="icon-button" title={label} aria-label={label} {...props}>{children}</button>; }
function ArabicNumber({ value }) { return <>{Number(value).toLocaleString('ar-EG')}</>; }

export default function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState(initial.mode === 'surah' ? 'surah' : 'page');
  const [page, setPage] = useState(Number.isInteger(initial.page) && initial.page >= 1 && initial.page <= 604 ? initial.page : 1);
  const [surah, setSurah] = useState(Number.isInteger(initial.surah) && initial.surah >= 1 && initial.surah <= 114 ? initial.surah : 1);
  const [pageInput, setPageInput] = useState(String(page));
  const [search, setSearch] = useState('');
  const [fontSize, setFontSize] = useState(Math.min(52, Math.max(28, Number(initial.fontSize) || 36)));
  const [theme, setTheme] = useState(initial.theme === 'dark' ? 'dark' : 'light');
  const [repeats, setRepeats] = useState(['1','2','3','5','10','forever'].includes(initial.repeats) ? initial.repeats : 'forever');
  const [speed, setSpeed] = useState([0.75,0.85,1,1.1,1.25,1.5].includes(initial.speed) ? initial.speed : 1);
  const [gap, setGap] = useState([0,1,3,5,10].includes(initial.gap) ? initial.gap : 0);
  const [volume, setVolume] = useState(0.8);
  const [follow, setFollow] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cached, setCached] = useState(new Set());
  const [saving, setSaving] = useState(null);
  const [notice, setNotice] = useState('');
  const [bookmark, setBookmark] = useState(() => { try { return JSON.parse(localStorage.getItem('quran-bookmark')); } catch { return null; } });
  const downloadController = useRef(null);
  const aboutDialog = useRef(null);
  const readerRef = useRef(null);
  const verses = useMemo(() => data ? selectVerses(data, mode, mode === 'page' ? page : surah) : [], [data, mode, page, surah]);
  const player = useRecitation(verses, { repeats, gap, speed, volume });
  const current = verses[player.index];
  const currentSurah = data?.surahs[(current?.surah || surah) - 1];
  const groups = useMemo(() => {
    const result = [];
    for (const verse of verses) {
      if (result.at(-1)?.surah !== verse.surah) result.push({ surah: verse.surah, verses: [] });
      result.at(-1).verses.push(verse);
    }
    return result;
  }, [verses]);
  const savedCount = verses.filter(v => cached.has(audioKey(v))).length;
  const isPlaying = ['playing', 'loading', 'gap'].includes(player.status);
  const unitLabel = mode === 'page' ? `Page ${page}` : data?.surahs[surah - 1]?.englishName || 'Surah';
  const activeSurah = verses.some(v => v.surah === surah) ? surah : verses[0]?.surah;
  const refreshCache = useCallback(() => {
    fetch('/api/audio-cache').then(r => r.json()).then(result => setCached(new Set(result.files || []))).catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    fetch('/data/quran.json', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(quran => { if (quran.ayahs?.length !== 6236 || quran.surahs?.length !== 114) throw new Error(); setData(quran); })
      .catch(err => { if (err.name !== 'AbortError') setLoadError('The local Quran file could not be loaded. Restart the app and try again.'); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('quran-preferences', JSON.stringify({ mode, page, surah, fontSize, theme, repeats, speed, gap })); } catch { /* Reading still works without storage. */ }
  }, [mode, page, surah, fontSize, theme, repeats, speed, gap]);
  useEffect(() => { setPageInput(String(page)); }, [page]);
  useEffect(() => {
    if (follow && player.status === 'playing' && current) {
      document.getElementById(`ayah-${current.number}`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [current?.number, player.status, follow]);
  useEffect(() => {
    fetch('/api/audio-cache').then(r => r.json()).then(result => setCached(new Set(result.files || []))).catch(() => {});
    return () => downloadController.current?.abort();
  }, []);
  useEffect(() => {
    if (player.status === 'playing' && current) {
      const key = audioKey(current);
      setCached(previous => previous.has(key) ? previous : new Set([...previous, key]));
    }
  }, [player.status, current?.number]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timeout);
  }, [notice]);

  function changeSelection(nextMode, number, preferredSurah) {
    player.stop(); setMode(nextMode); setNotice('');
    if (nextMode === 'page') { setPage(number); const first = data.ayahs.find(v => v.page === number); setSurah(preferredSurah || first.surah); }
    else { setSurah(number); setPage(data.ayahs.find(v => v.surah === number).page); }
    setMenuOpen(false);
    readerRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function switchMode(nextMode) { if (nextMode !== mode) changeSelection(nextMode, nextMode === 'page' ? page : surah); }
  function navigate(delta) {
    const max = mode === 'page' ? 604 : 114;
    changeSelection(mode, Math.max(1, Math.min(max, (mode === 'page' ? page : surah) + delta)));
  }
  function saveBookmark() {
    const value = { mode, page, surah, label: unitLabel };
    try { localStorage.setItem('quran-bookmark', JSON.stringify(value)); setBookmark(value); setNotice(`${unitLabel} bookmarked.`); }
    catch { setNotice('Your browser could not save the bookmark. Check its storage settings.'); }
  }
  async function downloadSelection() {
    if (saving) { downloadController.current?.abort(); return; }
    const selection = [...verses];
    const label = unitLabel;
    const controller = new AbortController(); downloadController.current = controller;
    setSaving({ done: 0, total: selection.length }); setNotice('');
    try {
      for (let i = 0; i < selection.length; i++) {
        const verse = selection[i];
        if (!cached.has(audioKey(verse))) {
          const response = await fetch(audioUrl(verse), { signal: controller.signal });
          if (!response.ok) throw new Error();
          await response.arrayBuffer();
          setCached(previous => new Set([...previous, audioKey(verse)]));
        }
        setSaving({ done: i + 1, total: selection.length });
      }
      setNotice(`${label} saved for offline listening.`);
    } catch (err) { setNotice(err.name === 'AbortError' ? 'Download stopped. Completed ayahs are still saved.' : 'Download interrupted. Check your connection and try again; saved ayahs are kept.'); }
    finally { setSaving(null); downloadController.current = null; }
  }

  if (!data) return <main className="boot"><BookOpen size={40} /><h1>Quran Repeater</h1>{loadError ? <><p role="alert">{loadError}</p><button onClick={() => setAttempt(v => v + 1)}>Try again</button></> : <p role="status">Opening your Quran…</p>}</main>;
  const numberQuery = /^\d+$/.test(search.trim()) ? Number(search.trim()) : null;
  const filteredSurahs = data.surahs.filter(s => numberQuery !== null ? s.number === numberQuery : normalizeSearch(`${s.number} ${s.name} ${s.englishName} ${s.englishNameTranslation}`).includes(normalizeSearch(search)));

  return <>
    <a className="skip-link" href="#quran-reader">Skip to Quran text</a>
    <header className="app-header">
      <div className="brand"><span className="brand-symbol"><BookOpen size={26} weight="light" /></span><div>Quran Repeater<span>A space to read & return</span></div></div>
      <div className="header-actions"><span className="local-label">On your device</span><IconButton label={theme === 'light' ? 'Use dark theme' : 'Use light theme'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={21} /> : <Sun size={21} />}</IconButton><IconButton label="About and sources" onClick={() => aboutDialog.current.showModal()}><Info size={21}/></IconButton><IconButton label={menuOpen ? 'Close surah list' : 'Open surah list'} className="icon-button mobile-menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={22}/> : <List size={22}/>}</IconButton></div>
    </header>
    <OfflineSetup onCacheChange={refreshCache}/>
    <div className="workspace">
      <aside className={`library ${menuOpen ? 'is-open' : ''}`} aria-label="Quran navigation">
        <div className="section-label"><BookOpen size={18}/> Your Quran</div>
        <div className="segmented" role="group" aria-label="Read and repeat by"><button aria-pressed={mode === 'surah'} onClick={() => switchMode('surah')}>Surah</button><button aria-pressed={mode === 'page'} onClick={() => switchMode('page')}>Page</button></div>
        <form className="page-jump" onSubmit={event => { event.preventDefault(); const n = Number(pageInput); if (Number.isInteger(n) && n >= 1 && n <= 604) changeSelection('page', n); }}><label htmlFor="page-number">Go to Mushaf page</label><div><input id="page-number" type="number" min="1" max="604" required value={pageInput} onChange={e => setPageInput(e.target.value)} /><span>of 604</span><button type="submit" aria-label="Go to page"><ArrowRight size={18}/></button></div></form>
        <div className="search-field"><MagnifyingGlass size={18}/><label className="sr-only" htmlFor="surah-search">Find a surah</label><input id="surah-search" type="search" placeholder="Find a surah" value={search} onChange={e => setSearch(e.target.value)}/></div>
        <nav className="surah-list" aria-label="Surahs">
          {filteredSurahs.map(s => <button key={s.number} className={`surah-item ${s.number === activeSurah ? 'selected' : ''}`} aria-current={s.number === activeSurah ? 'true' : undefined} onClick={() => changeSelection(mode, mode === 'surah' ? s.number : data.ayahs.find(v => v.surah === s.number).page, s.number)}><span className="surah-number">{String(s.number).padStart(2,'0')}</span><span className="surah-name">{s.englishName}<small>{s.numberOfAyahs} ayahs</small></span><span lang="ar" dir="rtl" className="surah-arabic">{s.name.replace('سُورَةُ ', '')}</span></button>)}
          {!filteredSurahs.length && <p className="empty-search">No surahs found. Try a name or number.</p>}
        </nav>
        {bookmark && <button className="bookmark-link" onClick={() => changeSelection(bookmark.mode, bookmark.mode === 'page' ? bookmark.page : bookmark.surah)}><BookmarkSimple size={18}/><span>Return to bookmark<small>{bookmark.label}</small></span><ArrowRight size={16}/></button>}
        <p className="library-note">114 surahs. 604 pages.<br/>Always here, even offline.</p>
      </aside>
      <main className="reading-column" id="quran-reader" tabIndex="-1" ref={readerRef}>
        <div className="reading-heading"><div><p className="eyebrow">READ AT YOUR OWN PACE</p><h1>{mode === 'page' ? `Page ${page}` : data.surahs[surah - 1].englishName}</h1><p>{mode === 'page' ? groups.map(g => data.surahs[g.surah - 1].englishName).join(' · ') : data.surahs[surah - 1].englishNameTranslation} <span className="muted-dot">·</span> Juz {verses[0].juz}</p></div><IconButton label="Bookmark this selection" onClick={saveBookmark}><BookmarkSimple size={23} weight={bookmark?.mode === mode && (mode === 'page' ? bookmark.page === page : bookmark.surah === surah) ? 'fill' : 'regular'}/></IconButton></div>
        <div className="reader-toolbar"><span>{verses.length} ayahs <span className="toolbar-extra">· Uthmani script</span></span><div className="font-controls"><IconButton label="Decrease Arabic text size" disabled={fontSize <= 28} onClick={() => setFontSize(n => n - 2)}><span className="small-a">A</span></IconButton><span className="sr-only" role="status">Arabic text size: {fontSize} pixels</span><IconButton label="Increase Arabic text size" disabled={fontSize >= 52} onClick={() => setFontSize(n => n + 2)}><span className="large-a">A</span></IconButton></div></div>
        <article className={`quran-paper ${page === 1 && mode === 'page' ? 'opening-page' : ''}`} style={{ '--arabic-size': `${fontSize}px` }} aria-label={`Quran text, ${unitLabel}`}>
          {groups.map(group => <section key={group.surah} className="surah-section" aria-label={data.surahs[group.surah - 1].englishName}>
            <div className="surah-title"><span className="surah-title-line"/><h2 lang="ar" dir="rtl">{data.surahs[group.surah - 1].name}</h2><span className="surah-title-line"/></div>
            {group.verses[0].numberInSurah > 1 && <p className="continued-label">Ayahs {group.verses[0].numberInSurah}–{group.verses.at(-1).numberInSurah}</p>}
            <div className="quran-text" dir="rtl" lang="ar">{group.verses.map(verse => <span id={`ayah-${verse.number}`} key={verse.number} className={`ayah ${current?.number === verse.number && player.status !== 'idle' ? 'current' : ''}`}><span>{verse.text}</span>{' '}<button type="button" className="ayah-marker" lang="en" aria-label={`Play ${data.surahs[verse.surah-1].englishName}, ayah ${verse.numberInSurah}`} aria-current={current?.number === verse.number && player.status !== 'idle' ? 'true' : undefined} onClick={() => player.playAt(verses.findIndex(v => v.number === verse.number))}><ArabicNumber value={verse.numberInSurah}/></button>{' '}</span>)}</div>
          </section>)}
          <div className="paper-footer"><span/>{mode === 'page' ? <span lang="ar"><ArabicNumber value={page}/></span> : <span>{verses.length} ayahs</span>}<span/></div>
        </article>
        <nav className="page-navigation" aria-label={mode === 'page' ? 'Page navigation' : 'Surah navigation'}><button disabled={(mode === 'page' ? page : surah) === 1} onClick={() => navigate(-1)}><ArrowLeft size={18}/> Previous {mode}</button><span>{mode === 'page' ? `${page} / 604` : `${surah} / 114`}</span><button disabled={(mode === 'page' ? page : surah) === (mode === 'page' ? 604 : 114)} onClick={() => navigate(1)}>Next {mode}<ArrowRight size={18}/></button></nav>
        <p className="reader-tip">Select an ayah number to listen from there.</p>
        <p className="source-credit">Quran text: <a href="https://tanzil.net" target="_blank" rel="noreferrer">Tanzil Project</a> via Al Quran Cloud</p>
      </main>
      <aside className="listening-column" aria-label="Listening settings">
        <section className="listen-panel"><div className="section-label"><Headphones size={19}/> Listen & repeat</div><h2>Stay with an ayah.<br/>Return to a page.</h2><p className="reciter-label">YOUR RECITER</p><div className="reciter"><span className="reciter-monogram" lang="ar">ي</span><div>Yasser Al-Dosari<small>Hafs ‘an ‘Asim</small></div></div>
          <div className="repeat-summary"><Repeat size={20}/><div>{mode === 'page' ? 'Repeating this page' : 'Repeating this surah'}<strong>{unitLabel}</strong></div></div>
          <label className="field" htmlFor="repeat-count">Repeat<select id="repeat-count" value={repeats} onChange={e => setRepeats(e.target.value)}><option value="1">Play once</option><option value="2">2 times</option><option value="3">3 times</option><option value="5">5 times</option><option value="10">10 times</option><option value="forever">Continuously</option></select></label>
          <div className="field-pair"><label className="field" htmlFor="playback-speed">Speed<select id="playback-speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[0.75,0.85,1,1.1,1.25,1.5].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><label className="field" htmlFor="repeat-gap">Repeat pause<select id="repeat-gap" value={gap} onChange={e => setGap(Number(e.target.value))}>{[0,1,3,5,10].map(n => <option key={n} value={n}>{n === 0 ? 'None' : `${n} sec`}</option>)}</select></label></div>
          <label className="checkbox-field"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/> Follow the recitation</label>
          <div className="offline-section"><button className="download-button" onClick={downloadSelection} disabled={!saving && savedCount === verses.length}>{saving ? <X size={18}/> : savedCount === verses.length ? <Check size={18}/> : <DownloadSimple size={18}/>}<span>{saving ? `Stop saving (${saving.done}/${saving.total})` : savedCount === verses.length ? 'Saved for offline' : 'Save audio offline'}</span></button><p>{saving ? 'Keep the app open while saving.' : `${savedCount} of ${verses.length} ayahs saved. Audio needs internet until saved.`}</p></div>
        </section>
        <PrayerPanel online={online}/>
        <div className="local-note"><BookOpen size={18}/><p>Your reading stays on this device. No account needed.</p></div>
      </aside>
    </div>
    <div className="feedback" role="status" aria-live="polite">{notice}</div>
    {player.error && <div className="audio-error" role="alert"><span>{player.error}</span><button onClick={player.toggle}>Try again</button></div>}
    <footer className="player" aria-label="Audio player">
      <div className="now-playing"><span className="audio-art"><Headphones size={25} weight="light"/></span><div><strong>{currentSurah?.englishName}<span> · Ayah {current?.numberInSurah}</span></strong><small>Yasser Al-Dosari</small></div></div>
      <div className="transport"><div className="transport-buttons"><IconButton label="Previous ayah" disabled={player.index === 0} onClick={() => player.move(-1)}><SkipBack size={21} weight="fill"/></IconButton><button className="play-button" aria-label={isPlaying ? 'Pause recitation' : 'Play recitation'} onClick={player.toggle}>{isPlaying ? <Pause size={23} weight="fill"/> : <Play size={23} weight="fill"/>}</button><IconButton label="Next ayah" disabled={player.index === verses.length - 1} onClick={() => player.move(1)}><SkipForward size={21} weight="fill"/></IconButton></div><div className="seek-row"><span>{formatTime(player.time)}</span><input type="range" min="0" max={Number.isFinite(player.duration) ? player.duration : 0} step="0.1" value={player.time} disabled={!player.duration} onChange={e => player.seek(Number(e.target.value))} aria-label="Seek within current ayah"/><span>{formatTime(player.duration)}</span></div></div>
      <div className="player-detail"><span className="playback-status" role="status">{player.status === 'loading' ? 'Loading audio…' : player.status === 'gap' ? `Pausing ${gap}s before repeat…` : player.status === 'finished' ? 'Selection complete' : `${unitLabel} · ${repeats === '1' ? 'Play once' : `Repeat ${player.round}${repeats === 'forever' ? '' : ` of ${repeats}`}`}`}</span><div className="volume-control"><SpeakerHigh size={17}/><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={e => setVolume(Number(e.target.value))}/><span>{speed}×</span></div></div>
      <audio ref={player.audioRef} {...player.audioProps} preload="none"/>
    </footer>
    <dialog ref={aboutDialog} className="about-dialog"><div className="dialog-title"><h2>Made for your daily reading</h2><IconButton label="Close about" onClick={() => aboutDialog.current.close()}><X size={21}/></IconButton></div><p>This app runs on your computer at localhost. The complete Quran text and Arabic fonts are included, so reading works without internet.</p><p>Recitation is by Sheikh Yasser Al-Dosari, supplied by <a href="https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/" target="_blank" rel="noreferrer">EveryAyah</a>. The complete recitation downloads automatically on first launch. The setup banner shows progress and lets you pause or resume. Saved ayahs play offline. A short pause may occur between ayah files.</p><p>The Uthmani Quran text is from the <a href="https://tanzil.net" target="_blank" rel="noreferrer">Tanzil Project</a>, via Al Quran Cloud, with the 604-page Madani Mushaf mapping. Pages reflow to fit your screen; the ayah boundaries stay the same.</p><p>Text is preserved exactly as supplied, including the opening basmala in the first ayah of surahs. Repeat counts apply to the full selected page or surah. A repeat pause happens between complete rounds.</p><p><a href="/data/SOURCES.md" target="_blank">Read source details and licenses</a></p><button className="primary-button" onClick={() => aboutDialog.current.close()}>Back to reading</button></dialog>
  </>;
}
