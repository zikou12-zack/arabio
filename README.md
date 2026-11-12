# 🎬 Cinevo — v1.13.0

**New in 1.13.0:** a new source, **🔍 Your TorBox**: anything already downloaded in your own TorBox library that matches the title (added by you, by Cinevo, or by another addon using your key) is listed first. It never holds up a search for more than 2.5 seconds. The debug page now shows the names searched (`namesSearched`).

**New in 1.12.0:** with `TMDB_API_KEY` set, Cinevo also accepts `tmdb:` ids: brand-new titles (often Arabic) that have no IMDb id yet, as listed by Arabio. Nuvio no longer shows "Playback unavailable" for them. If TMDB knows the IMDb id, every source is used; otherwise the name searches (Knaben, Zilean) look for it. Card titles no longer repeat "E03".

**New in 1.11.0 (Arabic content):**
- **Other names:** add `TMDB_API_KEY` (the same key as Arabio) and Cinevo also searches the other names a non-English title goes by ("Al Hayba", "El Hayba", "الهيبة"). Titles missing from Cinemeta get their name from TMDB. English titles are searched as before.
- **Arabic episode names:** "E05", "Ep.05", "Episode 5" and "الحلقة 5" are read as episodes (season 1 unless the name says otherwise), and the right file is picked inside Arabic season packs.
- **Arabic names match:** release names written in Arabic letters are matched to the title, and labeled 🇸🇦.

**New in 1.10.0:**
- **Paris region** (`cdg1` in vercel.json), closer to Morocco and to TorBox's European servers.
- **Edge caching:** Vercel keeps each result list for 10 minutes (`EDGE_CACHE_SECONDS`), so reopening an episode is instant. The copy is per install link and is never shared between people.
- **Shared cache (optional):** connect a free Upstash Redis database in Vercel (Storage → Upstash for Redis). Results, next-episode prefetches and "server is down" marks then survive between requests. Without it, Cinevo works as before.
- **Your own servers first:** put your own server first in `COMET_URL`, `ZILEAN_URL` or `STREMTHRU_URL` (comma-separated), followed by the public ones. If your server goes down, Cinevo skips it for 5 minutes and uses the public ones.
- StremThru no longer asks ElfHosted's server in TorBox mode (it always refused).

**New in 1.9.0:** StremThru is back on, using the ElfHosted and Midnight public servers (`stremthru.elfhosted.com`, `stremthrufortheweebs.midnightignite.me`). Each server is asked in TorBox mode (TorBox-cached releases; your key is sent to the StremThru server), P2P mode and Torznab at the same time. Set `DISABLE_STREMTHRU=true` to switch it off, or `STREMTHRU_URL` to choose servers.

**New in 1.8.1:** each card shows which sources found the release (🔍 Comet · Torrentio). "📸 Unknown" is hidden, and "TV Series" is trimmed from titles.

**New in 1.8.0:** Comet added as a source (comet.elfhosted.com, then comet.feels.legal). Comet checks TorBox itself and returns only cached releases. Its public servers work only through a debrid account, so your TorBox key is sent to Comet when it searches. Set `DISABLE_COMET=true` to switch it off, or `COMET_URL` to use your own Comet server.

**New in 1.7.1:** titles written in Russian or other scripts, or tracker-style titles ("Серии: 1-13 из 13"), now show the real show or movie name, and trailing dots are removed. StremThru is off by default because its public server returns 404; set `STREMTHRU_URL` to a server that still has it.

**New in 1.7.0:** renamed to **Cinevo** (Movies & TV · TorBox). Result cards read `1080p 🎬 Cinevo⚡`. The addon ID is unchanged.

## Earlier changes


**New in 1.6.1:** StremThru fixed. The public server returns HTTP 404 for its Torznab search, so StremThru is now also asked through its **Torz** addon in P2P mode (no debrid login; torrent hashes kept). Both routes run at the same time, and the debug page shows each one's result under `StremThru → instances`.


