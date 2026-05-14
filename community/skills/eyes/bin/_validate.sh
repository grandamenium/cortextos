# Shared validation block — sourced into see-diff.sh + screen-question.sh.
# Validates OLLAMA_HOST against an SSRF allow-list and file-path args against
# workspace scoping. Designed to be drop-in: relies on bash variables already
# set by the caller (OLLAMA_HOST, REF, TARGET_FILE, etc.).

# F1: SSRF allow-list on --ollama-host. Allow only loopback hosts unless
# EYES_ALLOW_REMOTE_OLLAMA=1 is explicitly set in the environment.
__validate_ollama_host() {
  local host="$1"
  # Parse URL: must be http(s)://host[:port]/...
  if ! [[ "$host" =~ ^https?://([A-Za-z0-9._:-]+)(/.*)?$ ]]; then
    echo "{\"verdict\":\"error\",\"error\":\"--ollama-host must be http(s)://...; got: $host\"}" >&2
    return 1
  fi
  local hostport="${BASH_REMATCH[1]}"
  local host_only="${hostport%:*}"
  # Strip IPv6 brackets if present
  host_only="${host_only#[}"; host_only="${host_only%]}"
  if [ "${EYES_ALLOW_REMOTE_OLLAMA:-0}" = "1" ]; then
    return 0
  fi
  case "$host_only" in
    127.0.0.1|::1|localhost) return 0 ;;
    *)
      echo "{\"verdict\":\"error\",\"error\":\"--ollama-host '$host_only' not in loopback allow-list; set EYES_ALLOW_REMOTE_OLLAMA=1 to override\"}" >&2
      return 1 ;;
  esac
}

# F2: workspace scoping on file-path inputs. Resolve to realpath, reject if
# outside the allowed prefixes ($EYES_WORKSPACE, /tmp, current cwd). Reject
# .. traversal and symlink-escapes via realpath canonicalization.
__validate_workspace_path() {
  local label="$1" path="$2"
  if [ ! -e "$path" ]; then
    echo "{\"verdict\":\"error\",\"error\":\"$label '$path' does not exist\"}" >&2
    return 1
  fi
  # realpath canonicalizes + resolves symlinks; macOS realpath is in coreutils
  # but we fall back to python if not available.
  local real
  if command -v realpath >/dev/null 2>&1; then
    real=$(realpath "$path" 2>/dev/null) || real=""
  fi
  if [ -z "$real" ]; then
    real=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$path")
  fi
  local cwd; cwd=$(realpath . 2>/dev/null || python3 -c "import os; print(os.path.realpath('.'))")
  local ws="${EYES_WORKSPACE:-}"
  # Accept if real path EQUALS /tmp or /private/tmp itself OR is a subpath.
  # macOS /tmp -> /private/tmp via symlink; realpath returns /private/tmp.
  case "$real" in
    /tmp|/private/tmp|/tmp/*|/private/tmp/*) return 0 ;;
  esac
  if [ -n "$ws" ]; then
    case "$real" in "$ws"/*|"$ws") return 0 ;; esac
  fi
  case "$real" in
    "$cwd"/*|"$cwd") return 0 ;;
  esac
  echo "{\"verdict\":\"error\",\"error\":\"$label '$path' (real: $real) outside workspace; allowed: /tmp, /private/tmp, \$EYES_WORKSPACE, cwd. Set EYES_WORKSPACE to widen.\"}" >&2
  return 1
}
