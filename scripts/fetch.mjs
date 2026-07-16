#!/usr/bin/env node
/**
 * Reset Radar — fetcher.
 *
 * For each monitored X account, best-effort pulls recent posts (no paid API),
 * detects "reset / restored / rolled back" style announcements via keywords,
 * and merges newly detected events into data/events.json (deduped by id).
 *
 * Free X reading is inherently flaky (nitter mirrors die, syndication hydrates
 * client-side). So this is designed to DEGRADE GRACEFULLY: if every strategy
 * fails for an account, it simply adds nothing and the existing events.json —
 * the source of truth — is left untouched. events.json can also be hand-edited.
 *
 * Usage: node scripts/fetch.mjs [--dry]
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");
const DRY = process.argv.includes("--dry");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Nitter/xcancel-style RSS mirrors. Ordered by recent reliability; all optional.
const RSS_MIRRORS = [
  "https://nitter.net/{h}/rss",
  "https://xcancel.com/{h}/rss",
  "https://nitter.privacyredirect.com/{h}/rss",
  "https://nitter.poast.org/{h}/rss",
  "https://lightbrd.com/{h}/rss",
  "https://nitter.tiekoetter.com/{h}/rss",
];

async function timedFetch(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "user-agent": UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Parse a nitter RSS feed into [{text, url, date}]. */
function parseRss(xml, account) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const seg = b.split(/<\/item>/i)[0];
    const rawTitle = (seg.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const rawDesc = (seg.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "";
    const link = (seg.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "";
    const pub = (seg.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "";
    const text = decodeEntities(rawTitle || rawDesc);
    if (!text) continue;
    // Skip replies and retweets (nitter prefixes them) — announcements are top-level.
    if (/^R to @|^RT /.test(text)) continue;
    // Normalize the nitter link to a canonical x.com status URL when possible.
    let url = link.trim();
    const m = url.match(/status\/(\d+)/);
    if (m) url = `https://x.com/${account}/status/${m[1]}`;
    const d = pub ? new Date(pub) : null;
    items.push({
      text,
      url,
      date: d && !isNaN(d) ? d : null,
      statusId: m ? m[1] : null,
    });
  }
  return items;
}

/** Try each mirror until one returns a parseable feed with items. */
async function fetchViaRss(account) {
  for (const tpl of RSS_MIRRORS) {
    const url = tpl.replace("{h}", account);
    try {
      const res = await timedFetch(url, {}, 10000);
      if (!res.ok) continue;
      const xml = await res.text();
      if (!/<item>/i.test(xml)) continue;
      const items = parseRss(xml, account);
      if (items.length) {
        console.log(`  [rss] ${account}: ${items.length} posts via ${new URL(url).host}`);
        return items;
      }
    } catch (e) {
      // mirror down / timeout — try next
    }
  }
  return [];
}

/** Resolve a single status to clean {text,date} via the free vxtwitter API. */
async function resolveStatus(account, id) {
  try {
    const res = await timedFetch(
      `https://api.vxtwitter.com/${account}/status/${id}`,
      {},
      10000,
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.text) return null;
    return {
      text: decodeEntities(d.text),
      date: d.date_epoch ? new Date(d.date_epoch * 1000) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Discovery via the Jina reader (renders JS). Anonymous access is often
 * rate-limited; set JINA_API_KEY (free tier at jina.ai) for reliable reads.
 * Returns recent status IDs, then enriches each with authoritative text/date.
 */
async function fetchViaJina(account) {
  const key = process.env.JINA_API_KEY;
  const headers = { "x-return-format": "text" };
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await timedFetch(
      `https://r.jina.ai/https://x.com/${account}`,
      { headers },
      25000,
    );
    if (!res.ok) return [];
    const body = await res.text();
    const ids = [...new Set((body.match(/status\/(\d+)/g) || []).map((m) => m.split("/")[1]))];
    if (!ids.length) return [];
    // Enrich the newest handful to keep API calls bounded.
    const recent = ids.sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).slice(0, 15);
    const posts = [];
    for (const id of recent) {
      const s = await resolveStatus(account, id);
      if (s) posts.push({ ...s, url: `https://x.com/${account}/status/${id}`, statusId: id });
    }
    if (posts.length) console.log(`  [jina+vx] ${account}: ${posts.length} posts`);
    return posts;
  } catch {
    return [];
  }
}

/** Fallback: syndication __NEXT_DATA__ sometimes embeds recent tweets. */
async function fetchViaSyndication(account) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${account}`;
  try {
    const res = await timedFetch(url, {}, 12000);
    if (!res.ok) return [];
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];
    const json = JSON.parse(m[1]);
    const entries =
      json?.props?.pageProps?.timeline?.entries ||
      json?.props?.pageProps?.contextProvider?.timeline?.entries ||
      [];
    const items = [];
    for (const e of entries) {
      const t = e?.content?.tweet || e?.tweet;
      if (!t) continue;
      const text = t.full_text || t.text || "";
      if (!text) continue;
      const id = t.id_str || t.id;
      items.push({
        text: decodeEntities(text),
        url: id ? `https://x.com/${account}/status/${id}` : url,
        date: t.created_at ? new Date(t.created_at) : null,
        statusId: id ? String(id) : null,
      });
    }
    if (items.length) console.log(`  [syndication] ${account}: ${items.length} posts`);
    return items;
  } catch (e) {
    return [];
  }
}