**New in 1.6.0:**
- **Zilean added** (Debrid Media Manager hashlists): releases other debrid users have downloaded and shared, so very often already cached. Asked by IMDb ID (exact) and by title (checked against title, year and episode) at the same time. Servers: MidnightIgnite, then ElfHosted (`ZILEAN_URL` to change).
- **No CAM, nothing under 720p:** these are dropped before the TorBox check, so they never appear and searches make fewer TorBox calls. Releases without a resolution tag are kept unless they are clearly SD (DVD, XviD, "SD"). `MIN_RESOLUTION=1080p` raises the floor; `480p` lowers it. CAM is always removed.
- **Next episode prepared in the background:** after an episode's list is sent, the next episode (or the next season's first episode) is searched and cached, so binge-watching and Nuvio's auto-play open it instantly. It uses Vercel's `waitUntil` (the new `@vercel/functions` dependency, installed automatically). `PREFETCH_NEXT=false` turns it off.
- **Dead mirrors skipped:** a Zilean, YTS or EZTV server that fails is skipped for 5 minutes instead of being retried on every search.
- The debug page now shows `droppedLowQuality`: how many CAM or below-720p releases were removed.

Note: `package.json` now has one dependency, so keep it in the repository. Vercel installs it on deploy.

**New in 1.5.0: "simple" formatting (the new default)**, in the compact style from r/Nuvio:
```
1080p 🐾 TorBox⚡
DAN DA DAN (2024) 🦋 S01🍂 E03
🗣️ 🇬🇧 . 🇫🇷 . 🇸🇦 . 🇪🇸 . 🇮🇹
📸 BluRay 🔆 10bit 🎵 AAC
📁 377 MB  🌱 9 seeders
```
- The title is written the way each release writes it, so similar releases are easy to tell apart.
- The 🗣️ line shows language flags, or "Dual Audio" / "Multi Audio". It is hidden when no language is detected.
- 🔆 shows Dolby Vision, HDR and 10-bit; 🎵 shows audio and channels; 📦 marks a season pack.
- To get the detailed v1.4 layout back, set `FORMAT_STYLE=rich` in Vercel.

**New in 1.4.0: rich formatting and smarter ranking**
- **Name column:** `⚡ TB 4K` plus a source badge (🔥 REMUX, 💎 BluRay, 🌐 WEB-DL, 📺 HDTV, 📹 CAM).
- **Details**, one topic per line:
  - 🎬 Show · S02E05 · episode title (from Cinemeta), or Movie · year
  - 📼 source · ✨ DV / HDR10+ / HDR10 / HLG · Extended / Remastered
  - 🎞️ codec (10-bit) · 🔊 audio (TrueHD, DTS-HD MA, DTS:X, DD+, Atmos) with channels
  - 🗣️ audio languages with flags (EN, FR, AR, ES, IT, DE, RU and 15 more) · Multi   💬 subtitles (VOSTFR, multi-subs)
  - 💾 size · 👥 seeders · 🏷️ release group
  - 📦 season pack · 📡 which sources found it
  - 📄 the full release name
- **Ranking:** resolution first. Within each resolution: REMUX > BluRay > WEB-DL > WEBRip > HDTV > DVD, then Dolby Vision/HDR, lossless audio, and single episodes before packs. Size and seeders break ties. CAM releases go to the bottom.

**New in 1.3.0:**
- **StremThru added:** a public Torznab search by IMDb ID (default instance `stremthru.13377001.xyz`, the same one Comet uses). For TV it searches the exact episode and the whole season (for packs) at the same time; other episodes are filtered out.
- **TorBox Search removed** from the default sources: it couldn't connect from Vercel. `ENABLE_TORBOXSEARCH=true` turns it back on. TorBox itself is still what checks the cache and plays your links.
- Default sources now: **Torrentio, StremThru, Knaben, YTS (movies), EZTV (TV)**. MediaFusion stays off unless you point it at your own instance.

**New in 1.2.1** (from real-world testing):
- **MediaFusion off by default.** All three public instances hide torrent hashes, so they can't contribute TorBox-cached results. It turns on again if you set `MEDIAFUSION_URL` to your own instance, or `ENABLE_MEDIAFUSION=true`.
- **TorBox Search diagnosis:** it retries once on a failed connection, and the debug page shows the real network reason (for example `ENOTFOUND` or a certificate error) instead of just "fetch failed".

