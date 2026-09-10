# Quran Repeater

A private, local Quran reader with Sheikh Yasser Al-Dosari recitation. It runs on your computer at **http://127.0.0.1:5173**. No hosting, sign-up, API keys, or cloud account is needed.

## Open the app

On this Mac, double-click **Start Quran Repeater.command**. It installs any missing app dependencies, builds the app, starts its local server, and opens your browser. On first launch, choose **Download all audio** or **Use as needed** in the reader. No full recitation download begins before you choose. You can read immediately either way. Keep the Terminal window open while using it; press **Control+C** in that window to stop.

Or use a terminal in this folder:

```sh
npm run init  # first setup, build, and open the app

# On later visits, either run init again or:
npm start     # builds and starts the local app
```

Requires Node.js **22.12 or newer**. Open [the local reader](http://127.0.0.1:5173) after it starts. The server listens only on this computer (`127.0.0.1`), so it is not published or available to other devices on your network.

## Read and listen

- Choose **Page** for the 604-page Madani Mushaf mapping, or **Surah** for a complete chapter. Search for a surah in English, Arabic, or by number, or jump directly to a page.
- Press **Play**, or select any ayah number to start there. **Continuous recitation** plays each page as one recording from Yasser Al-Dosari’s uninterrupted surah audio. The current ayah is highlighted; **Follow the recitation** keeps it in view. Ayah transitions do not reload the player.
- Set **Repeat** to once, 2/3/5/10 times, or continuously. Repeats cover the complete selected page or surah, including pages containing multiple surahs. Starting from an ayah plays the remainder of that selection first, then repeats from the beginning.
- Adjust speed, volume, and the pause between completed repeats. Seek through the whole page or surah, or use the ayah buttons to jump. Changing the reading selection stops playback. **Audio format → Individual ayah files** keeps the earlier EveryAyah downloads usable; those separate clips may have audible gaps.
- Use the **A** buttons to resize Arabic text, switch the light/dark theme, and bookmark a selection. Your last selection and reading settings are restored in the same browser.

The page text reflows to fit the screen; it preserves the actual Mushaf page's ayah boundaries rather than reproducing its printed line breaks. The source includes the opening basmala within the first ayah of most surahs; it is not added twice. Continuous page audio preserves the original recording and its natural pauses within each surah. Page boundaries use the provider’s ayah timestamps matched to this app’s page mapping. Pages containing several surahs join those complete surah spans into one track. No silence removal or crossfading is applied.

## Offline use

The complete Quran and Arabic fonts are bundled. After the initial dependency installation, the app can be started and read **without internet**. Full offline listening is ready when the setup banner says **Your Quran is ready offline**.

On first launch, the setup banner gives you two choices:

- **Download all audio** in the default continuous format saves all 114 full-surah recordings by Yasser Al-Dosari (approximately **1.44 GB**). Keep the local server running and stay connected until progress reaches 114 / 114. The banner shows progress, and file lengths are checked against the bundled provider manifest.
- **Use as needed** saves the full surah when you first play or save one of its pages. A long surah can take a moment to download (Al-Baqara is about 116 MB); subsequent pages reuse it. Unsaved recitation needs internet; the complete Quran text and fonts already work offline.

Your choice is saved separately for each audio format and reused on later launches. You can change it in the setup banner at any time. Upgrading to continuous audio asks for a new download choice. Earlier ayah recordings are kept, and **Individual ayah files** still offers its original 6,236-file (~1.5 GB) download option. Downloading both formats uses additional storage.

Downloads run with a small number of concurrent requests and save each completed recording to disk. After you choose **Download all audio**, connection failures retry automatically. If you close the app or restart the computer, the next launch checks the saved files and continues from where it left off. **Pause download** pauses the full collection; an explicit pause is remembered until you choose **Resume download**. Choosing **Use as needed** stops future bulk downloads, including after a restart. Currently downloading recordings may finish after pausing or switching. Missing or invalid files are downloaded again only when full download is enabled or you request those recordings.

**Save audio offline** saves the full surah or surahs covering the page you are reading. Once all 114 continuous recordings are downloaded, any page can be generated and played without internet. Page tracks are prepared locally with FFmpeg and cached for later playback; the initial app setup installs FFmpeg automatically. Full-surah playback uses the original MP3.

Continuous recordings and generated pages are stored in `.cache/audio-continuous/`; earlier ayah recordings stay in `.cache/audio/`. These folders are outside Git and persist across browser restarts. To reclaim space, choose **Use as needed** for the relevant format, stop the app, and remove its cache files. Recordings download again only when played/saved or when full download is enabled. Download choices are stored in `.cache/continuous-offline-download.json` and `.cache/offline-download.json`. Reading preferences and the bookmark are stored in your browser's local storage. Use the same address/browser to keep those reading preferences.

## Prayer times

An optional section links to [Awqaf UAE's official prayer times](https://www.awqaf.ae/prayer-times) while online. **Automatic reminders are not implemented**: the official service rejected direct local-app requests during verification. The app does not display calculated or stale times as Awqaf times. See [the integration research](research/awqaf.md).

## Sources

- Quran text: [Tanzil Project](https://tanzil.net), retrieved through [Al Quran Cloud](https://alquran.cloud). Copyright © 2007–2021 Tanzil Project, CC BY 3.0 with the requirement to preserve the text verbatim.
- Page, surah and juz boundaries: independently checked against Tanzil metadata.
- Continuous audio and ayah timestamps: [MP3Quran](https://www.mp3quran.net/eng/api), Yasser Al-Dosari, read ID 92.
- Individual ayah audio: [EveryAyah's Yasser Ad-Dussary 128 kbps collection](https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/).
- Fonts: bundled Amiri and Amiri Quran, SIL Open Font License.

Full notices, source URLs, validation results, and retrieval hashes are in [public/data/SOURCES.md](public/data/SOURCES.md). Quran content is preserved verbatim; don't edit the text manually.

## Development and checks

```sh
npm run dev                    # local Vite development server
npm run build                  # production build
npm test                       # data, repeat boundaries, local server and cache tests
npm run test:e2e                # browser behavior and accessibility checks
node scripts/import-quran.mjs --check  # verify bundled data offline
```

Browser tests use installed Chrome on macOS, or Chromium elsewhere. If needed, run `npx playwright install chromium`; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a browser executable. The browser suite tests continuous page playback without ayah reloads, page/surah boundaries, repeat behavior, real media decoding, offline reading/cache use, startup download choices, progress and pause/resume, desktop/mobile layout, and automated accessibility. The server suite also verifies first-run opt-in, remembered choices, retry, restart recovery, and cache repair. Screen-reader usability still benefits from human testing.

To refresh from upstream intentionally, run `npm run import:quran` and review the data and provenance changes. The app never updates the sacred text automatically.
