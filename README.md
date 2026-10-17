# Alembic Door Kiosk

A full-screen page for a wall-mounted iPad.

- **Tickets mode** shows QR codes for **today's** events only, from 15 min before start to 15 min after. It switches on by itself.
- **Upcoming mode** is a swipeable flyer carousel, used whenever no door sales are open. It shows today's remaining events plus anything you add on the Manual tab (or future Momence events, if you turn that on; see Settings below).
- A **Tickets / Upcoming** toggle in the top bar lets anyone switch by hand; it falls back to automatic after 3 idle minutes.

```
Momence API ──(today's events, every 15 min)──> Apps Script ──> Google Sheet ──> JSON feed ──> kiosk page (GitHub Pages) ──> iPad
            token stays here                    you edit here                    public, no secrets
```

## Files

| File | Where it goes |
|---|---|
| `index.html`, `qrcode.js`, `config.js`, `sample-feed.json` | GitHub repo (GitHub Pages) |
| `apps-script/Code.gs` | Pasted into the Apps Script editor attached to the Google Sheet. A copy in the repo is harmless: it contains no token |

`qrcode.js` is Kazuhiko Arase's MIT-licensed QR encoder. Codes are drawn on the iPad itself: no QR service, no network call.

---

## 1. Google Sheet + Apps Script (≈10 min)

1. Create a new Google Sheet named **Door Kiosk**.
2. **Extensions → Apps Script**. Delete the starter code and paste all of `apps-script/Code.gs`. Save.
3. **Project Settings (gear) → Script Properties → Add**:
   - `MOMENCE_TOKEN` = your Momence API token (regenerate it first. The old one was shared in chat)
   - `MOMENCE_HOST_ID` = `71603` (optional; that is the default)
4. Back in the editor, select **setup** in the function dropdown → **Run** → approve the permissions prompt. This:
   - creates the **Settings**, **Events** and **Manual** tabs,
   - installs a 15-minute sync trigger,
   - runs the first sync. The Events tab should fill with today's in-person events (it may be empty on a day with none).
5. **Deploy → New deployment → type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the **Web app URL** (ends in `/exec`).
6. Open that URL in a browser; you should see JSON with `"events": [...]`.

> If "Anyone" isn't offered, your Workspace admin restricts public web apps. Either ask for it to be allowed, or do steps 1–5 under a personal Google account.

**Updating the script later:** after pasting new code, use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. That keeps the same URL.

## 2. GitHub Pages (≈5 min)

Repo: <https://github.com/olfactorypuma/AlembicQRKiosk>

1. On the repo page, click **uploading an existing file** (or **Add file → Upload files**). Unzip the package and drag in everything inside the `door-kiosk` folder: `index.html`, `qrcode.js`, `config.js`, `sample-feed.json`, `README.md`, and the `apps-script` folder. **Commit changes.**
2. **Settings → Pages → Source: Deploy from a branch → Branch: main, folder: / (root) → Save.** After a minute or two the page is live at `https://olfactorypuma.github.io/AlembicQRKiosk/`.
3. Once you have the Web app URL from step 1, open `config.js` on GitHub → pencil icon → paste the URL into `feedUrl` → **Commit changes**. The iPad picks it up on its next reload (or within a day via the 4 AM reload).

Free GitHub accounts require a public repo for Pages. That's fine: the page and the feed contain only public event info. The Momence token lives only in Script Properties.

Until `feedUrl` is set, the page shows built-in sample data and an amber "Sample data" note.

## 3. iPad (iPadOS 15)

1. Open the page in Safari → Share → **Add to Home Screen**. Launch it from the home-screen icon; it opens full-screen with no address bar.
2. **Settings → Display & Brightness → Auto-Lock → Never.**
3. **Settings → Accessibility → Guided Access → On.** Then:
   - set a passcode (write it down; forgetting it means resetting the iPad),
   - set **Display Auto-Lock → Never**.