**New in 1.2.0:**
- **MediaFusion reworked:** all three public instances (ElfHosted, Wizaardd's forthewizards.uk, MidnightIgnite) are asked at the same time. It uses MediaFusion's machine-readable `/kodi/stream` route first and falls back to the normal route.
- **Hidden hashes reported:** newer MediaFusion lets an instance hide torrent hashes (`HIDE_TORRENT_INFO_HASHES`). Without a hash, TorBox can't check a release, so those results can't be used. The debug page now says which instances do this.
- **Plain-language notes:** the debug page explains every source problem, such as a paid plan being needed, a blocked server, a site answering with a web page instead of data, or a timeout.

**New in 1.1.0:** MediaFusion added as a sixth source.


A Nuvio/Stremio addon for movies and TV. It lists **every TorBox-cached release** found by six sources, and adds a release to your TorBox account **only when you tap it**. It is built on the same engine as the AnimeTosho + TorBox addon (v3.0.14).

## Sources
| Source | Used for | How it finds releases |
|---|---|---|
| TorBox Search | movies + TV | By IMDb ID, cached results only (needs a paid TorBox plan; otherwise it pauses itself) |
| Torrentio | movies + TV | By IMDb ID, from the public Torrentio addon |
| MediaFusion | movies + TV | By IMDb ID, from all three public instances at once (ElfHosted, forthewizards.uk, MidnightIgnite). Its own database plus live scraping, with many multi-language releases. Answers are cached for 30 minutes to respect the public instances' fair-use rules |
| StremThru | movies + TV | By IMDb ID through StremThru's public Torznab endpoint (`STREMTHRU_URL` to change; comma-separated for several instances) |
| Zilean (DMM) | movies + TV | By IMDb ID and by title from Debrid Media Manager hashlists, which are often already cached |
| Knaben | movies + TV | Title search across many public trackers (1337x, The Pirate Bay and others), checked against the title, year and episode |
| YTS | movies | By IMDb ID (tries yts.mx, then yts.lt) |
| EZTV | TV | By IMDb ID, up to 10 pages (1,000 torrents) per show (tries eztvx.to, then eztv.wf) |

BitSearch was left out: Jackett removed it, and its domain now redirects to a site security scanners flag.

## How it works
1. All sources search at the same time for up to `DISCOVERY_BUDGET_MS` (8 s).
2. Every result is checked against TorBox's cache in batches of 50. Only cached releases are listed, with the right file chosen from TorBox's file list:
   - **Episodes:** `S02E05`, `2x05`, multi-episode `S02E04E05`, or a `Season 2/` folder with an `Episode 05` file. Season and full-series packs are listed when they contain the episode.
   - **Movies:** the main feature, never a sample or extra. In a collection, the file whose name matches the movie's title and year.
3. Results are sorted by quality (2160p first), then size. Each one shows size, seeders, source type (BluRay/WEB-DL/REMUX), HDR/DV, codec, audio and which sources found it.
4. Tapping a result makes three TorBox calls (add, read that torrent's files, get the link), then redirects the player. It never loads your whole TorBox list.
5. Results are kept for 10 minutes, so reopening is instant.

## Deploy (new Vercel project)
1. Create a new GitHub repository with these four files: `index.js`, `package.json`, `vercel.json`, `README.md`.
2. Import it in Vercel as a new project.
3. In Vercel → Settings → Environment Variables, add `CONFIG_SECRET` with a random value of **at least 32 characters**. It can be the same value as your anime addon's, or a different one.
4. Deploy, then open the site address, paste your TorBox API key and add the install link in Nuvio.
5. `/health` should report `1.0.0`.

## Optional settings (environment variables)
- `DISCOVERY_BUDGET_MS` (3000–14000, default 8000): how long sources may search.
- `DISABLE_TORRENTIO`, `DISABLE_STREMTHRU`, `DISABLE_KNABEN`, `DISABLE_YTS`, `DISABLE_EZTV` = `true`: turn a source off.
- `TORRENTIO_URL`: your own Torrentio configuration link, without `/manifest.json`, for example to pick its providers.
- `MEDIAFUSION_URL`: comma-separated list of instances to ask (replaces the three defaults); add `MEDIAFUSION_PASSWORD` for a private instance. `MEDIAFUSION_LIVE_SEARCH=false` makes it answer only from its database (faster, fewer results).
- `YTS_URL`, `EZTV_URL`: use a different mirror if the defaults stop working.
- `EZTV_MAX_PAGES` (1–30, default 10).

## Diagnostics
`https://<your-addon>/c/<your-token>/debug/series/tt0903747:2:5` (or `/debug/movie/tt15239678`) shows what each source found, how long it took, and how many results were cached. No links are shown. A failed tap is logged in Vercel as `play_failed` with the step that failed.

## Notes
- Torrentio sometimes blocks cloud servers such as Vercel. If the debug page shows `Torrentio: HTTP 403`, the other sources still work.
- Listing never adds anything to your TorBox account. Only tapping does.