async function fetchAccount(account) {
  const rss = await fetchViaRss(account);
  if (rss.length) return rss;
  const jina = await fetchViaJina(account);
  if (jina.length) return jina;
  const synd = await fetchViaSyndication(account);
  if (synd.length) return synd;
  console.log(`  [warn] ${account}: no source returned data`);
  return [];
}

// Bucket a timestamp into a calendar day at the configured timezone offset,
// so "today" matches the tracker owner's local calendar rather than UTC.
function ymd(d, offsetHours = 0) {
  const dt = d instanceof Date && !isNaN(d) ? d : new Date();
  return new Date(dt.getTime() + offsetHours * 3600000).toISOString().slice(0, 10);
}

function matchKeyword(text, keywords, excludePatterns = []) {
  // Negative guards first: skip questions / hypotheticals ("should we reset?").
  for (const rx of excludePatterns) {
    try { if (new RegExp(rx, "i").test(text)) return null; } catch {}
  }
  const low = text.toLowerCase();
  for (const k of keywords) if (low.includes(k.toLowerCase())) return k;
  return null;
}

function eventId(model, post, offset) {
  if (post.statusId) return `${model}-${post.statusId}`;
  // Stable-ish fallback id from date + text hash.
  let h = 0;
  const s = ymd(post.date, offset) + post.text;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${model}-${(h >>> 0).toString(36)}`;
}

async function main() {
  const config = JSON.parse(await readFile(join(DATA, "config.json"), "utf8"));
  let events = [];
  try {
    events = JSON.parse(await readFile(join(DATA, "events.json"), "utf8"));
  } catch {
    events = [];
  }
  const byId = new Map(events.map((e) => [e.id, e]));

  const nowIso = new Date().toISOString();
  const tzOffset = config.timezoneOffsetHours || 0;
  let added = 0;

  for (const [model, cfg] of Object.entries(config.models)) {
    console.log(`Fetching @${cfg.account} (${model})…`);
    const posts = await fetchAccount(cfg.account);
    for (const post of posts) {
      const kw = matchKeyword(post.text, config.resetKeywords, config.excludePatterns);
      if (!kw) continue;
      const id = eventId(model, post, tzOffset);
      if (byId.has(id)) continue;
      const ev = {
        id,
        model,
        date: ymd(post.date, tzOffset),
        text: post.text.slice(0, 400),
        url: post.url,
        account: cfg.account,
        detectedBy: `keyword: ${kw}`,
        addedAt: nowIso,
      };
      byId.set(id, ev);
      events.push(ev);
      added++;
      console.log(`  + [${model}] ${ev.date} "${ev.text.slice(0, 60)}…"`);
    }
  }

  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  console.log(`\nDone. ${added} new event(s), ${events.length} total.`);
  if (DRY) {
    console.log("(dry run — not writing)");
    return;
  }
  await writeFile(join(DATA, "events.json"), JSON.stringify(events, null, 2) + "\n");
}

main().catch((e) => {
  console.error("fetch failed:", e);
  process.exit(1);
});
