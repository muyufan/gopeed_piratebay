/**
 * Gopeed magnet resolver.
 *
 * Ported from the "magnet picker" part of play.py:
 *   - find the first magnet inside an <li> (an href wins over loose text)
 *   - otherwise fall back to the first magnet anywhere on the page
 *   - understand JSON responses: a magnet field, or an info hash that is
 *     turned into a standard magnet URI
 *   - resolve The Pirate Bay search pages through the public apibay API,
 *     because their rendered page contains no results
 *
 * The script is registered for every URL by the manifest, but it only touches
 * hosts listed in the "sites" setting. Everything else falls straight through
 * to Gopeed's normal resolver, so unrelated downloads behave exactly as before.
 *
 * Gopeed's JS runtime is goja: no browser DOM and no Node APIs. Only fetch,
 * URL, JSON, RegExp and the gopeed object are used here.
 */

var TPB_HOST_RE = /(^|\.)(thepiratebay\.org|apibay\.org)$/i;
var TPB_API = "https://apibay.org/q.php";
var MAGNET_RE = /magnet:\?[^\s"'<>]+/gi;
var LI_RE = /<li\b[\s\S]*?<\/li>/gi;
var HREF_MAGNET_RE = /href\s*=\s*["'](magnet:\?[^"']+)/gi;
var ENTITY_RE = /&(#(?:x[0-9a-fA-F]+|[0-9]+)|[a-zA-Z]+);/g;
var MAGNET_KEYS = ["magnet", "magnetUri", "magnet_uri", "magnetLink", "magnet_link"];
var HASH_KEYS = ["info_hash", "infoHash", "hash", "btih"];
var MAX_PAGE_BYTES = 8 * 1024 * 1024;

var DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// Domains that are inspected by default. Gopeed's manifest match patterns are
// static, so the extension is registered for *://*/* and filters by host here.
// Users can add or remove sites in the extension settings; "*" allows all.
var DEFAULT_SITES = [
    "thepiratebay.org", "apibay.org",
    "1337x.to", "1337x.st", "x1337x.ws", "1377x.to",
    "torrentgalaxy.to", "tgx.rs",
    "nyaa.si", "sukebei.nyaa.si",
    "btdig.com", "bt4g.org", "bt4gprx.com", "btsow.com",
    "limetorrents.lol", "limetorrents.info",
    "rutracker.org",
    "eztv.re", "eztvx.to",
    "magnetdl.com", "torlock.com", "bitsearch.to", "solidtorrents.to",
    "torrentfunk.com", "zooqle.com", "glodls.to", "ext.to",
    "yts.mx", "rarbg.to", "therarbg.com",
    "libgen.is", "libgen.rs", "libgen.st", "annas-archive.org",
    "fitgirl-repacks.site", "dodi-repacks.site"
].join(", ");

// ---------- extension plumbing ----------

function setting(name, fallback) {
    try {
        if (typeof gopeed !== "undefined" && gopeed && gopeed.settings) {
            var value = gopeed.settings[name];
            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }
    } catch (err) {
        // Settings are best-effort; the defaults keep the extension usable.
    }
    return fallback;
}

function log(level, message) {
    try {
        if (typeof gopeed !== "undefined" && gopeed && gopeed.logger &&
                typeof gopeed.logger[level] === "function") {
            gopeed.logger[level](message);
        }
    } catch (err) {
        // Logging must never break a resolve.
    }
}

function requestTimeoutMs() {
    var seconds = Number(setting("timeout", 25));
    if (!isFinite(seconds) || seconds <= 0) {
        seconds = 25;
    }
    return seconds * 1000;
}

// ---------- host allowlist ----------

function hostAllowed(host) {
    host = String(host || "").toLowerCase().replace(/\.$/, "");
    if (!host) {
        return false;
    }
    var entries = String(setting("sites", DEFAULT_SITES)).split(/[\s,;]+/);
    for (var i = 0; i < entries.length; i++) {
        var site = entries[i].trim().toLowerCase();
        if (!site) {
            continue;
        }
        // Tolerate URL-shaped entries such as "https://1337x.to/".
        site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
            .replace(/^www\./, "")
            .replace(/\/.*$/, "")
            .replace(/:\d+$/, "")
            .replace(/^\*\./, "");
        if (!site) {
            continue;
        }
        if (site === "*") {
            return true;
        }
        if (host === site || host.slice(-(site.length + 1)) === "." + site) {
            return true;
        }
    }
    return false;
}

// ---------- magnet extraction (mirrors play.py) ----------

var NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "
};

function unescapeHtml(text) {
    return String(text).replace(ENTITY_RE, function (match, entity) {
        if (entity.charAt(0) === "#") {
            var code;
            if (entity.charAt(1) === "x" || entity.charAt(1) === "X") {
                code = parseInt(entity.slice(2), 16);
            } else {
                code = parseInt(entity.slice(1), 10);
            }
            if (!isNaN(code) && code > 0 && code <= 0x10ffff) {
                try {
                    return String.fromCodePoint(code);
                } catch (err) {
                    return match;
                }
            }
            return match;
        }
        var named = NAMED_ENTITIES[entity.toLowerCase()];
        return named !== undefined ? named : match;
    });
}

function normalisePage(text) {
    // Some sites embed magnets in JavaScript strings ("\u0026amp;" or "\/"),
    // which would otherwise truncate the match at the backslash.
    return String(text)
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/");
}

function firstMatch(re, text) {
    re.lastIndex = 0;
    var match = re.exec(text);
    if (!match) {
        return "";
    }
    return match[1] !== undefined ? match[1] : match[0];
}

function findMagnet(page) {
    page = normalisePage(page);

    // The magnet lives in an <a href> inside the item, often several hundred
    // characters in, so search the whole <li> rather than its first line.
    var items = page.match(LI_RE) || [];
    for (var i = 0; i < items.length; i++) {
        var href = firstMatch(HREF_MAGNET_RE, items[i]);
        if (href) {
            return unescapeHtml(href);
        }
        var loose = firstMatch(MAGNET_RE, items[i]);
        if (loose) {
            return unescapeHtml(loose);
        }
    }

    // No <li> wrapper: take the first magnet anywhere on the page.
    var any = firstMatch(MAGNET_RE, page);
    return any ? unescapeHtml(any) : "";
}

function buildMagnet(infoHash, name) {
    var hash = String(infoHash === undefined || infoHash === null ? "" : infoHash).trim();
    if (!/^[0-9A-Fa-f]{40}$/.test(hash)) {
        return "";
    }
    var magnet = "magnet:?xt=urn:btih:" + hash;
    if (name) {
        magnet += "&dn=" + encodeURIComponent(String(name));
    }
    return magnet;
}

function isNoResult(node) {
    var hashes = [];
    for (var i = 0; i < HASH_KEYS.length; i++) {
        var value = node[HASH_KEYS[i]];
        if (typeof value === "string" && value.trim()) {
            hashes.push(value.trim());
        }
    }
    var id = node.id === undefined || node.id === null ? "" : String(node.id);
    var name = node.name === undefined || node.name === null ? "" : String(node.name);

    // apibay answers "no results" with id 0 and an all-zero info hash.
    for (var h = 0; h < hashes.length; h++) {
        if (/^0{40}$/.test(hashes[h])) {
            return true;
        }
    }
    if (id === "0" && /^no results/i.test(name)) {
        return true;
    }
    return false;
}

function findMagnetJson(body) {
    var text = String(body === undefined || body === null ? "" : body).trim();
    if (!text || (text.charAt(0) !== "[" && text.charAt(0) !== "{")) {
        return "";
    }
    var doc;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        return "";
    }

    function scan(node, depth) {
        if (depth > 4) {
            return "";
        }
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) {
                var fromArray = scan(node[i], depth + 1);
                if (fromArray) {
                    return fromArray;
                }
            }
            return "";
        }
        if (!node || typeof node !== "object") {
            return "";
        }

        for (var m = 0; m < MAGNET_KEYS.length; m++) {
            var magnetValue = node[MAGNET_KEYS[m]];
            if (typeof magnetValue === "string" &&
                    /^magnet:\?/i.test(magnetValue)) {
                return unescapeHtml(magnetValue);
            }
        }
        if (isNoResult(node)) {
            return "";
        }
        for (var h = 0; h < HASH_KEYS.length; h++) {
            var built = buildMagnet(node[HASH_KEYS[h]], node.name);
            if (built) {
                return built;
            }
        }

        // Objects that wrap the real results in a key such as "results".
        for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) {
                continue;
            }
            var child = node[key];
            if (child && typeof child === "object") {
                var fromChild = scan(child, depth + 1);
                if (fromChild) {
                    return fromChild;
                }
            }
        }
        return "";
    }

    return scan(doc, 0);
}

