<p align="center"><img src="icon128.png" width="96" alt=""></p>

# Catfish Catcher for LinkedIn

Spot fake profiles, job scams and copied posts on LinkedIn. Free, and nothing leaves your browser.

Fake recruiters copy real posts to win your trust. Catfish Catcher shows the signs, free and inside your browser.

- **Free and open source.** No ads, no account, no tracking.
- **Runs in your browser.** No servers. Nothing is sent anywhere.
- **Signs, not proof.** It shows why something looks fishy and leaves the call to you.

## Install

- **Chrome, Edge, Brave:** Chrome Web Store (coming soon)
- **Firefox:** Firefox Add-ons (coming soon)

Or from source:

1. Run `python3 build.py`.
2. **Chrome:** unzip `dist/catfish-catcher-chrome.zip`, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.
3. **Firefox 140+:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `dist/catfish-catcher-firefox.zip`.

## What it flags

**In your feed**, posts from people outside your network get a badge when:

- **Copied post.** The same text appeared earlier from a different author. Only the later poster is flagged.
  > Copied word for word from Alex Moreno, who posted it 1 day ago. This one was posted 3 hours ago.
- **Reworded copy.** Same opening sentence, the rest reworded. A weak sign.
- **Job lure.** Reads like a job offer and asks for DMs or comments, but names no company, link or job listing.

**On profiles**, a badge next to the name shows **Very fishy**, **A bit fishy** or **Nothing fishy**. Click it to see the signs.

Posts from your connections and your own profile are skipped.

## How it scores

| Fishy signs | Points |
|---|---|
| Latest post is a job lure | +2 |
| Post copied word for word from an earlier poster | +2 |
| Account created less than 12 months ago (under 1 month +5, 1–2 months +4, 3–5 months +3) | +2 |
| Name doesn't match the profile link LinkedIn made at sign-up (renamed account) | +2 |
| Half or more of the roles are at employers with no LinkedIn company page (accounts under 12 months; older: weak, +1) | +2 |

| Weak signs (only counted with a fishy sign) | Points |
|---|---|
| No LinkedIn verification · 500+ connections on an account under 6 months · reworded or possibly copied post · free email with numbers · keyword-stuffed headline · freelance-only work · buzzword About section · under 50 connections | +1 each |

| Reassuring signs | Points |
|---|---|
| On LinkedIn 3+ years (1–3 years: −1) | −3 |
| LinkedIn verification | −2 |
| 500+ connections · 4+ dated roles (both not counted on accounts under 6 months) · recommendations | −1 each |

Without a fishy sign, the result is **Nothing fishy**. With one: 3–5 is **A bit fishy**, 6+ is **Very fishy**.

## Privacy

Everything runs on the LinkedIn page you're viewing. The extension stores your settings, profile results for 7 days and short fingerprints of post text for 30 days, all in your browser.

Checking a profile counts as a LinkedIn profile view. Automatic checks are limited to flagged posts from people outside your network: one at a time, at most 10 an hour.

**Permissions:** `storage`, and access to `www.linkedin.com` only. See [PRIVACY.md](PRIVACY.md).

## Limits

- English LinkedIn only.
- LinkedIn changes its pages often. If badges stop appearing, the page-reading code needs updating.
- "Earlier" means the earliest copy seen in your feed. An older original may exist.

## Development

How it works:

- **One content script** (`content.js`) for Chrome and Firefox (Manifest V3). The UI sits in a shadow DOM, so LinkedIn's styles and Trusted Types don't touch it.
- **Profiles:** reads the page, then fetches the server-rendered experience page for the full work history.
- **Background checks:** a hidden same-origin iframe loads the author's profile, and the same script runs inside it and writes its result back as JSON.
- **Copy detection:** a fingerprint of the first ~200 normalised characters of each post, plus one of the first ~100 for reworded copies, kept in `storage.local` for 30 days.

Commands:

- `node --check content.js` checks syntax.
- `node test.js` runs the copy-detection self-check.
- `python3 build.py` builds both zips into `dist/`.
- Word lists (`BUZZWORDS`, `JOBISH_RE`, `DM_RE`) are at the top of `content.js`. Weights are in `score()`.

## Licence

GPLv3. See [LICENSE](LICENSE).
