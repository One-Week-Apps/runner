#!/bin/bash
# One Week Apps Runner: one-command install on the Mac you develop on.
#   ./scripts/install.sh --code 123456 --repo owner/MyApp [--base main] [--name "My Mac"]
#                                       # Studio: tasks sent from One Week Apps Focus (pairing code shown in Focus)
#   ./scripts/install.sh --repo owner/MyApp [--base main] [--keep-awake]
#                                       # GitHub: issues labelled "aitasker"
#   ./scripts/install.sh --check        # only check the prerequisites
# Installs two launchd services that restart with the Mac: the orchestrator ("focus": polls tasks, talks to
# the brain) and the compute agent (clone, Claude Code, build, tests, screenshots). Remove with ./scripts/uninstall.sh.
# Messages are in French, for the developer.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME/.aitasker"
LOGS="$HOME/Library/Logs/OneWeekApps"
AGENTS="$HOME/Library/LaunchAgents"
LABEL_FOCUS="com.oneweekapps.runner.focus"
LABEL_COMPUTE="com.oneweekapps.runner.compute"
LABEL_AWAKE="com.oneweekapps.runner.awake"

REPO=""; BASE="main"; KEEP_AWAKE=0; CHECK_ONLY=0; CODE=""; MAC_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --keep-awake) KEEP_AWAKE=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --code) CODE="$2"; shift 2 ;;
    --name) MAC_NAME="$2"; shift 2 ;;
    *) echo "Option inconnue : $1"; exit 2 ;;
  esac
done

ok()   { printf "  ✅ %s\n" "$1"; }
warn() { printf "  ⚠️  %s\n" "$1"; }
fail() { printf "  ❌ %s\n" "$1"; MISSING=1; }

