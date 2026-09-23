#!/usr/bin/env bash
# Rebuild the vendored @lightwebinc/overlay tarball from upstream, reproducibly.
#
# The tarball beside this script is a BUILT ARTEFACT, and an unverifiable built
# artefact is precisely the thing that cost this project a ninety-minute silent
# outage. So it ships with the upstream commit it came from, the patch that was
# applied, and this script, which regenerates it from nothing but those two.
#
# Usage:  ./rebuild.sh [workdir]
set -euo pipefail
SHA=888025a82dcb85f7be9ce091d1075422339fa3cd   # @bsv/overlay 2.3.1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${1:-$(mktemp -d)}"
echo "== fetching ts-stack $SHA"
mkdir -p "$WORK" && cd "$WORK"
gh api "repos/bsv-blockchain/ts-stack/tarball/$SHA" > src.tar.gz
# The package's tsconfig extends a MONOREPO-ROOT shared config, so config/ must
# be extracted alongside the package or `tsc -b` fails with TS5083.
tar xzf src.tar.gz --wildcards "*/packages/overlays/overlay/*" "*/config/typescript/*"
ROOT="$(find . -maxdepth 1 -type d -name 'bsv-blockchain-ts-stack-*' | head -1)"
PKG="$ROOT/packages/overlays/overlay"

echo "== applying the patch"
patch -p1 -d "$PKG" < "$HERE/onTopicFailed.patch"
cp "$HERE/FORK.md" "$PKG/FORK.md"

echo "== renaming, and pinning the workspace: deps that cannot resolve outside the monorepo"
python3 - "$PKG/package.json" <<'PY'
import sys, json
p = sys.argv[1]; d = json.load(open(p))
d['name'] = '@lightwebinc/overlay'
d['dependencies']['@bsv/gasp'] = '1.3.6'
d.setdefault('devDependencies', {})['@bsv/sdk'] = '2.7.1'
json.dump(d, open(p, 'w'), indent=2)
PY

echo "== building and packing in a clean container"
docker run --rm -v "$PWD/$ROOT":/w -w /w/packages/overlays/overlay node:24-alpine \
  sh -c 'npm install --no-audit --no-fund --loglevel=error && npm run build && npm pack'
echo "== done: $PKG/lightwebinc-overlay-2.3.1.tgz"
echo "   Verify the constructor arity is UNCHANGED before shipping:"
echo "   grep -oE 'constructor\\(.*\\) \\{' dist/cjs/src/Engine.js"
