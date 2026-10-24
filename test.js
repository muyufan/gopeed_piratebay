/*
 * Node test harness for the Gopeed extension.
 *
 * Gopeed runs this script in goja, not Node, so the harness stubs the small
 * part of the gopeed API the extension touches and uses Node's fetch/URL.
 * Run with: node test.js
 */

"use strict";

const assert = require("node:assert");
const http = require("node:http");

const HASH_A = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const HASH_B = "0123456789abcdef0123456789abcdef01234567";
const HASH_C = "1111111111111111111111111111111111111111";

let registeredHandler = null;
const gopeedSettings = {
    sites: "127.0.0.1, localhost, thepiratebay.org, apibay.org",
    userAgent: "gopeed-magnet-test/1.0",
    cookie: "",
    timeout: "5"
};

global.gopeed = {
    settings: gopeedSettings,
    logger: {
        debug() {},
        info() {},
        warn() {},
        error() {}
    },
    events: {
        onResolve(handler) {
            registeredHandler = handler;
        }
    }
};

// Intercept apibay so the TPB path is testable without network access.
const realFetch = global.fetch;
const fetchCalls = [];
global.fetch = function (url, options) {
    const text = String(url);
    fetchCalls.push(text);
    if (text.indexOf("https://apibay.org/q.php") === 0) {
        const query = new URL(text).searchParams.get("q") || "";
        return Promise.resolve(new Response(JSON.stringify([
            {
                id: "1",
                name: query + " 1080p WEB",
                info_hash: HASH_A,
                seeders: "12",
                leechers: "3"
            }
        ]), {
            status: 200,
            headers: { "content-type": "application/json" }
        }));
    }
    return realFetch(url, options);
};

const ext = require("./index.js");

// ---------- a tiny site to resolve against ----------

function page(body) {
    return "<!doctype html><html><body>" + body + "</body></html>";
}

const server = http.createServer((req, res) => {
    if (req.url === "/li") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        // The first item has a lot of text before its magnet, like a real
        // result row; the second must never be selected.
        res.end(page(
            "<ul>" +
            "<li><a href=\"/details/1\">first</a><span>" + "x".repeat(400) + "</span>" +
            "<a href=\"magnet:?xt=urn:btih:" + HASH_A + "&amp;dn=First%20Result\">magnet</a></li>" +
            "<li><a href=\"magnet:?xt=urn:btih:" + HASH_B + "&dn=Second\">magnet</a></li>" +
            "</ul>"
        ));
        return;
    }
    if (req.url === "/loose") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("<p>no list here: magnet:?xt=urn:btih:" + HASH_C + "&amp;dn=Loose</p>"));
        return;
    }
    if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            results: [{ info_hash: HASH_B.toUpperCase(), name: "JSON Result" }]
        }));
        return;
    }
    if (req.url === "/escaped") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("<a href=\"magnet:?xt=urn:btih:" + HASH_C +
            "\\u0026dn=Escaped%20Amp\">magnet</a>"));
        return;
    }
    if (req.url === "/binary") {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(Buffer.from("PK\u0003\u0004not html"));
        return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
});

async function resolveUrl(url) {
    const ctx = { req: { url: url } };
    await registeredHandler(ctx);
    return ctx.res;
}

async function run() {
    assert.ok(registeredHandler, "the extension registered onResolve");

    // ---------- pure helpers ----------
    assert.strictEqual(
        ext.buildMagnet(HASH_A, "Name With Spaces"),
        "magnet:?xt=urn:btih:" + HASH_A + "&dn=Name%20With%20Spaces"
    );
    assert.strictEqual(ext.buildMagnet("too-short", "x"), "");
    assert.strictEqual(
        ext.findMagnetJson("[{\"id\":\"0\",\"name\":\"No results returned\"," +
            "\"info_hash\":\"0000000000000000000000000000000000000000\"}]"),
        "",
        "apibay no-results rows are ignored"
    );
    assert.strictEqual(
        ext.findMagnet("<li>nothing</li>"),
        ""
    );

    // ---------- end-to-end resolves ----------

    const li = await resolveUrl("http://127.0.0.1:" + server.address().port + "/li");
    assert.ok(li, "HTML list page resolved");
    assert.strictEqual(li.name, "", "single-file resource stays flat");
    assert.strictEqual(li.files.length, 1);
    assert.strictEqual(
        li.files[0].req.url,
        "magnet:?xt=urn:btih:" + HASH_A + "&dn=First%20Result",
        "the first li magnet wins and &amp; is decoded"
    );
    assert.strictEqual(li.files[0].name, "First Result");

    const loose = await resolveUrl("http://127.0.0.1:" + server.address().port + "/loose");
    assert.ok(loose, "loose magnet resolved");
    assert.ok(loose.files[0].req.url.indexOf(HASH_C) > 0);

    const json = await resolveUrl("http://127.0.0.1:" + server.address().port + "/json");
    assert.ok(json, "JSON API resolved");
    assert.strictEqual(
        json.files[0].req.url,
        "magnet:?xt=urn:btih:" + HASH_B.toUpperCase() + "&dn=JSON%20Result"
    );

    const escaped = await resolveUrl("http://127.0.0.1:" + server.address().port + "/escaped");
    assert.ok(escaped, "escaped magnet resolved");
    assert.ok(
        escaped.files[0].req.url.indexOf("&dn=Escaped%20Amp") > 0,
        "\\u0026 is normalised before extraction"
    );

    const binary = await resolveUrl("http://127.0.0.1:" + server.address().port + "/binary");
    assert.strictEqual(binary, undefined, "binary downloads fall through to Gopeed");

    // TPB search: apibay is asked first, and its JSON becomes a magnet.
    const tpb = await resolveUrl("https://thepiratebay.org/search.php?q=South+Park+S27E05&cat=0");
    assert.ok(tpb, "TPB search resolved through apibay");
    assert.ok(tpb.files[0].req.url.indexOf("btih:" + HASH_A) > 0);
    assert.ok(tpb.files[0].req.url.indexOf("dn=South%20Park%20S27E05%201080p%20WEB") > 0);
    assert.ok(
        fetchCalls.some((url) => url.indexOf("apibay.org/q.php?q=South%20Park%20S27E05") > 0),
        "apibay got the search phrase; calls: " + fetchCalls.join(" | ")
    );

    const apibay = await resolveUrl("https://apibay.org/q.php?q=test");
    assert.ok(apibay, "direct apibay URL resolved");

    // A host outside the allowlist is not touched at all.
    const before = fetchCalls.length;
    const blocked = await resolveUrl("https://not-in-the-list.invalid/watch");
    assert.strictEqual(blocked, undefined, "unknown hosts are ignored");
    assert.strictEqual(fetchCalls.length, before, "unknown hosts cause no request");

    // Magnets and torrents must be left to Gopeed's own protocols.
    assert.strictEqual(
        await resolveUrl("magnet:?xt=urn:btih:" + HASH_A), undefined
    );
    assert.strictEqual(
        await resolveUrl("https://thepiratebay.org/file.torrent"), undefined
    );

    console.log("ok - all extension tests passed");
}

server.listen(0, "127.0.0.1", () => {
    run().then(() => {
        server.close();
    }, (error) => {
        console.error(error);
        server.close();
        process.exitCode = 1;
    });
});
