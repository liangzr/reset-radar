# Reset Radar

A static status board that tracks when **Claude**, **Codex** and **Grok** get
*reset* — usage limits reset, models rolled back, quality restored. Resets show
up as a GitHub-style contribution heatmap (one color per model, multi-color
cells for days more than one model reset) with a chronological signal log below.

**Live:** https://liangzr.github.io/reset-radar/

## How it works

- `data/events.json` is the source of truth — an array of detected reset events.
- `scripts/fetch.mjs` reads three X accounts, keyword-detects reset
  announcements, and merges any new ones into `events.json` (deduped by tweet).
- `.github/workflows/refresh.yml` runs the fetcher **hourly** and commits new
  events. GitHub Pages redeploys automatically on that commit.
- `index.html` / `styles.css` / `app.js` render the heatmap and log from the JSON.

| Model  | Channel                                      | Color   |
| ------ | -------------------------------------------- | ------- |
| Claude | [@ClaudeDevs](https://x.com/ClaudeDevs)      | clay    |
| Codex  | [@thsottiaux](https://x.com/thsottiaux)      | jade    |
| Grok   | [@SpaceXAI](https://x.com/SpaceXAI)          | azure   |

## Data reliability

Reading X for free is flaky (nitter mirrors die, syndication hydrates
client-side). The fetcher degrades gracefully: if every source fails for an
account it adds nothing and leaves the committed data untouched. Two ways to
make it reliable:

1. **Set `JINA_API_KEY`** (free tier at [jina.ai](https://jina.ai)) as a repo
   secret — the fetcher then discovers recent posts via the Jina reader and
   resolves each through the free vxtwitter API for clean text and dates.
2. **Hand-edit `data/events.json`** — add or correct entries directly. Each
   event is `{ id, model, date, text, url, account, detectedBy, addedAt }`.

## Configuration

`data/config.json` holds the monitored accounts, their colors, and the
`resetKeywords` used for detection. Edit it to tune what counts as a reset.

## Local development

```sh
python3 -m http.server 8899   # then open http://localhost:8899
node scripts/fetch.mjs --dry   # test fetch without writing
```
