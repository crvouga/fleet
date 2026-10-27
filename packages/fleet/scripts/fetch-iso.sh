#!/usr/bin/env bash
# Legacy download of the 14-day Actions artifact. Needs gh and a git checkout.
# A new machine uses scripts/fleet-node.sh instead. That file is one download,
# it does not use this artifact, and it does not need Nix or a checkout.
# FLEET_GH overrides gh in tests.
set -euo pipefail

out=${1:-fleet-installer.iso}
case "$out" in /*) ;; *) out="$(pwd)/$out" ;; esac
gh=${FLEET_GH:-gh}
root=$(git rev-parse --show-toplevel)
cd "$root"

# A green Fleet gate can have skipped every build; a failed publication can
# still have a tested ISO. Select the newest unexpired artifact built on main
# in this repository, never an arbitrary PR's image.
run=$("$gh" api 'repos/{owner}/{repo}/actions/artifacts?name=fleet-installer&per_page=100' \
  --jq '[.artifacts[] | select(.expired == false and .workflow_run.head_branch == "main" and .workflow_run.head_repository_id == .workflow_run.repository_id)] | first | .workflow_run.id')
if [ -z "$run" ] || [ "$run" = null ]; then
  echo 'No unexpired fleet-installer artifact from main. Run the Fleet workflow on main to build one.' >&2
  exit 1
fi

dir=$(mktemp -d)
cleanup() { rm -rf "$dir"; }
trap cleanup EXIT
"$gh" run download "$run" --name fleet-installer --dir "$dir"

iso=""
while IFS= read -r candidate; do
  iso=$candidate
  break
done < <(find "$dir" -type f -name 'fleet-installer.iso')
if [ -z "$iso" ]; then
  echo 'The Fleet artifact did not contain fleet-installer.iso' >&2
  exit 1
fi
cp "$iso" "$out"
echo "$out"