echo "One Week Apps Runner : vérification des prérequis"
MISSING=0
if [ "$(uname)" = "Darwin" ]; then ok "macOS"; else fail "macOS requis (Xcode et simulateurs iOS)"; fi
if xcodebuild -version >/dev/null 2>&1; then ok "$(xcodebuild -version | head -1)"; else fail "Xcode introuvable : installe-le depuis l'App Store puis lance-le une fois"; fi
if xcrun simctl list runtimes 2>/dev/null | grep -q "iOS"; then ok "Simulateurs iOS"; else fail "Aucun runtime iOS : Xcode > Settings > Components"; fi
if command -v claude >/dev/null 2>&1; then
  if claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
    ok "Claude Code connecté ($(claude auth status 2>/dev/null | sed -n 's/.*"authMethod": "\([^"]*\)".*/\1/p'))"
  else fail "Claude Code n'est pas connecté : lance « claude » puis /login (ton abonnement ou ta clé API)"; fi
else fail "Claude Code introuvable : https://code.claude.com/docs/en/quickstart"; fi
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then ok "GitHub CLI connectée ($(gh api user -q .login))"; else fail "GitHub CLI absente ou non connectée : brew install gh && gh auth login"; fi
if command -v node >/dev/null 2>&1; then ok "Node $(node --version)"; else fail "Node.js 20+ requis"; fi
if command -v python3 >/dev/null 2>&1; then ok "$(python3 --version)"; else fail "Python 3 requis"; fi
if command -v pod >/dev/null 2>&1; then ok "CocoaPods"; else warn "CocoaPods absent : nécessaire seulement pour les projets qui l'utilisent"; fi

[ "$MISSING" = 0 ] || { echo "Corrige les points ❌ puis relance."; exit 1; }
[ "$CHECK_ONLY" = 1 ] && { echo "Tout est prêt."; exit 0; }

echo "Installation des dépendances"
(cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent) \
  || { echo "  ❌ Installation des dépendances Node impossible (voir l'erreur ci-dessus)."; exit 1; }
(cd "$ROOT/compute-agent" && { [ -x .venv/bin/python ] || python3 -m venv .venv; } && .venv/bin/pip install -q --disable-pip-version-check -r requirements.txt) \
  || { echo "  ❌ Installation des dépendances Python impossible (voir l'erreur ci-dessus)."; exit 1; }
ok "Dépendances installées"

mkdir -p "$HOME_DIR" "$LOGS" "$AGENTS"
CONFIG="$HOME_DIR/config.json"
if [ -n "$CODE" ]; then
  [ -n "$REPO" ] || { echo "Avec --code, indique le dépôt de ton app : --repo owner/name"; exit 2; }
  # Studio: write the project's configuration, then pair with the code shown in Focus.
  # The Firebase web API key below is a public project identifier, not a secret: access is enforced by
  # Firebase security rules and by this Mac's own token.
  CONFIG="$CONFIG" REPO="$REPO" BASE="$BASE" python3 - <<'PY'
import json, os
path = os.environ["CONFIG"]
config = json.load(open(path)) if os.path.exists(path) else {}
if config.get("tracker") == "github":
    json.dump(config, open(path.replace("config.json", "config.github.json"), "w"), indent=2, ensure_ascii=False)
repos = config.get("repos", {}) if config.get("tracker") == "studio" else {}
repos[os.environ["REPO"]] = {"baseBranch": os.environ["BASE"]}
config = {
    "tracker": "studio", "label": "aitasker", "repos": repos,
    "studio": {
        "projectId": "one-week-apps-studio",
        "apiKey": "AIzaSyCUvo3150FiJgJT5xCvsbn2sw-zTl0BmLM",
        "bucket": "one-week-apps-studio.firebasestorage.app",
        "pairUrl": "https://europe-west1-one-week-apps-studio.cloudfunctions.net/pairRunnerWithCode",
    },
}
json.dump(config, open(path, "w"), indent=2, ensure_ascii=False)
PY
  (cd "$ROOT" && AITASKER_CONFIG="$CONFIG" node dist/pair.js "$CODE" "$MAC_NAME") || { echo "Appairage impossible (raison ci-dessus) : demande un nouveau code dans Focus (Mac → Connecter mon Mac)."; exit 1; }
  ok "Studio : $MAC_NAME relié à ton compte Focus, dépôt $REPO (branche de base $BASE)"
elif [ -n "$REPO" ]; then
  AUTHOR="$(gh api user -q .login)"
  CONFIG="$CONFIG" REPO="$REPO" BASE="$BASE" AUTHOR="$AUTHOR" python3 - <<'PY'
import json, os
path = os.environ["CONFIG"]
config = json.load(open(path)) if os.path.exists(path) else {"tracker": "github", "allowedAuthors": [], "label": "aitasker", "repos": {}}
if os.environ["AUTHOR"] not in config["allowedAuthors"]:
    config["allowedAuthors"].append(os.environ["AUTHOR"])
config["repos"][os.environ["REPO"]] = {"baseBranch": os.environ["BASE"]}
json.dump(config, open(path, "w"), indent=2, ensure_ascii=False)
PY
  gh label create aitasker --repo "$REPO" --color FFA500 --description "Tâche pour One Week Apps Runner" >/dev/null 2>&1 || true
  ok "Dépôt $REPO suivi (branche de base $BASE, label « aitasker », auteur autorisé : $AUTHOR)"
elif [ ! -f "$CONFIG" ]; then
  echo "Aucun dépôt configuré : relance avec --repo owner/name"; exit 2
fi

# launchd does not inherit the shell's PATH: freeze the install-time one (claude, gh, pod, node).
SERVICE_PATH="$PATH"
plist() { # label, working dir, program and args..., then --env KEY=value...
  local label="$1" dir="$2"; shift 2
  local args="" envs=""
  while [ $# -gt 0 ] && [ "$1" != "--env" ]; do args="$args<string>$1</string>"; shift; done
  [ "${1:-}" = "--env" ] && shift
  envs="<key>PATH</key><string>$SERVICE_PATH</string>"
  for kv in "$@"; do envs="$envs<key>${kv%%=*}</key><string>${kv#*=}</string>"; done
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>EnvironmentVariables</key><dict>$envs</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/$label.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$label.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  # On reinstall, wait for the old service to be gone, otherwise bootstrap fails (error 5).
  for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
}

plist "$LABEL_COMPUTE" "$ROOT/compute-agent" "$ROOT/compute-agent/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8000 \
  --env SELF_BASE_URL=http://127.0.0.1:8000
plist "$LABEL_FOCUS" "$ROOT" "$(command -v node)" "$ROOT/dist/index.js" \
  --env PORT=3939 COMPUTE_BASE_URL=http://127.0.0.1:8000 CALLBACK_BASE_URL=http://127.0.0.1:3939
if [ "$KEEP_AWAKE" = 1 ]; then
  plist "$LABEL_AWAKE" "$HOME" /usr/bin/caffeinate -is
  ok "Mac maintenu éveillé tant qu'il est sur secteur (caffeinate -is)"
fi

sleep 3
if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:3939/health >/dev/null 2>&1; then
  ok "Runner connecté : Focus (3939) et Compute (8000) répondent"
else
  warn "Les services démarrent encore ; journaux : $LOGS"
fi
if [ -n "$CODE" ]; then
  echo "Envoie une tâche depuis One Week Apps Focus : le Runner la prend en charge dans les 10 s."
else
  echo "Crée une issue avec le label « aitasker » sur le dépôt : le Runner la prend en charge dans les 10 s."
fi