function findMagnetAny(body) {
    var text = String(body === undefined || body === null ? "" : body).trim();
    if (text.charAt(0) === "[" || text.charAt(0) === "{") {
        var fromJson = findMagnetJson(text);
        if (fromJson) {
            return fromJson;
        }
    }
    return findMagnet(text);
}

// ---------- HTTP ----------

function textualContentType(type) {
    if (!type) {
        return true;
    }
    return /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json)|image\/svg\+xml)/i
        .test(String(type).toLowerCase());
}

function fetchWithTimeout(url, options, timeoutMs) {
    if (!timeoutMs || typeof setTimeout !== "function" ||
            typeof AbortController !== "function") {
        return fetch(url, options);
    }
    var controller = new AbortController();
    var timer = setTimeout(function () {
        try {
            controller.abort();
        } catch (err) {
            // Aborting an already-finished request is harmless.
        }
    }, timeoutMs);

    var opts = {};
    for (var key in options) {
        if (Object.prototype.hasOwnProperty.call(options, key)) {
            opts[key] = options[key];
        }
    }
    opts.signal = controller.signal;

    return fetch(url, opts).then(function (response) {
        clearTimeout(timer);
        return response;
    }, function (error) {
        clearTimeout(timer);
        throw error;
    });
}

async function fetchText(url) {
    var headers = {
        "User-Agent": String(setting("userAgent", DEFAULT_UA)),
        "Accept": "text/html,application/json,text/plain,*/*"
    };
    var cookie = String(setting("cookie", ""));
    if (cookie) {
        headers.Cookie = cookie;
    }

    var response = await fetchWithTimeout(url, {
        headers: headers,
        redirect: "follow"
    }, requestTimeoutMs());

    if (!response) {
        throw new Error("no response");
    }
    if (typeof response.ok === "boolean" && !response.ok) {
        throw new Error("HTTP " + response.status);
    }

    var contentType = "";
    try {
        contentType = response.headers.get("content-type") || "";
    } catch (err) {
        contentType = "";
    }
    if (!textualContentType(contentType)) {
        // A direct media/archive download on an allowed host: leave it to
        // Gopeed instead of pulling megabytes into the JS runtime.
        return "";
    }

    var length = 0;
    try {
        length = Number(response.headers.get("content-length") || 0);
    } catch (err) {
        length = 0;
    }
    if (length && length > MAX_PAGE_BYTES) {
        throw new Error("page too large");
    }

    var text = await response.text();
    if (text.length > MAX_PAGE_BYTES) {
        text = text.slice(0, MAX_PAGE_BYTES);
    }
    return text;
}