4. Turn on **Do Not Disturb** so notifications don't cover the screen.
5. Open the kiosk app, triple-click the Home/Top button → **Start**.
6. Keep it plugged in. Test it overnight once: some older iOS versions were reported to sleep after ~10 min in Guided Access regardless of settings.

The page re-checks the feed every 5 minutes. It keeps working on the last data it received if Wi-Fi drops, and shows an amber "Offline" note in the top-right corner. It also reloads itself around 4 AM to pick up page updates, but only when the server is reachable.

---

## Day-to-day: what to edit in the Sheet

You never need to touch Momence data. The script refreshes it every 15 min (or **Door Kiosk → Sync from Momence now**). The kiosk picks up changes within ~5 min.

### Events tab: yellow columns are yours (kept between syncs)

| Column | Use |
|---|---|
| `show_qr` | blank = automatic (15 min before → 15 min after) · `no` = never show this event's code · `pin` = show it now, for the rest of its day |
| `header` | Replace the auto-shortened title |
| `caption` | Replace the small line under the title (default: the "with …" part of the title) |
| `doors_before_min` / `doors_after_min` | Per-event door window (e.g. 45 for a big workshop with a long line) |
| `flyer` | blank = automatic · `no` = leave out of carousel · `yes` = include even if far ahead |
| `flyer_image` | Image URL to use instead of the Momence banner (e.g. a portrait poster) |

### Manual tab: anything not in Momence

Tick `enabled`, choose `type`:
- `qr` adds a QR card (e.g. donations, newsletter sign-up) between `show_from` and `show_until` (both optional).
- `flyer` adds a carousel slide.

### Settings tab

Door-window defaults (15 / 15 min), how many codes fit on one screen (1–4; more rotate every 15 s), carousel timing, headings, room display names, and which Momence event types to skip.

`sync_days_ahead` is `0`, so only today's events are read from Momence. Setting it to e.g. `14` would put the next two weeks' events into the flyer carousel automatically; QR codes stay today-only either way.

If you ran `setup` before this version, the Settings tab keeps your old values. Change `doors_before_min`, `doors_after_min` and `sync_days_ahead` there by hand (15, 15, 0).

---

## How the edge cases are handled

| Situation (seen in the real API data) | Behavior |
|---|---|
| Several events with doors open at once (e.g. two 7 PM events on Oct 23) | Cards resize to fit; layout adapts to landscape/portrait; >4 rotate in pages with dot indicator |
| Hybrid events listed twice (in-person + online) | Online copies skipped |
| `type: private` events | Skipped (Settings → `exclude_types`) |
| Cancelled events | Skipped |
| No duration (e.g. 10/17 Chöd training) | No effect: the door window is based on start time, not duration |
| Titles up to 158 characters | Auto-shortened at a natural break; "with …" moves to the caption; `header` override available |
| `spotsRemaining = 0` | "Sold out" instead of a code (or a waitlist note if waitlist is on) |
| Recurring series share one banner | Carousel shows the next date once, plus "Also Oct 27, Nov 3…" (only if `sync_days_ahead` > 0) |
| Missing or broken image | Text-only slide |
| Online stream links/passwords in the API | Never copied to the Sheet or feed |
| Room "Mercury " with trailing space, "Lounge", "Berkeley Alembic" | Trimmed; "Lounge" → "Tea Lounge"; building-wide value hidden (Settings → `room_names`) |
| Times arrive in UTC; DST change on Nov 1 | Converted to Pacific; checked across the DST boundary |
| An event on another day is pinned, or starts just after midnight | Never shown as a QR code; codes are limited to today's date (Pacific) |

## Previewing any moment

Add `?now=` to the page URL to see what the kiosk would show at that time. With the live feed only today's events exist, so this is most useful for later today. Before `feedUrl` is set, the sample data covers Oct 16 – Dec 15, 2026:

```
https://olfactorypuma.github.io/AlembicQRKiosk/?now=2026-10-23T18:50
```
