# Awqaf prayer-times investigation

Checked 2026-09-10 against the public [Awqaf website](https://www.awqaf.ae/prayer-times) and its shipped browser JavaScript.

## Official website API

Base: `https://mobileappapi.awqaf.gov.ae/APIS/`.

- `POST v3/sso/StartRequest?lang=en`, `Content-Type: application/json`, body `{}`. Website uses an anonymous guest session, returned as `{ isSuccess, clientAccessToken, clientRefreshToken, refreshTokenExpiryTime, errorCode, errorDescription }`.
- `GET v3/prayer-time/EmiratesAndCities?lang=en` returns `{ emirates, cities }`; authenticated using the guest bearer token. There are 60 enabled cities. Each city has `cityID`, `emirate`, `cityName`, `cityNameEn`, `latitude`, `longitude`, `enabled`. Dubai = city 32, emirate 2. Other principal cities: Abu Dhabi 1/1, Al Ain 2/1, Sharjah 33/3, Ajman 41/4, Um Al Quwain 44/5, Ras AlKhaimah 45/6, Fujairah 52/7; Hatta 60/2.
- `GET v3/prayer-time/prayertimes/{year}/{month}/{emirateID}/{cityID}` returns `{ downloadLink, azanSettings, prayerData }`. Example `2026/9/2/32` returned all 30 days of September for Dubai.
- `GET v3/prayer-time/prayertimes/{startYYYY-MM-DD}/{endYYYY-MM-DD}` is used by the website to obtain a range across all cities.

Each `prayerData` record contains `gDate` (`2026-09-10T00:00:00`), `fajr`, `shurooq`, `zuhr`, `asr`, `maghrib`, `isha` (full date/time strings **without a time-zone suffix**), `areaID`, `emirateID`, area names and Hijri date fields. Interpret these as UAE local time (`Asia/Dubai`, UTC+04:00), not the browser's time zone.

Verified official Dubai response for 2026-09-10: Fajr 04:45, Sunrise 06:00, Dhuhr 12:19, Asr 15:45, Maghrib 18:32, Isha 19:47. This is a verification fixture only; never use it as today's data on another date.

## External-client limitation

The data endpoint returned `Access-Control-Allow-Origin: *`; its preflight also allowed the Authorization header. But creation of the guest session only succeeded in the official website request context. A localhost Origin returned HTTP 400, error 1024 (`Invalid Client ID or Password..!`); a normal server request with no Origin also returned HTTP 400. Therefore a directly supported external integration has **not** been established. No private API credentials were obtained or saved in this repository.

The safe current product behavior is an optional Awqaf source link with an honest unavailable state; do not schedule guessed or stale reminders. If an authorized integration is provided later, keep credentials server-side, fetch only on user opt-in while online, verify exact UAE date and selected city, disable reminders offline, deduplicate notifications, and explain that the browser tab must stay open and the computer awake.

The endpoints were discovered in the official site's assets `index-BM2RTcCi.js` and `index-D3vaTBFe.js`, so they are implementation details rather than a documented stable public API.
