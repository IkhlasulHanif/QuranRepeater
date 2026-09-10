# Quran Repeater

A private, local Quran reader with Sheikh Yasser Al-Dosari recitation. It runs on your computer at **http://127.0.0.1:5173**. No hosting, sign-up, API keys, or cloud account is needed.

## Open the app

On this Mac, double-click **Start Quran Repeater.command**. It installs any missing app dependencies, builds the app, starts its local server, and opens your browser. On first launch, the full Yasser Al-Dosari recitation downloads automatically in the background. The setup banner shows progress; you can read immediately. Keep the Terminal window open while using it; press **Control+C** in that window to stop.

Or use a terminal in this folder:

```sh
npm run init  # first setup, build, and open the app

# On later visits, either run init again or:
npm start     # builds and starts the local app
```

Requires Node.js **22.12 or newer**. Open [the local reader](http://127.0.0.1:5173) after it starts. The server listens only on this computer (`127.0.0.1`), so it is not published or available to other devices on your network.

## Read and listen

- Choose **Page** for the 604-page Madani Mushaf mapping, or **Surah** for a complete chapter. Search for a surah in English, Arabic, or by number, or jump directly to a page.
- Press **Play**, or select any ayah number to start there. The current ayah is highlighted; **Follow the recitation** keeps it in view.
- Set **Repeat** to once, 2/3/5/10 times, or continuously. Repeats cover the complete selected page or surah, including pages containing multiple surahs. Starting from an ayah plays the remainder of that selection first, then repeats from the beginning.
- Adjust speed, volume, and the pause between completed repeats. Pause/resume and ayah seeking are supported. Changing the reading selection stops playback.
- Use the **A** buttons to resize Arabic text, switch the light/dark theme, and bookmark a selection. Your last selection and reading settings are restored in the same browser.

The page text reflows to fit the screen; it preserves the actual Mushaf page's ayah boundaries rather than reproducing its printed line breaks. The source includes the opening basmala within the first ayah of most surahs; it is not added twice. Ayah audio files may have a short pause between them.

## Offline use

The complete Quran and Arabic fonts are bundled. After the initial dependency installation, the app can be started and read **without internet**. Full offline listening is ready when the setup banner says **Your Quran is ready offline**.

On the first launch, the app **automatically downloads all 6,236 ayahs** by Yasser Al-Dosari. Keep the local server running and stay connected until the progress reaches 6,236 / 6,236. The text and fonts are already bundled, so you can read while the audio downloads. The complete recitation is approximately **1.5 GB**. The banner shows the actual storage used as it progresses; file lengths are checked against the bundled provider manifest.

Downloads run with a small number of concurrent requests and save each completed ayah to disk. Connection failures retry automatically. If you close the app or restart the computer, the next launch checks the saved files and continues from where it left off. **Pause download** pauses the full collection; an explicit pause is remembered until you choose **Resume download**. Currently downloading ayahs may finish after pausing. Missing or invalid files are downloaded again.

**Save audio offline** remains available to prioritize the page or surah you are reading. Played ayahs are also saved. Once all ayahs are downloaded, the full app can run without internet; later launches reuse the saved recordings.

Audio is stored in `.cache/audio/`, outside Git, and persists across browser restarts. To reclaim space, pause the full download, stop the app, and remove the desired MP3 files from that folder. Leave the full download paused if you do not want missing files downloaded again. Preferences and the bookmark are stored in your browser's local storage. Use the same address/browser to keep those preferences.

## Prayer times

An optional section links to [Awqaf UAE's official prayer times](https://www.awqaf.ae/prayer-times) while online. **Automatic reminders are not implemented**: the official service rejected direct local-app requests during verification. The app does not display calculated or stale times as Awqaf times. See [the integration research](research/awqaf.md).

## Sources

- Quran text: [Tanzil Project](https://tanzil.net), retrieved through [Al Quran Cloud](https://alquran.cloud). Copyright © 2007–2021 Tanzil Project, CC BY 3.0 with the requirement to preserve the text verbatim.
- Page, surah and juz boundaries: independently checked against Tanzil metadata.
- Audio: [EveryAyah's Yasser Ad-Dussary 128 kbps collection](https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/).
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

Browser tests use installed Chrome on macOS, or Chromium elsewhere. If needed, run `npx playwright install chromium`; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a browser executable. The browser suite tests page/surah boundaries, repeat behavior, real media decoding, offline reading/cache use, setup progress and pause/resume, desktop/mobile layout, and automated accessibility. The server suite also verifies first-run download, retry, restart recovery, and cache repair. Screen-reader usability still benefits from human testing.

To refresh from upstream intentionally, run `npm run import:quran` and review the data and provenance changes. The app never updates the sacred text automatically.
