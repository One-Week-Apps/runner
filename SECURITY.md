# Security

The Runner executes Claude Code on your Mac, so its trust boundaries matter:

- Only the authors listed in `allowedAuthors` (GitHub) or the paired account (Studio) can trigger work.
- Claude Code runs with an allowlist of tools and without your personal settings or hooks.
- The local API listens on `127.0.0.1` only; the Runner opens no inbound port.
- The Studio session (`~/.aitasker/studio-session.json`) is readable by your user only.

To report a vulnerability, please use GitHub's
[private vulnerability reporting](https://github.com/One-Week-Apps/runner/security/advisories/new)
rather than a public issue.
