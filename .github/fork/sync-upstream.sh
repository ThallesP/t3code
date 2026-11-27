#!/usr/bin/env bash
# Merges the newest upstream nightly into this fork's `nightly` branch and pushes it, which starts
# the Fork nightly workflow. Run it in a checkout of `nightly` that nothing else works in.
# Prints one line only when a person has to step in: the merge needs conflicts resolved by hand.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

upstream="${FORK_UPSTREAM_URL:-https://github.com/pingdotgg/t3code}"
push_remote="${FORK_PUSH_REMOTE:-fork}"

if git rev-parse -q --verify MERGE_HEAD > /dev/null; then
  echo "The fork's nightly branch has an unfinished upstream merge in $PWD: resolve it, commit and push to $push_remote nightly."
  exit 0
fi
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "sync-upstream: $PWD has uncommitted changes." >&2; exit 1; }

git fetch --quiet "$push_remote" nightly
git merge --quiet --ff-only FETCH_HEAD

# The update feed names the nightly upstream's own installs are offered right now.
tag="$(curl -fsSL --retry 3 "$upstream/releases/download/update-feed/nightly.json" |
  node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).tag_name')"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]] || { echo "sync-upstream: unexpected upstream nightly tag '$tag'." >&2; exit 1; }
git fetch --quiet --no-tags "$upstream" "refs/tags/$tag"
commit="$(git rev-parse 'FETCH_HEAD^{commit}')"
if git merge-base --is-ancestor "$commit" HEAD; then
  exit 0
fi

if ! git merge --quiet --no-edit -m "Merge upstream nightly $tag" "$commit" > /dev/null 2>&1; then
  if ! left="$(node .github/fork/resolve-generated.mjs)"; then
    echo "Upstream nightly $tag conflicts with the fork in $PWD: $(echo "$left" | tr '\n' ' '). Resolve, commit and push to $push_remote nightly."
    exit 0
  fi
  git -c core.hooksPath=/dev/null commit --quiet --no-edit
fi
git push --quiet "$push_remote" HEAD:nightly