function decodeComponent(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch (err) {
        return String(value);
    }
}

function queryParam(search, name) {
    var query = String(search || "").replace(/^\?/, "");
    if (!query) {
        return "";
    }
    var pairs = query.split("&");
    for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i];
        var eq = pair.indexOf("=");
        var rawKey = eq < 0 ? pair : pair.slice(0, eq);
        if (decodeComponent(rawKey) !== name) {
            continue;
        }
        return decodeComponent(eq < 0 ? "" : pair.slice(eq + 1));
    }
    return "";
}

// ---------- The Pirate Bay API ----------

async function tpbApiMagnet(url) {
    var parts;
    try {
        parts = new URL(url);
    } catch (err) {
        return "";
    }

    var host = String(parts.hostname || "").toLowerCase();
    if (!TPB_HOST_RE.test(host)) {
        return "";
    }

    var path = String(parts.pathname || "").toLowerCase();
    var isSearch = path.indexOf("search") >= 0;
    var isApi = path.indexOf("q.php") >= 0;
    if (!isSearch && !isApi) {
        return "";
    }

    var query = queryParam(parts.search, "q").trim();
    if (!query) {
        return "";
    }

    var api = TPB_API + "?q=" + encodeURIComponent(query);
    var category = queryParam(parts.search, "cat").trim();
    if (category) {
        api += "&cat=" + encodeURIComponent(category);
    }

    var body = await fetchText(api);
    return body ? findMagnetJson(body) : "";
}

