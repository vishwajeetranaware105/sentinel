#!/usr/bin/env bash
# Builds a ready-to-push Homebrew tap for Sentinel.
#
#   scripts/make-tap.sh --app-repo <git url of THIS repo> [--out ../homebrew-sentinel] [--dry-run]
#
# The tap repo MUST be named  homebrew-<something>  (e.g. homebrew-sentinel).
# Formula installs straight from the app repo's git tag, so friends need git access to it (no tarball/sha needed).
set -euo pipefail
cd "$(dirname "$0")/.."

APP_REPO=""; OUT="../homebrew-sentinel"; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --app-repo) APP_REPO="$2"; shift 2;;
  --out) OUT="$2"; shift 2;;
  --dry-run) DRY=1; shift;;
  *) echo "unknown arg: $1"; exit 2;; esac; done
[ -n "$APP_REPO" ] || { echo "usage: scripts/make-tap.sh --app-repo <git url> [--out DIR] [--dry-run]"; exit 2; }

VERSION=$(node -p "require('./package.json').version")
if [ "$DRY" = 1 ]; then
  REV="0000000000000000000000000000000000000000"
  echo "(dry run: not tagging, using a placeholder revision)"
else
  [ -z "$(git status --porcelain)" ] || { echo "Commit your changes first (git add -A && git commit), the formula pins an exact commit."; exit 1; }
  git rev-parse HEAD >/dev/null 2>&1 || { echo "No commits yet. Run: git add -A && git commit -m 'Sentinel $VERSION'"; exit 1; }
  git tag -f "v$VERSION" >/dev/null
  REV=$(git rev-parse HEAD)
fi

mkdir -p "$OUT/Formula"
sed -e "1d" -e "s|__URL__|$APP_REPO|" -e "s|__HOMEPAGE__|${APP_REPO%.git}|" -e "s|__VERSION__|$VERSION|g" -e "s|__REVISION__|$REV|" Formula/sentinel.rb > "$OUT/Formula/sentinel.rb"
ruby -c "$OUT/Formula/sentinel.rb" >/dev/null && echo "formula syntax ok"
cat > "$OUT/README.md" <<EOF
# Sentinel tap

    brew tap <TAP-NAME> <TAP-GIT-URL>
    brew install sentinel
    sentinel

Update later with \`brew update && brew upgrade sentinel\`.
EOF
echo "Tap written to: $OUT"
echo "App repo tag:   v$VERSION @ ${REV:0:10}"
cat <<EOF

NEXT (you do these once):
  1. Push the app repo + tag:      git remote add origin $APP_REPO && git push -u origin HEAD && git push origin v$VERSION
  2. Create an EMPTY repo named homebrew-sentinel on the same host, then:
       cd $OUT && git init -q && git add -A && git commit -qm "sentinel $VERSION" && git remote add origin <TAP-GIT-URL> && git push -u origin HEAD
  3. Tell friends (one time):      brew tap <you>/sentinel <TAP-GIT-URL> && brew install sentinel
EOF
