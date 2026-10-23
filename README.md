# One Week Apps Runner

Runs iOS development tasks on your own Mac with your own Claude Code. You write a task on your phone; the
Runner implements it, builds the app, runs the UI tests on simulators, takes screenshots and sends you a report.
You answer **OK** to merge the work into your base branch or **KO + one line of feedback** to get another attempt.

*[Version française plus bas.](#en-français) · Step-by-step guide (French): [Démarrer avec Studio](https://www.one-week-apps.com/studio/)*

## How it works

```
 Focus app (Studio)  ─┐                         ┌─ Claude Code (your subscription or API key)
 or GitHub issues    ─┼─▶  Runner orchestrator ─▶  compute agent ─┼─ xcodebuild: build-for-testing, UI tests
                      │    (Node, src/)            (Python,      └─ screenshots + VoiceOver order
 report, OK / KO   ◀──┘                             compute-agent/)
```

1. **Pick up** a task: a task sent from the One Week Apps Focus app, or a GitHub issue labelled `aitasker`.
2. **Prepare** a dedicated clone under `~/.aitasker/repos` (never your working copy), on a branch per task,
   merged with the latest base branch.
3. **Develop** with `claude -p`, restricted to an allowlist of tools: read and edit files, plus a few
   read-only commands. Your personal Claude Code hooks and permission rules are not loaded.
4. **Build and test** once with `build-for-testing`, then run the task's UI tests on an already booted simulator.
5. **Review**: when paired with Studio, One Week Apps Studio reviews the screenshots (UX) and the diff
   (code). The Runner fixes its own findings up to twice before you see anything.
6. **Report** with screenshots per step and device, failing tests, cost, and a link to the diff.
7. **Reply** `OK` (merged into the base branch) or `KO 1.2 : the title is cut` (new attempt on the same branch).

## What stays on your Mac, what leaves it

| Stays on your Mac | Sent to One Week Apps Studio (when paired) |
|---|---|
| Your repository and its clones | The task's title and description |
| Claude Code and its usage (your account) | Screenshots from the UI tests, for the UX review |
| Build and test logs | The task's diff, for the code review |
| | Progress and reports, so the Focus app can show them |

Studio forwards review requests to the Anthropic API. The Runner opens no inbound port: its local API listens
on `127.0.0.1` only, and every exchange with Studio is an outgoing request made with this Mac's own token.

Without Studio, the Runner still works with GitHub issues: tasks run as written, without instructions,
UX review or code review.

## Requirements

- macOS with Xcode and an iOS simulator runtime
- [Claude Code](https://code.claude.com/docs/en/quickstart), signed in
- Node.js 20+ and Python 3.9+
- GitHub CLI (`gh`), signed in, to push branches and open pull requests
- CocoaPods, only for projects that use it

## Install

```bash
git clone https://github.com/One-Week-Apps/runner.git && cd runner

# With the Focus app: use the pairing code shown in Focus (Mac → Connect my Mac)
./scripts/install.sh --code 123456 --repo owner/MyApp --base main

# Or with GitHub issues only
./scripts/install.sh --repo owner/MyApp --base main

./scripts/install.sh --check   # only check the prerequisites
./scripts/uninstall.sh         # remove the services, keep ~/.aitasker
```

The installer checks the prerequisites, installs dependencies and registers two launchd services that start
with your Mac: `com.oneweekapps.runner.focus` (orchestrator, port 3939) and `com.oneweekapps.runner.compute`
(compute agent, port 8000). Logs are in `~/Library/Logs/OneWeekApps`.

## Configuration

`~/.aitasker/config.json` is written by the installer:

```json
{
  "tracker": "github",
  "allowedAuthors": ["your-github-login"],
  "label": "aitasker",
  "repos": { "owner/MyApp": { "baseBranch": "main" } }
}
```

After an `OK`, the Runner squash-merges the task into `baseBranch` (trunk-based), so the next task starts
from it. If the base changed the same files since the attempt, it first updates the task on top of it, runs
the build and tests again and sends a short report to approve. Set `"merge": "pr"` on a repository to only
open the pull request and merge it yourself. A protected base branch falls back to the pull request.

Only `allowedAuthors` can trigger work, since Claude Code runs on your Mac. Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `AITASKER_CONFIG` | `~/.aitasker/config.json` | Configuration file |
| `AITASKER_POLL_SECONDS` | `10` | Polling interval |
| `AITASKER_BRAIN` | on | `off` disables Studio's instructions and reviews |
| `AITASKER_REPOS_DIR` | `~/.aitasker/repos` | Managed clones (compute agent) |
| `JOB_TIMEOUT_SECONDS` | `900` | Timeout of each pipeline stage (compute agent) |
| `GITHUB_TOKEN` | `gh auth token` | GitHub API token |

## Development

```bash
npm ci
npm run check          # typecheck, lint, tests

cd compute-agent
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check app tests && .venv/bin/pytest
```

The code follows a ports-and-adapters layout. `src/domain` holds the task lifecycle, replies and reports;
`src/usecases/IssueLoop.ts` orchestrates them; `src/adapters` declares the ports (`IssueTracker`, `Brain`,
`ComputeAgentClient`); `src/infrastructure` implements them for GitHub, Studio (Firebase REST) and the local
compute agent. Tests exercise behaviour through the use case and fake only the external boundaries.

## Contributing

Issues and bug reports are welcome. Pull requests are not accepted for now. For security issues, see
[SECURITY.md](SECURITY.md).

## License

[GNU AGPL v3.0](LICENSE). One Week Apps Studio (guidelines, instructions and reviews) is a hosted service
and is not part of this repository.

---

## En français

Le Runner développe vos tâches iOS sur votre Mac, avec votre Claude Code. Vous écrivez une tâche depuis votre
téléphone. Le Runner la code, compile l'app, lance les tests UI sur simulateur, prend des captures et vous
envoie un rapport. Vous répondez **OK** pour fusionner le travail dans votre branche principale, ou **KO + une ligne de retour**
pour une nouvelle tentative. Pour fusionner vous-même, mettez `"merge": "pr"` sur le dépôt dans
`~/.aitasker/config.json` : le Runner ouvre alors seulement la pull request.

Le guide pas à pas : [Démarrer avec Studio](https://www.one-week-apps.com/studio/).

**Installation** avec l'app Focus (code affiché dans Focus, Mac → Connecter mon Mac) :

```bash
git clone https://github.com/One-Week-Apps/runner.git && cd runner
./scripts/install.sh --code 123456 --repo owner/MonApp --base main
```

**Ce qui reste sur votre Mac :** votre code, ses clones, Claude Code et sa consommation (votre compte), les
journaux de compilation et de tests.

**Ce qui part vers One Week Apps Studio :** le titre et la description de la tâche, les captures des tests UI
(regard UX), le diff de la tâche (revue de code), l'avancement et les rapports affichés dans Focus.
Studio transmet les demandes de relecture à l'API d'Anthropic. Le Runner n'ouvre aucun port entrant.

Licence [GNU AGPL v3.0](LICENSE). One Week Apps Studio (grilles, consignes, relectures) est un service
hébergé : il ne fait pas partie de ce dépôt.
