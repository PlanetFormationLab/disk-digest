// disk-digest.js
// Usage: node disk-digest.js
// Requires: npm install node-fetch @anthropic-ai/sdk

import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";

// ─── KEYWORD FILTERS ─────────────────────────────────────────────────────────
// A paper must match AT LEAST ONE term from EACH list to pass the pre-filter.

const DISK_TERMS = [
  "protoplanetary disk",
  "protoplanetary disc",
  "proto-planetary disk",
  "proto-planetary disc",
  "circumstellar disk",
  "circumstellar disc",
  "protostellar disk",
  "protostellar disc",
  "planet-forming disk",
  "planet-forming disc",
  "circumbinary disk",
  "circumbinary disc",
  "circumplanetary disk",
  "circumplanetary disc",
  "disk-based",
];

const CONTEXT_TERMS = [
  "planet formation",
  "planet-forming",
  "T Tauri",
  "Herbig Ae",
  "Herbig Be",
  "young stellar object",
  "YSO",
  "dust continuum",
  "dust emission",
  "millimeter emission",
  "submillimeter",
  "ALMA",
  "gap opening",
  "ring structure",
  "dust trap",
  "pebble accretion",
  "DSHARP",
  "disk substructure",
  // gas kinematics & dynamics
  "gas kinematics",
  "disk kinematics",
  "velocity perturbation",
  "non-Keplerian",
  "planet-disk interaction",
  "planet-disc interaction",
  "gravitational instability",
  "disk warp",
  // disk chemistry
  "astrochemistry",
  "molecular line",
  "CO isotopologue",
  "disk chemistry",
  // disk types & structures
  "transition disk",
  "transition disc",
  "inner cavity",
  "dust cavity",
  // magnetic fields in disks
  "magnetic field",
];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- arXiv -------------------------------------------------------------------
// Search arXiv for papers which might be releavant based on the keywords above.
// For those that are, run a more in-depth classification using Claude API.