async function findMagnetForUrl(url, parts) {
    var host = String(parts.hostname || "").toLowerCase();
    var path = String(parts.pathname || "").toLowerCase();
    var isTpb = TPB_HOST_RE.test(host);
    var isTpbSearch = isTpb && path.indexOf("search") >= 0;
    var isTpbApi = isTpb && path.indexOf("q.php") >= 0;

    // The rendered search page is a JavaScript shell with no results in its
    // markup, so ask the API first and avoid the doomed request.
    if (isTpbSearch || isTpbApi) {
        try {
            var apiMagnet = await tpbApiMagnet(url);
            if (apiMagnet) {
                return apiMagnet;
            }
        } catch (err) {
            log("debug", "apibay request failed: " + (err && err.message ? err.message : err));
        }
    }

    var pageError = null;
    try {
        var page = await fetchText(url);
        var pageMagnet = findMagnetAny(page);
        if (pageMagnet) {
            return pageMagnet;
        }
    } catch (err) {
        pageError = err;
    }

    if (pageError) {
        throw pageError;
    }
    return "";
}

// ---------- result ----------

function magnetName(magnet) {
    var text = String(magnet || "");
    var question = text.indexOf("?");
    var name = question < 0 ? "" : queryParam(text.slice(question + 1), "dn").trim();
    name = name.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (!name) {
        return "magnet";
    }
    return name.length > 120 ? name.slice(0, 120) : name;
}

async function onResolve(ctx) {
    var request = ctx && ctx.req;
    var url = request && (request.url || request.rawUrl);
    if (!url || !/^https?:\/\//i.test(String(url))) {
        return;
    }

    var parts;
    try {
        parts = new URL(String(url));
    } catch (err) {
        return;
    }

    var host = String(parts.hostname || "").toLowerCase();
    if (!hostAllowed(host)) {
        return;
    }

    // Let Gopeed handle .torrent files natively.
    if (/\.torrent$/i.test(String(parts.pathname || ""))) {
        return;
    }

    try {
        var magnet = await findMagnetForUrl(String(url), parts);
        if (!magnet) {
            log("warn", "no magnet found on " + url);
            return;
        }
        ctx.res = {
            // An empty resource name keeps this a single-file resource, which
            // Gopeed turns into one BT task using the file's magnet request.
            name: "",
            files: [{
                name: magnetName(magnet),
                size: 0,
                req: { url: magnet }
            }]
        };
        log("info", "magnet resolved from " + host);
    } catch (err) {
        log("warn", "magnet resolve failed for " + url + ": " +
            (err && err.message ? err.message : err));
    }
}

// ---------- registration ----------

if (typeof gopeed !== "undefined" && gopeed && gopeed.events &&
        typeof gopeed.events.onResolve === "function") {
    gopeed.events.onResolve(onResolve);
}

// Exported for the Node test harness only; goja has no CommonJS module.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        onResolve: onResolve,
        findMagnet: findMagnet,
        findMagnetJson: findMagnetJson,
        findMagnetAny: findMagnetAny,
        buildMagnet: buildMagnet,
        unescapeHtml: unescapeHtml,
        hostAllowed: hostAllowed,
        magnetName: magnetName,
        tpbApiMagnet: tpbApiMagnet
    };
}
