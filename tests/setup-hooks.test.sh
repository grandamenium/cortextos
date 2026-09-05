#!/usr/bin/env bash

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

new_repo() {
  local repo="$1"
  mkdir -p "$repo/scripts/hooks"
  cp "$ROOT/scripts/setup-hooks.sh" "$repo/scripts/setup-hooks.sh"
  cp "$ROOT/scripts/hooks/pre-push" "$repo/scripts/hooks/pre-push"
  git -C "$repo" init -q
  git -C "$repo" add scripts
  git -C "$repo" -c user.name=Test -c user.email=test@example.com commit -qm fixture
}

hooks_dir() {
  local repo="$1"
  git -C "$repo" rev-parse --path-format=absolute --git-path hooks
}

repo="$TMP/normal"
new_repo "$repo"
out="$(cd "$repo" && bash scripts/setup-hooks.sh)"
dest="$(hooks_dir "$repo")/pre-push"
[[ -x "$dest" && "$out" == *"HOOK_STATUS=installed"* ]] \
  || { echo "FAIL: normal clone did not install an executable hook"; fails=1; }

chmod -x "$dest"
out="$(cd "$repo" && bash scripts/setup-hooks.sh)"
[[ -x "$dest" && "$out" == *"HOOK_STATUS=ready"* ]] \
  || { echo "FAIL: identical non-executable hook was not repaired"; fails=1; }

printf '#!/usr/bin/env bash\necho custom\n' > "$dest"
chmod +x "$dest"
cp "$dest" "$TMP/custom-hook.before"
out="$(cd "$repo" && bash scripts/setup-hooks.sh)"
[[ "$out" == *"HOOK_STATUS=preserved-existing"* ]] && cmp -s "$dest" "$TMP/custom-hook.before" \
  || { echo "FAIL: custom hook was not preserved"; fails=1; }

rm "$dest"
ln -s "$TMP/missing-hook-target" "$dest"
out="$(cd "$repo" && bash scripts/setup-hooks.sh)"
[[ -L "$dest" && "$out" == *"HOOK_STATUS=preserved-existing"* ]] \
  || { echo "FAIL: broken-symlink hook was not preserved"; fails=1; }

missing="$TMP/missing-source"
new_repo "$missing"
rm "$missing/scripts/hooks/pre-push"
out="$(cd "$missing" && bash scripts/setup-hooks.sh 2>"$TMP/missing-source.err")"
missing_dest="$(hooks_dir "$missing")/pre-push"
missing_err="$(<"$TMP/missing-source.err")"
[[ ! -e "$missing_dest" && "$out" == *"HOOK_STATUS=source-missing"* && "$missing_err" == *"hook source not found"* ]] \
  || { echo "FAIL: missing hook source was not reported without installing"; fails=1; }

race="$TMP/race"
new_repo "$race"
race_dest="$(hooks_dir "$race")/pre-push"
fakebin="$TMP/fakebin"
mkdir -p "$fakebin"
real_ln="$(command -v ln)"
printf '#!/usr/bin/env bash\nprintf "#!/usr/bin/env bash\\necho raced\\n" > "$2"\nchmod +x "$2"\nexec %q "$@"\n' "$real_ln" > "$fakebin/ln"
chmod +x "$fakebin/ln"
out="$(cd "$race" && PATH="$fakebin:$PATH" bash scripts/setup-hooks.sh)"
[[ "$out" == *"HOOK_STATUS=preserved-existing"* && "$(<"$race_dest")" == *"echo raced"* ]] \
  || { echo "FAIL: concurrently created hook was overwritten"; fails=1; }

no_links="$TMP/no-hard-links"
new_repo "$no_links"
no_links_dest="$(hooks_dir "$no_links")/pre-push"
no_links_bin="$TMP/no-links-bin"
mkdir -p "$no_links_bin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$no_links_bin/ln"
chmod +x "$no_links_bin/ln"
out="$(cd "$no_links" && PATH="$no_links_bin:$PATH" bash scripts/setup-hooks.sh)"
[[ -x "$no_links_dest" && "$out" == *"HOOK_STATUS=installed"* ]] \
  || { echo "FAIL: no-clobber fallback did not install without hard links"; fails=1; }

custom="$TMP/custom"
new_repo "$custom"
git -C "$custom" config core.hooksPath .githooks
out="$(cd "$custom" && bash scripts/setup-hooks.sh)"
custom_dest="$(hooks_dir "$custom")/pre-push"
[[ -x "$custom_dest" && "$out" == *"HOOK_STATUS=installed"* ]] \
  || { echo "FAIL: core.hooksPath was not respected"; fails=1; }

parent="$TMP/parent"
new_repo "$parent"
git -C "$parent" branch linked
linked="$TMP/linked"
git -C "$parent" worktree add -q "$linked" linked
out="$(cd "$linked" && bash scripts/setup-hooks.sh)"
linked_dest="$(hooks_dir "$linked")/pre-push"
[[ -x "$linked_dest" && "$out" == *"HOOK_STATUS=installed"* ]] \
  || { echo "FAIL: linked worktree did not resolve the effective hooks directory"; fails=1; }

if [[ "$fails" -eq 0 ]]; then
  echo "setup-hooks.test: PASS"
else
  echo "setup-hooks.test: FAIL"
  exit 1
fi