async function fetchArxivPapers() {
  const url = "https://export.arxiv.org/api/query?search_query=cat:astro-ph.*&sortBy=submittedDate&sortOrder=descending&max_results=100";
  const res = await fetch(url);
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map(([, entry]) => {
    const get = tag => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`))?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim());
    return {
      id:       get("id"),
      title:    get("title"),
      abstract: get("summary"),
      link:     get("id"),
      authors,
    };
  });
}

// Stage 1: fast keyword pre-filter (must match one term from each list)

function passesPrefiler(p) {
  const hay = (p.title + " " + p.abstract).toLowerCase();
  return DISK_TERMS.some(t => hay.includes(t)) &&
         CONTEXT_TERMS.some(t => hay.includes(t.toLowerCase()));
}

// Stage 2: Claude relevance check for papers that passed the pre-filter

async function isRelevant(paper) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: `Is this astrophysics paper significantly related to protoplanetary disks, planet formation, or the use of circumstellar disks to characterize young stars (e.g. disk-based stellar masses, pre-main sequence evolution)? Answer only YES or NO.

Title: ${paper.title}
Abstract: ${paper.abstract}`,
    }],
  });
  const answer = msg.content.map(c => c.text ?? "").join("").trim().toUpperCase();
  return answer.startsWith("YES");
}

// --- Slack -------------------------------------------------------------------
// We want to check who is part of the reserach group, defined as any human in
// the channel this bot is in.
// TODO: Figure out how to deal with display names that might not match papers.

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
  const { members: ids } = await slackGet("conversations.members", { channel: process.env.SLACK_CHANNEL_ID, limit: 200 });
  const details = await Promise.all(ids.map(id => slackGet("users.info", { user: id }).catch(() => null)));
  return details
    .filter(d => d && !d.user.is_bot && !d.user.deleted)
    .map(d => ({
      id:          d.user.id,
      realName:    d.user.real_name ?? "",
      displayName: d.user.profile?.display_name ?? "",
    }));
}

function findMatchingMember(authors, members) {
  for (const m of members) {
    const slackNames = [m.realName, m.displayName].filter(Boolean).map(n => n.toLowerCase());
    for (const author of authors) {
      const ap = author.toLowerCase().split(/\s+/);
      for (const sn of slackNames) {
        const sp = sn.split(/\s+/);
        const lastMatch  = ap.at(-1) === sp.at(-1);
        const firstMatch = ap[0]?.[0] === sp[0]?.[0];
        if (lastMatch && firstMatch) return m;
      }
    }
  }
  return null;
}

async function postToSlack(blocks) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: process.env.SLACK_CHANNEL_ID,
      blocks,
      text: "Protoplanetary Disk Digest",
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`chat.postMessage error: ${data.error}`);
}

// --- Claude ------------------------------------------------------------------
// Develop a short summary of the papers ready to post to Slack.

async function summarise(paper) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
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
  });
  const raw = msg.content.map(c => c.text ?? "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// --- Main --------------------------------------------------------------------

async function main() {
  console.log("🪐 Disk Digest starting...\n");

  console.log("👥 Fetching channel members...");
  const members = await fetchChannelMembers();
  console.log(`   ${members.length} human members found.`);

  console.log("📡 Fetching arXiv papers...");
  const all = await fetchArxivPapers();
  const preFiltered = all.filter(passesPrefiler);
  console.log(`   ${all.length} total · ${preFiltered.length} passed keyword pre-filter.`);

  console.log("🔍 Running Claude relevance check...");
  const matched = [];
  for (const [i, paper] of preFiltered.entries()) {
    process.stdout.write(`   [${i + 1}/${preFiltered.length}] ${paper.title.slice(0, 55)}... `);
    const relevant = await isRelevant(paper);
    console.log(relevant ? "✅ relevant" : "❌ filtered out");
    if (relevant) matched.push(paper);
  }
  console.log(`   ${matched.length} papers passed relevance check.`);

  if (matched.length === 0) {
    console.log("No relevant papers found. Posting notice to Slack...");
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    await postToSlack([
      { type: "header", text: { type: "plain_text", text: `🪐 Protoplanetary Disk Digest — ${today}`, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: "_No new relevant papers on arXiv today._" } },
    ]);
    console.log("✅ Posted.");
    return;
  }

  console.log("\n🤖 Summarising papers...");
  const results = [];
  for (const [i, paper] of matched.entries()) {
    process.stdout.write(`   [${i + 1}/${matched.length}] ${paper.title.slice(0, 60)}... `);
    const summary = await summarise(paper);
    const member  = findMatchingMember(paper.authors, members);
    results.push({ paper, summary, member });
    console.log(member ? `⭐ matched @${member.displayName || member.realName}` : "✓");
  }

  console.log("\n📬 Building Slack message...");
  const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const teamHits = results.filter(r => r.member).length;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `🪐 Protoplanetary Disk Digest — ${today}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn",
      text: `*${matched.length} new paper${matched.length > 1 ? "s" : ""} today.*${teamHits > 0 ? ` ⭐ ${teamHits} from your team!` : ""}` } },
    { type: "divider" },
  ];

  results.forEach(({ paper, summary, member }, i) => {
    const authorStr = paper.authors.length > 3
      ? paper.authors.slice(0, 3).join(", ") + " et al."
      : paper.authors.join(", ");
    const teamTag   = member ? ` ⭐ _Congrats <@${member.id}>!_` : "";
    const bullets   = (summary.bullets ?? []).map(b => `• ${b}`).join("\n");

    blocks.push({
      type: "section",
      text: { type: "mrkdwn",
        text: `*${i + 1}. <${paper.link}|${paper.title}>*${teamTag}\n_${authorStr}_\n\n*Summary:* ${summary.summary}\n\n${bullets}` },
    });
    blocks.push({ type: "divider" });
  });

  await postToSlack(blocks);
  console.log(`\n✅ Posted! ${matched.length} paper(s), ${teamHits} team highlight(s).`);
}

main().catch(err => { console.error("❌ Fatal error:", err.message); process.exit(1); });
