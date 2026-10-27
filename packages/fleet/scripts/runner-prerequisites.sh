#!/usr/bin/env bash
# Executed by ExecStartPre as the slot user, after the upstream workdir setup.
# Deliberately inherit PATH: absolute tool paths would hide a broken job PATH.
set -euo pipefail
status=${FLEET_PREREQUISITE_STATUS:?runner prerequisite status path is required}
stage=filesystem
work=""
record() {
  printf '%s\n' "$1" > "$status.new"
  mv -f "$status.new" "$status"
}
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    record "failed:$stage"
    printf 'FLEET_RUNNER_PREREQUISITE_FAILED: %s; repair the CI closure through Git.\n' "$stage" >&2
  fi
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  exit "$result"
}
trap finish EXIT
record checking
for tool in bash git gh nix; do
  stage="tool:$tool"
  command -v "$tool"
  "$tool" --version
done
# Run the shell by name just as a workflow does, without a login profile.
stage=tool:bash
bash --noprofile --norc -euo pipefail -c 'test -n "$BASH_VERSION"'
stage=filesystem
work=$(mktemp -d "$PWD/.fleet-prerequisites.XXXXXX")
cd "$work"
printf 'fleet runner probe\n' > target
ln -s target link
test -L link
test "$(cat link)" = 'fleet runner probe'
# Exercise paths longer than Windows MAX_PATH, with legal Linux components.
component=$(printf '%0100d' 0)
deep="$component/$component/$component"
mkdir -p "$deep"
printf 'long path\n' > "$deep/probe"
test "$(cat "$deep/probe")" = 'long path'
stage=checkout
git init --quiet source
cp target source/target
ln -s target source/link
mkdir -p "source/$deep"
cp "$deep/probe" "source/$deep/probe"
git -C source add .
git -C source -c user.name=Fleet -c user.email=fleet@localhost \
  -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet -m 'Runner prerequisite probe'
git clone --quiet --no-hardlinks source checkout
test -L checkout/link
test "$(cat checkout/link)" = 'fleet runner probe'
test "$(cat "checkout/$deep/probe")" = 'long path'
record ok
printf 'FLEET_RUNNER_PREREQUISITES_OK: tools, symlinks, long paths and Git checkout verified.\n'
