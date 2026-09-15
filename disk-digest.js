// disk-digest.js
// Usage: npm start  (or: node --env-file=.env disk-digest.js)
// Pass --dry-run to print the digest to stdout instead of posting to Slack.
// Pass --debug-fetch to print arXiv scrape diagnostics and exit (no credentials
// needed, nothing posted) — see debugFetch() below.

import { readFile, writeFile } from "node:fs/promises";
import OpenAI from "openai";

const DRY_RUN = process.argv.includes("--dry-run");
const DEBUG_FETCH = process.argv.includes("--debug-fetch");

// Papers already digested are recorded here (arXiv ID -> date first seen) so
// cross-listings and holiday backlogs don't produce duplicate posts.
const POSTED_IDS_FILE = new URL("./posted-ids.json", import.meta.url);
const POSTED_IDS_RETENTION_DAYS = 30;

// Model IDs served by Parley — swap here if the gateway renames them.
const RELEVANCE_MODEL = "bedrock/claude-haiku-4-5";
const SUMMARY_MODEL   = "bedrock/claude-sonnet-4-6";

// The research areas used to decide whether a paper makes the digest.
// Edit this description to tune the digest for your group.
const RESEARCH_TOPICS =
  "protoplanetary disks, planet formation, or the use of circumstellar disks " +
  "to characterize young stars (e.g. disk-based stellar masses, pre-main sequence evolution)";

