# PostKina Reels

An isolated, zero-cost-first automation for publishing one English Facebook Reel per day from PostKina stories.

## What it does

- Runs at 8:00 PM `America/New_York` (the workflow checks both possible UTC hours for daylight-saving time).
- Selects an unused PostKina article, prioritising US-related stories.
- Creates American-English Reel copy with Gemini, with a deterministic fallback if Gemini is unavailable.
- Renders a 30-second, 1080×1920, H.264/AAC MP4 with FFmpeg and burned-in captions.
- Uploads the temporary MP4 to the repository's `reels-media` release.
- Publishes it through Meta's Facebook Reels Publishing API.
- Records the date and source story to prevent duplicates.

## Required repository secrets

Open **Settings → Secrets and variables → Actions → New repository secret** and add:

1. `REELS_FACEBOOK_PAGE_ACCESS_TOKEN` — Page access token with permission to create Page content.
2. `REELS_GEMINI_API_KEY` — a separate Gemini key for Reel copy. This is optional because a safe non-AI fallback is included.

## Run manually

Open **Actions → Daily USA Reel → Run workflow**. Manual runs default to `force: true`.

## Optional API

The `api/` directory contains a separate Cloudflare Worker with:

- `GET /health`
- `POST /generate` (requires `Authorization: Bearer <REELS_ADMIN_TOKEN>`)

Before deploying it, create a fine-grained GitHub token with Actions write access to this repository and set Worker secrets:

```powershell
cd api
npm install
npx wrangler secret put GITHUB_WORKFLOW_TOKEN
npx wrangler secret put REELS_ADMIN_TOKEN
npx wrangler deploy
```

Never commit access tokens or API keys.

## Copyright and accuracy

The workflow uses the article image and preserves its credit/licence in the Facebook description. Source facts are limited to the published PostKina title and excerpt. Review licences and output periodically, especially before monetisation.
