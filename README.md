# Gopeed Magnet Link Resolver

A Gopeed extension that turns a web page containing magnet links into a normal
BitTorrent task:

- the first magnet inside an `<li>` is used (an `<a href="magnet:...">` wins
  over loose text)
- if the page has no list items, the first magnet anywhere is used
- JSON responses are understood too: a magnet field, or an info hash that is
  converted into a standard magnet URI
- The Pirate Bay search pages are resolved through the public apibay API,
  because their rendered HTML contains no results
- `&amp;` / `&#...;` entities and escaped `\u0026` sequences are decoded

The extension only returns **one** magnet per page.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension metadata, `onResolve` registration, settings |
| `index.js` | The resolver (goja-compatible: `fetch`, `URL`, no DOM/Node APIs) |
| `test.js` | Node test harness with a local fixture site and a fake apibay |

## Install

### Local development mode (recommended)

1. Open Gopeed's **Extensions** page.
2. Click the install button **5 times in a row** to enable developer mode.
3. Click the button that selects an extension directory and choose
   `D:\code\python\gopeed-magnet-resolver`.
4. Create a task with a supported page URL.

### Through the local API

Only if Gopeed's API is enabled (Settings → API):

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:9999/api/v1/extensions `
  -ContentType "application/json" `
  -Body '{"url":"D:\\code\\python\\gopeed-magnet-resolver","devMode":true}'
```

## Usage

Paste a page address into **New Task** and press Resolve:

```text
https://thepiratebay.org/search.php?q=South+Park+S27E05
https://1337x.to/torrent/...
https://example.com/some-page-with-a-magnet-link
```

The resolve dialog shows one file backed by the extracted magnet. Creating the
task produces a `bt` task, not an HTTP download of the HTML page.

The extension cannot accept a bare search phrase: Gopeed only passes URLs to
`onResolve`. For a search, use a Pirate Bay search URL; the extension forwards
its `q` (and optional `cat`) to `https://apibay.org/q.php`.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| **Sites to inspect** | common magnet/torrent/indexer domains | Comma- or newline-separated. Subdomains match too. Use `*` to inspect every site. |
| **User-Agent** | Chrome 125 desktop | Sent with page and apibay requests |
| **Cookie** | empty | Optional `Cookie` header for sites that need a session |
| **Request timeout (seconds)** | `25` | Aborts a slow page/API request when the runtime supports timers |

### Why a site allowlist?

Gopeed match patterns are static, so the manifest registers `*://*/*` and the
script filters by host itself. Hosts outside the list are left completely
untouched: Gopeed's normal resolver runs with no extra request. If you set the
list to `*`, every new task will fetch its page once more before falling back to
a normal download, so prefer listing only the sites you actually use.

## Edge cases

- apibay's `{"id":"0","name":"No results returned",...}` rows are ignored
  instead of producing an all-zero info hash
- non-text responses (video, zip, etc.) are not read into the JS runtime

## Debugging

Gopeed writes extension logs to `storage/logs/extension.log` under its install
directory (for the portable build:
`D:\Program Files\Gopeed-v2.0.0-beta.3-windows-amd64-portable\storage\logs\extension.log`).

The script logs `magnet resolved from <host>`, `no magnet found on <url>`, and
request failures. `debug` lines only appear for developer-mode extensions.

## Test

```powershell
cd D:\code\python\gopeed-magnet-resolver
node test.js
```

Requires Node 18+ (uses the built-in `fetch`/`Response`). The test covers HTML
list items, loose magnets, JSON APIs, escaped entities, TPB/apibay, binary
fall-through, host filtering, and direct magnet/torrent pass-through.

## Publishing

This project is published at
<https://github.com/muyufan/gopeed_piratebay>. For remote installation/updates,
Gopeed reads the repository declared in `manifest.json`:

```json
"repository": {
  "url": "https://github.com/muyufan/gopeed_piratebay"
}
```

Install it in Gopeed with the git URL:

```text
https://github.com/muyufan/gopeed_piratebay
```

If the extension lives in a subdirectory, append `#subdirectory`.