// --debug-fetch only scrapes arXiv, so it deliberately runs without credentials
// — that keeps the diagnostic usable from any checkout, secrets or not.
const REQUIRED_ENV = ["PARLEY_API_KEY", "PARLEY_BASE_URL", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"];
const missing = DEBUG_FETCH ? [] : REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing environment variable(s): ${missing.join(", ")}`);
  console.error("   Copy .env.example to .env and fill in your credentials,");
  console.error("   then run with: node --env-file=.env disk-digest.js");
  process.exit(1);
}

// Constructed on first use rather than at import, so --debug-fetch never needs
// a Parley key just to reach the scrape.
let _client;
const claude = () => (_client ??= new OpenAI({
  apiKey: process.env.PARLEY_API_KEY,
  baseURL: process.env.PARLEY_BASE_URL,  // e.g. https://parley.mit.edu/v1
}));

// --- Helpers -----------------------------------------------------------------

async function withRetry(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function loadPostedIds() {
  let ids = {};
  try {
    ids = JSON.parse(await readFile(POSTED_IDS_FILE, "utf8"));
  } catch {
    // Missing or unreadable file — start fresh
  }
  const cutoff = new Date(Date.now() - POSTED_IDS_RETENTION_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(ids).filter(([, date]) => date >= cutoff));
}

async function savePostedIds(ids) {
  await writeFile(POSTED_IDS_FILE, JSON.stringify(ids, null, 2) + "\n");
}

// --- arXiv -------------------------------------------------------------------
// Scrape the daily new-listings page for today's papers. The listing already
// carries everything the digest needs — title, authors and the full abstract —
// so it is the single source of truth. Returns null if the page has not been
// updated for today yet (distinct from "no papers found").
//
// This deliberately avoids the export.arxiv.org metadata API. That call was a
// second, independent origin that could fail on its own, and from September
// 2026 it began returning non-XML error responses to GitHub Actions runners
// while the same request succeeded elsewhere — an IP-level block that stalled
// the digest for days. One origin, one failure mode.
//
// arxiv.org has still been observed to briefly serve an empty listing on an
// otherwise-valid request (a transient cache/origin blip, not a real
// zero-paper day — weekdays reliably have 70+ new astro-ph submissions), so we
// identify ourselves with a UA per https://arxiv.org/help/robots and retry a
// few times before trusting a 0.

const ARXIV_LISTING_URL = "https://arxiv.org/list/astro-ph/new";
const FETCH_HEADERS = { "User-Agent": "disk-digest/1.0 (contact: rteague@mit.edu)" };
const SUSPICIOUS_ZERO_RETRY_ATTEMPTS = 3;
const SUSPICIOUS_ZERO_RETRY_DELAY_MS = 15_000;

// fetch() resolves rather than throws on 4xx/5xx, so an error page would
// otherwise flow on as "valid HTML that happens to contain no papers" and be
// indistinguishable from a quiet day. Throw instead, with enough of the body
// to identify a block or challenge page in the CI log.
async function fetchOk(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${new URL(url).host} — ${body}`);
  }
  return res;
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Each listing entry is a <dt> (the arXiv ID and download links) paired with a
// <dd> (title, authors, subjects, abstract). Parsing the pairs — rather than
// regexing IDs out of the whole page — also drops stray arXiv IDs that appear
// as citations inside other papers' abstracts.
function parseListingEntries(sectionHtml) {
  const items = [...sectionHtml.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)];
  const papers = [];
  for (const [, dt, dd] of items) {
    const arxivId = dt.match(/arXiv:(\d{4}\.\d{4,5})/)?.[1];
    if (!arxivId) continue;

    const title = stripTags(dd.match(/class=['"]list-title[^'"]*['"][^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "")
      .replace(/^Title:\s*/, "");
    const authorsHtml = dd.match(/class=['"]list-authors['"][^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const authors = [...authorsHtml.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map(m => stripTags(m[1]));
    const abstract = stripTags(dd.match(/<p class=['"]mathjax['"]>([\s\S]*?)<\/p>/)?.[1] ?? "");

    // A malformed entry is skipped rather than aborting the whole digest, but
    // it is logged so a silent page-layout change cannot erode coverage.
    if (!title || !abstract) {
      console.log(`   ⚠️  Skipping ${arxivId} — could not parse ${!title ? "title" : "abstract"} from the listing page.`);
      continue;
    }
    papers.push({ arxivId, title, abstract, authors, link: `https://arxiv.org/abs/${arxivId}` });
  }
  return papers;
}

async function fetchArxivListing() {
  const listRes = await withRetry(() => fetchOk(ARXIV_LISTING_URL));
  const html = await listRes.text();

  // Verify the listing is for today (UTC) before proceeding
  const now = new Date();
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const todayStr = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  if (!html.includes(todayStr)) return { status: "not-updated" };

  // The page lists new submissions, cross-lists, and replacements in that
  // order. Replacements are revised old papers, not new ones — drop them.
  const newSection = html.split(/Replacement submissions/i)[0];

  return { status: "ok", papers: parseListingEntries(newSection) };
}

async function fetchArxivPapers() {
  let papers = [];
  for (let attempt = 1; attempt <= SUSPICIOUS_ZERO_RETRY_ATTEMPTS; attempt++) {
    const result = await fetchArxivListing();
    if (result.status === "not-updated") return null;
    papers = result.papers;
    if (papers.length > 0) break;
    if (attempt < SUSPICIOUS_ZERO_RETRY_ATTEMPTS) {
      console.log(`   ⚠️  Listing page matched today's date but had 0 papers (attempt ${attempt}/${SUSPICIOUS_ZERO_RETRY_ATTEMPTS}) — retrying in ${SUSPICIOUS_ZERO_RETRY_DELAY_MS / 1000}s in case of a transient CDN/origin blip...`);
      await new Promise(r => setTimeout(r, SUSPICIOUS_ZERO_RETRY_DELAY_MS));
    }
  }
  if (papers.length === 0) return { suspiciousZero: true };
  return papers;
}

// --- Claude relevance check ----------------------------------------------------

async function isRelevant(paper) {
  const msg = await withRetry(() => claude().chat.completions.create({
    model: RELEVANCE_MODEL,
    max_tokens: 10,
    temperature: 0,
    messages: [{
      role: "user",
      content: `Is this astrophysics paper significantly related to ${RESEARCH_TOPICS}? Answer only YES or NO.

Title: ${paper.title}
Abstract: ${paper.abstract}`,
    }],
  }));
  const answer = (msg.choices[0].message.content ?? "").trim().toUpperCase();
  return answer.startsWith("YES");
}

// --- Slack -------------------------------------------------------------------
// The research group is defined as every human member of the channel the bot
// posts to. The bot must be invited to the channel for this lookup to work.

async function slackGet(endpoint, params = {}) {
  const url = new URL(`https://slack.com/api/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${endpoint} error: ${data.error}`);
  return data;
}

async function fetchChannelMembers() {
  // Page through conversations.members — channels can exceed one page
  const ids = [];
  let cursor;
  do {
    const params = { channel: process.env.SLACK_CHANNEL_ID, limit: 200 };
    if (cursor) params.cursor = cursor;
    const data = await slackGet("conversations.members", params);
    ids.push(...data.members);
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);

  const details = await Promise.all(ids.map(id => slackGet("users.info", { user: id }).catch(() => null)));
  return details
    .filter(d => d && !d.user.is_bot && !d.user.deleted)
    .map(d => ({
      id:          d.user.id,
      realName:    d.user.real_name ?? "",
      displayName: d.user.profile?.display_name ?? "",
    }));
}

// Strip diacritics so "José Gómez" (arXiv) matches "Jose Gomez" (Slack)
function normalizeName(name) {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// Match on last name + first initial. This can produce false positives for
// common surnames — see the README note on author matching.
function findMatchingMembers(authors, members) {
  const matched = [];
  for (const m of members) {
    const slackNames = [m.realName, m.displayName].filter(Boolean).map(normalizeName);
    const hit = authors.some(author => {
      const ap = normalizeName(author).split(/\s+/);
      return slackNames.some(sn => {
        const sp = sn.split(/\s+/);
        return ap.at(-1) === sp.at(-1) && ap[0]?.[0] === sp[0]?.[0];
      });
    });
    if (hit) matched.push(m);
  }
  return matched;
}

// Slack allows at most 50 blocks per message and 3000 chars per section text,
// so split large digests across several consecutive messages.
const MAX_BLOCKS_PER_MESSAGE = 50;

function truncateSectionText(text, limit = 2900) {
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

async function postToSlack(blocks) {
  if (DRY_RUN) {
    console.log("\n--- DRY RUN: Slack message blocks ---");
    console.log(JSON.stringify(blocks, null, 2));
    return;
  }
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
    const chunk = blocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE);
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL_ID,
        blocks: chunk,
        text: "Protoplanetary Disk Digest",
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`chat.postMessage error: ${data.error}`);
  }
}

// --- Claude summaries ----------------------------------------------------------

async function summarise(paper) {
  const msg = await withRetry(() => claude().chat.completions.create({
    model: SUMMARY_MODEL,
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `You are a research assistant summarizing astrophysics papers for a team of scientists.

Title: ${paper.title}
Authors: ${paper.authors.slice(0, 5).join(", ")}${paper.authors.length > 5 ? " et al." : ""}
Abstract: ${paper.abstract}

Provide:
1. A plain-language summary (2-3 sentences).
2. Key findings as 3-4 bullet points.

Respond ONLY with JSON: {"summary": "...", "bullets": ["...", "..."]}. No markdown fences.`,
    }],
  }));
  const raw = (msg.choices[0].message.content ?? "").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// Both a suspicious zero and an outright fetch failure post this, so a broken
// run is never mistaken for a genuinely quiet day. No papers are recorded as
// checked in either case, so a same-day manual re-run (workflow_dispatch) will
// still pick them up — tomorrow's run only ever sees tomorrow's listing.
function scrapeFailedBlocks(detail) {
  return [
    { type: "header", text: { type: "plain_text", text: "🪐 Protoplanetary Disk Digest — scrape failed", emoji: true } },
    { type: "section", text: { type: "mrkdwn",
      text: `_${detail} Nothing was recorded as checked, so a manual re-run today (workflow_dispatch) should pick these papers up._` } },
  ];
}

// --- Fetch diagnostics -------------------------------------------------------
// `node disk-digest.js --debug-fetch` (also a workflow_dispatch input). Runs the
// real scrape path and reports where it breaks, without posting anything.
//
// The previous version of this only fetched the listing page and counted ID
// regex matches, so it would have come back clean during the 9/14 outage — the
// break was downstream of anything it looked at. It now walks the whole chain
// (transport -> date gate -> section split -> entry parse) and reports the same
// numbers the digest itself would compute, via the same parseListingEntries().

async function debugFetch() {
  console.log(`🔎 arXiv fetch diagnostics — ${new Date().toISOString()}\n`);

  // Raw fetch, not fetchOk(): on a block or challenge page the status, headers
  // and body ARE the diagnosis, so report them rather than throwing.
  const res = await fetch(ARXIV_LISTING_URL, { headers: FETCH_HEADERS });
  console.log(`URL:    ${ARXIV_LISTING_URL}`);
  console.log(`status: ${res.status} ${res.statusText}${res.ok ? "" : "   ← non-2xx: the digest would now fail loudly here"}`);
  // A block usually announces itself in the edge/CDN headers rather than the body.
  for (const h of ["content-type", "content-length", "server", "age", "via", "cf-ray", "cf-mitigated", "x-cache", "retry-after"]) {
    if (res.headers.has(h)) console.log(`   ${h}: ${res.headers.get(h)}`);
  }

  const html = await res.text();
  console.log(`body:   ${html.length} bytes`);

  const now = new Date();
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const todayStr = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const isToday = html.includes(todayStr);
  console.log(`\ntoday (UTC): "${todayStr}" present: ${isToday}${isToday ? "" : "   ← digest would exit as \"not yet updated\""}`);
  console.log(`headings: ${JSON.stringify([...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map(m => m[1].trim()))}`);

  const newSection = html.split(/Replacement submissions/i)[0];
  console.log(`new+cross section: ${newSection.length} bytes of ${html.length}`);

  // Raw <dt>/<dd> pair count vs successfully parsed papers. A gap between these
  // two means the page markup changed and entries are being silently dropped.
  const pairs = [...newSection.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)].length;
  const papers = parseListingEntries(newSection);
  console.log(`\n<dt>/<dd> pairs:  ${pairs}`);
  console.log(`papers parsed:    ${papers.length}${papers.length === pairs ? "  ✅ all pairs parsed" : `  ⚠️  ${pairs - papers.length} dropped — see warnings above`}`);
  console.log(`missing authors:  ${papers.filter(p => p.authors.length === 0).length}`);

  if (papers.length > 0) {
    const p = papers[0];
    console.log(`\nfirst entry:\n   id:       ${p.arxivId}\n   title:    ${p.title.slice(0, 90)}\n   authors:  ${p.authors.slice(0, 4).join(", ")}${p.authors.length > 4 ? ` (+${p.authors.length - 4})` : ""}\n   abstract: ${p.abstract.length} chars — ${JSON.stringify(p.abstract.slice(0, 70))}`);
    const verdict = isToday ? "✅ scrape healthy — the digest would proceed with these papers." : "⚠️  parsed fine, but the date gate would stop the run.";
    console.log(`\n${verdict}`);
  } else {
    console.log(`\n❌ No papers parsed — the digest would post the scrape-failed notice.`);
    console.log(`--- first 800 chars of body ---\n${html.slice(0, 800)}`);
  }
}

// --- Main --------------------------------------------------------------------

async function main() {
  if (DEBUG_FETCH) return debugFetch();

  console.log(`🪐 Disk Digest starting...${DRY_RUN ? " (dry run — nothing will be posted)" : ""}\n`);

  console.log("👥 Fetching channel members...");
  const members = await fetchChannelMembers();
  console.log(`   ${members.length} human members found.`);

  console.log("📡 Fetching arXiv papers...");
  let fetched;
  try {
    fetched = await fetchArxivPapers();
  } catch (err) {
    // A hard fetch failure (block, challenge page, DNS, timeout) must be as
    // loud as a suspicious zero — the 2026 outages were invisible precisely
    // because a broken fetch looked like a quiet day.
    console.error(`   ❌ arXiv fetch failed outright: ${err.message}`);
    await postToSlack(scrapeFailedBlocks(`The digest could not reach arxiv.org: \`${err.message}\``));
    process.exit(1);
  }
  if (fetched === null) {
    console.log("   ⚠️  arxiv.org/list/astro-ph/new is not yet updated for today. Nothing to do.");
    return;
  }
  if (fetched.suspiciousZero) {
    // The listing page matched today's date but had an empty "New submissions"
    // section even after retries — weekdays reliably have 70+ new astro-ph
    // papers, so this almost certainly means arXiv/its CDN served a broken or
    // stale page rather than a real zero-paper day. Surface that distinctly
    // instead of silently posting the calm "no relevant papers" notice, which
    // would look identical to a genuinely quiet day.
    console.log("   ❌ Still 0 papers after retries — this looks like a scrape failure, not a real zero-paper day.");
    await postToSlack(scrapeFailedBlocks(
      "arxiv.org/list/astro-ph/new matched today's date but yielded 0 papers, even after retries. This is very unlikely to be a real zero-paper day — the scrape probably hit a transient arXiv/CDN issue."
    ));
    process.exit(1);
  }
  console.log(`   ${fetched.length} papers found on arxiv.org/list/astro-ph/new.`);

  // Skip anything already digested on a previous day (e.g. cross-listings)
  const postedIds = await loadPostedIds();
  const all = fetched.filter(p => !postedIds[p.arxivId]);
  if (all.length < fetched.length) {
    console.log(`   ${fetched.length - all.length} already seen on a previous day — skipped.`);
  }

  console.log("🔍 Running Claude relevance check...");
  const matched = [];
  const BATCH = 10;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const verdicts = await Promise.all(batch.map(p => isRelevant(p).catch(err => {
      console.log(`   ⚠️  Relevance check failed for "${p.title.slice(0, 55)}...": ${err.message}`);
      return false;
    })));
    batch.forEach((paper, j) => {
      console.log(`   [${i + j + 1}/${all.length}] ${verdicts[j] ? "✅" : "❌"} ${paper.title.slice(0, 55)}...`);
      if (verdicts[j]) matched.push(paper);
    });
  }
  console.log(`   ${matched.length} papers passed relevance check.`);

  const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric", timeZone:"UTC" });

  // Once the run completes, remember every paper checked today (relevant or
  // not) so it is never re-checked or re-posted. Not persisted on dry runs.
  const recordCheckedPapers = async () => {
    if (DRY_RUN) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    all.forEach(p => { postedIds[p.arxivId] = dateStr; });
    await savePostedIds(postedIds);
  };

  if (matched.length === 0) {
    console.log("No relevant papers found. Posting notice to Slack...");
    await postToSlack([
      { type: "header", text: { type: "plain_text", text: `🪐 Protoplanetary Disk Digest — ${today}`, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: "_No new relevant papers on arXiv today._" } },
    ]);
    await recordCheckedPapers();
    console.log("✅ Posted.");
    return;
  }

  console.log("\n🤖 Summarising papers...");
  const results = [];
  for (const [i, paper] of matched.entries()) {
    process.stdout.write(`   [${i + 1}/${matched.length}] ${paper.title.slice(0, 60)}... `);
    // A failed summary falls back to the abstract rather than aborting the digest
    let summary;
    try {
      summary = await summarise(paper);
    } catch (err) {
      console.log(`⚠️  summary failed (${err.message}), using abstract`);
      summary = { summary: paper.abstract, bullets: [] };
    }
    const paperMembers = findMatchingMembers(paper.authors, members);
    results.push({ paper, summary, members: paperMembers });
    console.log(paperMembers.length > 0
      ? `⭐ matched ${paperMembers.map(m => `@${m.displayName || m.realName}`).join(", ")}`
      : "✓");
  }

  console.log("\n📬 Building Slack message...");
  const teamHits = results.filter(r => r.members.length > 0).length;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `🪐 Protoplanetary Disk Digest — ${today}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn",
      text: `*${matched.length} new paper${matched.length > 1 ? "s" : ""} today.*${teamHits > 0 ? ` ⭐ ${teamHits} from your team!` : ""}` } },
    { type: "divider" },
  ];

  results.forEach(({ paper, summary, members: paperMembers }, i) => {
    const authorStr = paper.authors.length > 3
      ? paper.authors.slice(0, 3).join(", ") + " et al."
      : paper.authors.join(", ");
    const teamTag   = paperMembers.length > 0
      ? ` ⭐ _Congrats ${paperMembers.map(m => `<@${m.id}>`).join(", ")}!_`
      : "";
    const bullets   = (summary.bullets ?? []).map(b => `• ${b}`).join("\n");

    blocks.push({
      type: "section",
      text: { type: "mrkdwn",
        text: truncateSectionText(`*${i + 1}. <${paper.link}|${paper.title}>*${teamTag}\n_${authorStr}_\n\n*Summary:* ${summary.summary}\n\n${bullets}`) },
    });
    blocks.push({ type: "divider" });
  });

  await postToSlack(blocks);
  await recordCheckedPapers();
  console.log(`\n✅ Posted! ${matched.length} paper(s), ${teamHits} team highlight(s).`);
}

main().catch(err => { console.error("❌ Fatal error:", err); process.exit(1); });
