# 🌙 Arabio — v1.0.0

Arabic metadata addon for Nuvio and Stremio, powered by TMDB.

## What it adds
- **Catalogs:** 🌙 Ramadan series (the latest Ramadan, switches automatically), Arabic series, Arabic movies, newest Arabic movies, Egyptian series and movies, Gulf (Khaleeji) series, Levant (Syrian, Lebanese, Jordanian, Palestinian) series, Maghreb (Moroccan, Algerian, Tunisian, Libyan) series and movies, and Turkish series with Arabic titles. Every catalog has an Arabic genre filter.
- **Arabic search** for movies and series (Arabic or English names).
- **Arabic details:** titles, plots, cast, genres, runtime, trailers, Arabic logos when TMDB has one, and Arabic episode names. When TMDB has no Arabic plot, the English plot is used. The English title is shown on the first line of the description.
- **Works with Cinevo:** titles use IMDb ids, so streams from Cinevo (or any IMDb-based addon) appear when you open them. A few Arabic titles have no IMDb id on TMDB; they use a `tmdb:` id and won't have Cinevo streams.
- **Arabic details for everything:** Arabio also gives Arabic details for any movie or show (not only Arabic ones). Place Arabio above Cinemeta in Nuvio's addon order to use it. Set `ARABIC_META_FOR_ALL=false` to limit it to its own catalogs.

## Setup (Vercel, from GitHub)
1. Get a free TMDB key: create an account at themoviedb.org → Settings → API → request a key (Developer). Copy either the **API Key** or the **API Read Access Token**; both work.
2. Create a GitHub repo with `index.js`, `package.json`, `vercel.json` and this README.
3. In Vercel, import the repo, and add the environment variable `TMDB_API_KEY` with your key.
4. Deploy, then open `https://YOUR-PROJECT.vercel.app/health`. It should show `"tmdbKey":true` and `"region":"cdg1"`.
5. Install `https://YOUR-PROJECT.vercel.app/manifest.json` in Nuvio.

Optional: connect a free Upstash Redis database (Vercel → Storage) to keep TMDB answers cached between requests.

## Environment variables
| Name | Needed | Purpose |
|---|---|---|
| `TMDB_API_KEY` | yes | TMDB API key or read access token |
| `ARABIC_META_FOR_ALL` | no | `false` = Arabic details only for Arabio's own catalogs |
| Upstash Redis variables | no | added automatically when you connect the database |

No personal data or debrid keys are used. The install link is public and safe to share.
