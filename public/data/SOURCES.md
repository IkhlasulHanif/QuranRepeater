# Quran data and recitation sources

Last retrieved and checked: 10 September 2026.

## Arabic Quran and page boundaries

The complete Arabic Uthmani text and surah metadata are bundled in `quran.json`
for reading without an internet connection. The text is copied **verbatim** from
the `quran-uthmani` edition of [Al Quran Cloud](https://alquran.cloud/api):

- [Complete Quran endpoint](https://api.alquran.cloud/v1/quran/quran-uthmani)
- [Al Quran Cloud terms](https://alquran.cloud/terms-and-conditions)
- [Tanzil Project](https://tanzil.net)
- [Tanzil text license](https://tanzil.net/docs/text_license)
- [Tanzil metadata](https://tanzil.net/res/text/metadata/quran-data.js)

Al Quran Cloud acknowledges Tanzil and Quran Academy as text sources. This
project credits Tanzil for the Uthmani edition. Every one of the 604 page
boundaries and 30 juz boundaries has been independently compared with Tanzil's
metadata. Pages use the 604-page Madani mushaf convention; the reader reflows the
verses within a page instead of reproducing the printed line layout.

The source includes the unnumbered basmala in the text of the first ayah of each
surah except Al-Fatihah and At-Tawbah. In Al-Fatihah, the basmala itself is verse
1. The application must avoid displaying another duplicate basmala. The original
text strings, including diacritics, orthography, and the initial Unicode BOM, are
retained unchanged in the JSON.

The source copyright notice is also embedded in `quran.json`:

> Tanzil Quran Text
>
> Copyright (C) 2007-2021 Tanzil Project
>
> License: Creative Commons Attribution 3.0
>
> This copy of the Quran text is carefully produced, highly
> verified and continuously monitored by a group of specialists
> in Tanzil Project.
>
> TERMS OF USE:
>
> - Permission is granted to copy and distribute verbatim copies
>   of this text, but CHANGING IT IS NOT ALLOWED.
> - This Quran text can be used in any website or application,
>   provided that its source (Tanzil Project) is clearly indicated,
>   and a link is made to tanzil.net to enable users to keep
>   track of changes.
> - This copyright notice shall be included in all verbatim copies
>   of the text, and shall be reproduced appropriately in all files
>   derived from or containing substantial portion of this text.
>
> Please check updates at: http://tanzil.net/updates/

Tanzil's metadata is separately marked Copyright (C) 2008-2009 Tanzil.info,
Creative Commons Attribution 3.0.

## Sheikh Yasser Al-Dosari ayah clips

The individual ayah audio source is [EveryAyah](https://everyayah.com/), specifically its
[Yasser Ad-Dussary 128 kbps collection](https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/).
The alternative spelling is the provider's directory name for Sheikh Yasser
Al-Dosari. Filenames combine the three-digit surah and three-digit ayah numbers:
`001001.mp3` means Al-Fatihah 1:1; `114006.mp3` means An-Nas 114:6.

All 6,236 expected verse filenames were verified against the provider's
directory listing. Sample MP3 responses were checked for success, audio MIME
type, byte-range support, and cross-origin availability. Runtime availability
still depends on the provider and the network. On first launch, the app asks whether to download the complete recording collection
or save recordings as needed. Full downloads support pause and resume. Audio is saved in the local `.cache/audio/` folder,
which is excluded from Git; the recordings are not bundled in the repository.

Recordings remain the property of their respective rights holders. No new
license or ownership over them is claimed by this project.

## Continuous Sheikh Yasser Al-Dosari recitation

Continuous page and surah playback uses original full-surah recordings from
[MP3Quran's Yasser Al-Dosari collection](https://server11.mp3quran.net/yasser/).
Its [official timing API](https://www.mp3quran.net/eng/api) identifies this Hafs
an Asim reading as `read=92` and provides all 114 surahs:

- [Timed reading catalog](https://mp3quran.net/api/v3/ayat_timing/reads)
- [Example ayah timings for Al-Baqarah](https://mp3quran.net/api/v3/ayat_timing?surah=2&read=92)
- [MP3Quran source-use permission](https://www.mp3quran.net/eng/privacy)

The provider's Copyrights section permits visitors and developers to copy
materials and use links on its websites. This project credits MP3Quran and the
reciter, and claims no ownership over the recordings. Downloaded and generated
audio is stored locally under `.cache/` and is excluded from Git.

`continuous-audio.json` bundles timing metadata, source hashes, and exact audio
byte lengths, without bundling the recordings. MP3Quran expresses its source
timings in milliseconds; this file stores seconds. Each surah's `duration` is
the final ayah's end timestamp. `recordingDuration` includes the recording tail
and is measured from its MP3 Xing/VBRI frame count where available, or estimated
from constant-bitrate bytes and rounded up to a frame. The method is recorded
per surah. End-of-surah playback should preserve that tail or continue to EOF.

For a page, match its existing Quran ayahs to these timings by surah and ayah
number. Start at zero when the selection begins a surah, preserving any opening
basmala or introduction; otherwise start at the first selected ayah's timestamp.
An internal page ends at the next ayah's start. Play the original contiguous
recording between these boundaries, preserving its pauses within the page.
Pages spanning surahs have a separate contiguous segment for each surah.

The provider's SVG page assignments sometimes differ from the reader's checked
604-page Tanzil mapping. `source.pageDifferences` records each discrepancy;
the bundled ayah `page` always comes from `quran.json`. Timing gaps are recorded
in `source.timingGaps` and remain unedited. Neither discrepancy changes the
original Arabic text or its page assignment.

`source.durationOverruns` records source end markers extending less than one
second beyond the MP3's duration. These markers remain unchanged for provenance;
playback uses the file's natural EOF at a surah's end. The importer rejects
larger overruns instead of accepting a potentially mismatched recording.

The 10 September 2026 import contains 114 recordings totaling 1,440,093,508
bytes. All 6,236 ayah timings are present and ordered without overlap. It records
56 SVG page differences, one 20 ms gap after 80:37, and final timestamp overruns
of 187–424 ms in surahs 94, 105, 106, 107, and 111. These known source anomalies
are explicit in the bundled provenance rather than silently corrected.

Regenerate with `node scripts/import-continuous-audio.mjs`. The importer
verifies all 6,236 ayah numbers and their order, rejects overlapping or invalid
timings, compares 114 audio Content-Length headers to the provider directory,
and checks the final ayah against the recording duration using small byte-range
reads, recording small terminal differences as described above. It downloads
metadata and bounded MP3 samples, not the full collection.
Review recorded source differences whenever refreshing the metadata.

## Local Arabic fonts

`public/fonts/AmiriQuran.ttf` and `public/fonts/Amiri-Regular.ttf` are unmodified
files from the [official Amiri 1.003 release](https://github.com/aliftype/amiri/releases/tag/1.003).
[Amiri](https://github.com/aliftype/amiri) is by the Amiri Project Authors and is
distributed under the SIL Open Font License 1.1. The full license and copyright
notice are bundled in `public/fonts/OFL.txt`.

Amiri Quran is a Quran-specific Naskh font with Quranic annotation and diacritic
support. Fonts are served locally, so reading does not depend on Google Fonts
or any other remote font service.

SHA-256:

- `AmiriQuran.ttf`: `e2a47644762d16bdfb6d33e0d8db8c6ff30beae84150ef5a705316bbd829455c`
- `Amiri-Regular.ttf`: `cd2550c0f4c05eb341bf97958211aaa39382bca96577ba3a67d4a3b4912c43c0`

## Reproduce and validate

From the repository root with Node.js 20 or newer:

```sh
node scripts/import-quran.mjs
node scripts/import-quran.mjs --check
```

The import requires internet. It rejects incomplete corpora, missing pages,
misordered verse numbers, conflicting page/juz boundaries, or missing recitation
filenames. The offline check validates all surah and verse counts, all nonempty
page/juz groups, order, endpoints, and the stored Arabic-text checksum. Import
provenance and SHA-256 hashes are recorded inside `quran.json`.

## Audio download manifest

`audio-manifest.json` records the exact byte lengths listed by EveryAyah for
all 6,236 expected recordings: 1,495,802,496 bytes in total (approximately
1.5 GB). It includes retrieval time and a SHA-256 of the provider directory
listing. The downloader uses these lengths to detect incomplete files.
Refresh it deliberately with `node scripts/import-audio-manifest.mjs` and
review the result if the upstream recordings change.
