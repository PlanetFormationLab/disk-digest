# disk-digest

A Slack bot that scrapes the daily [astro-ph new listings](https://arxiv.org/list/astro-ph/new), uses Claude to identify papers relevant to your research group, and posts a summarized digest to the channel it is added to. Papers co-authored by channel members are highlighted with a congratulations.

<br>

## Requirements

1. An LLM API key. This repo is set up for [Parley](https://parley.mit.edu) (MIT's OpenAI-compatible gateway to Claude models), but any OpenAI-compatible endpoint works — set `PARLEY_BASE_URL` and `PARLEY_API_KEY` accordingly.

2. The ability to build and install an app on your Slack workspace.

3. [Node.js](https://nodejs.org/) v20.6 or later (for built-in `.env` loading).

<br>

## Setup

There are two stages: build a Slack app that can post to your channel, then run the script daily — either via GitHub Actions (recommended) or a local cron job.

### Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**. Give it a name (e.g. "Disk Digest") and select your workspace.

2. In the left sidebar go to **OAuth & Permissions**. Under **Bot Token Scopes** add the following scopes:
   - `chat:write` — post messages
   - `channels:read` — list channel members for author matching
   - `groups:read` — same, if the digest channel is private
   - `users:read` — look up member names for author matching

3. Scroll to the top of the same page and click **Install to Workspace**, then **Allow**.

4. Copy the **Bot OAuth Token** (starts with `xoxb-...`) — this is your `SLACK_BOT_TOKEN`.

5. In Slack, right-click the channel you want the digest posted to → **View channel details** → scroll to the bottom to find the **Channel ID** (starts with `C...`) — this is your `SLACK_CHANNEL_ID`.

6. **Invite the bot to the channel** (`/invite @Disk Digest`). This is required — the bot reads the channel's member list to know who counts as "your team".

### Option A: GitHub Actions (recommended)

The repo ships with [.github/workflows/daily-digest.yml](.github/workflows/daily-digest.yml), which runs the digest every weekday with no server needed.

1. Fork/clone the repo to your own GitHub account.
2. In your repo go to **Settings → Secrets and variables → Actions** and add four repository secrets: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `PARLEY_API_KEY`, `PARLEY_BASE_URL`.
3. That's it. The workflow runs at 12:00 UTC on weekdays; adjust the `cron:` line to taste. You can also trigger a run manually from the **Actions** tab (`workflow_dispatch`).

### Option B: Run locally

1. Clone the repo and run `npm install`.
2. Copy `.env.example` to `.env` and fill in your credentials. Use `KEY=value` with **no spaces around `=`**:
   - `SLACK_BOT_TOKEN` — from your Slack app's **OAuth & Permissions** page
   - `SLACK_CHANNEL_ID` — right-click your channel in Slack → View channel details
   - `PARLEY_API_KEY` / `PARLEY_BASE_URL` — from your LLM gateway
3. Run with `npm start` (equivalent to `node --env-file=.env disk-digest.js`).

To test without posting to Slack, use `npm run dry-run` — the digest is printed to stdout instead.

To run daily via cron, open your crontab with `crontab -e` and add:

```
0 9 * * 1-5 cd /path/to/disk-digest && node --env-file=.env disk-digest.js >> /tmp/disk-digest.log 2>&1
```

arXiv announces new submissions around 00:00 UTC, so choose a time after that in your timezone.

<br>

## Customizing the relevance filter

Relevance is decided by a Claude yes/no check on each paper's title and abstract. Edit the `RESEARCH_TOPICS` constant at the top of [disk-digest.js](disk-digest.js) to describe your group's interests — plain English works, e.g. `"exoplanet atmospheres, JWST transmission spectroscopy, or hot Jupiter dynamics"`.

The model IDs used for the relevance check and the summaries are set in the `RELEVANCE_MODEL` and `SUMMARY_MODEL` constants.

<br>

## Notes

- **Author matching** compares last name + first initial between arXiv author lists and Slack profile names (diacritics are ignored). Common surnames can occasionally produce false-positive "congrats" tags.
- **Replacements are excluded**: only the *New submissions* and *Cross-lists* sections of the listing page are scanned, so revised versions of old papers don't reappear.
- If the arXiv listing page hasn't been updated for today (weekends, arXiv holidays), the script exits quietly without posting.
- **No duplicates across days**: every paper checked is recorded in `posted-ids.json` (kept for 30 days) and skipped on later runs. The GitHub Actions workflow commits this file back to the repo after each run; dry runs don't write it.
