#!/usr/bin/env python3
"""Tests for codex-to-claude-migration: MCP secret handling (convict + acquit), the
full detect -> convert --apply -> verify path on a synthetic codex agent, dry-run
writes nothing, the source is never modified, and verify's leak gate catches a
planted secret. HOME and PATH are sandboxed: no real ~/.codex, ~/.claude.json or
`cortextos` binary is touched. All names, tokens and ids are synthetic."""

import hashlib, importlib.util, json, os, re, shutil, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts")
sys.path.insert(0, SCRIPTS)


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(SCRIPTS, f"{name}.py")
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


detect = load("detect")
convert = load("convert")
verify = load("verify")

P = F = 0


def ok(cond, label):
    global P, F
    if cond:
        P += 1
        print(f"  PASS {label}")
    else:
        F += 1
        print(f"  FAIL {label}")


SECRET = "ntn_FAKEsecret0123456789abcdefXYZ"  # synthetic
BEARER_SECRET = "sk-fake-0123456789abcdefghijkl"  # synthetic
CODEX_TOML = f'''
model = "gpt-5-codex"
[mcp_servers.notes]
command = "npx"
args = ["-y", "notes-mcp", "--api-key", "{BEARER_SECRET}"]
[mcp_servers.notes.env]
NOTES_HEADERS = "{{\\"Authorization\\": \\"Bearer {SECRET}\\"}}"
LOG_LEVEL = "info"
[mcp_servers.remote]
url = "https://mcp.example.com/mcp?api_key={SECRET}&mode=x"
bearer_token_env_var = "REMOTE_TOKEN"
[mcp_servers.remote.env_http_headers]
X-Org = "REMOTE_ORG"
[mcp_servers.internal]
command = "/Applications/Codex.app/Contents/Resources/node_repl"
[mcp_servers.internal.env]
CODEX_HOME = "/tmp/x"
[mcp_servers.off]
command = "off-mcp"
enabled = false
[mcp_servers.shared]
url = "https://shared.example.com/mcp"
'''

# ---------- MCP planning: secrets become references, never values ----------
print("[mcp] plan_mcp_server")
import tomllib

servers = tomllib.loads(CODEX_TOML)["mcp_servers"]
plans = {n: detect.plan_mcp_server(n, s, {"shared"}) for n, s in servers.items()}
blob = json.dumps(plans)
ok(
    SECRET not in blob and BEARER_SECRET not in blob,
    "no inline secret value anywhere in the plans",
)
e = plans["notes"]["entry"]
ok(
    e["env"]["NOTES_HEADERS"] == "${NOTES_NOTES_HEADERS}"
    or e["env"]["NOTES_HEADERS"] == "${NOTES_HEADERS}",
    "inline secret env -> ${VAR} reference",
)
ok(
    e["env"]["LOG_LEVEL"].startswith("${"),
    "default-deny: non-secret env value also a reference",
)
ok(
    e["args"][:3] == ["-y", "notes-mcp", "--api-key"] and e["args"][3].startswith("${"),
    "secret arg after --api-key -> reference; plain args kept",
)
ok(
    "[mcp_servers.notes.env].NOTES_HEADERS" in plans["notes"]["inline_secrets"],
    "inline secret FINDING raised",
)
ok(
    "[mcp_servers.notes.env].LOG_LEVEL" not in plans["notes"]["inline_secrets"],
    "ACQUIT: LOG_LEVEL=info not reported as a secret",
)
r = plans["remote"]["entry"]
ok(
    r["headers"]["Authorization"] == "Bearer ${REMOTE_TOKEN}",
    "bearer_token_env_var -> Authorization header ref",
)
ok(r["headers"]["X-Org"] == "${REMOTE_ORG}", "env_http_headers -> header ref")
ok(
    "api_key=${" in r["url"] and "mode=x" in r["url"],
    "secret url query value -> reference, others kept",
)
ok(
    plans["internal"]["action"] == "skip-codex-internal",
    "Codex-desktop-internal server skipped",
)
ok(plans["off"]["action"] == "skip-disabled", "enabled=false server skipped")
ok(
    plans["shared"]["action"] == "skip-claude-user-scope",
    "server already at Claude user scope skipped",
)
ok(
    detect.mcp_var_name("notion", "NOTION_TOKEN") == "NOTION_TOKEN"
    and detect.mcp_var_name("notion", "OPENAPI_MCP_HEADERS")
    == "NOTION_OPENAPI_MCP_HEADERS",
    "env var names namespaced by server without double prefix",
)

# ---------- default model: Opus (owner decision) ----------
print("[model] resolve_model")
_acts = []
ok(convert.resolve_model(None, [("best", "claude-fable-9"), ("best", "claude-opus-9-9"),
                                ("strong", "claude-opus-9")], _acts) == "claude-opus-9-9",
   "no --model: best-tier claude-opus-* wins over an earlier best-tier id")
ok(convert.resolve_model(None, [("best", "claude-fable-9"), ("strong", "claude-opus-9")], _acts)
   == "claude-opus-9", "no best-tier opus: any-tier claude-opus-* still preferred")
_acts = []
ok(convert.resolve_model(None, [("best", "opus"), ("best", "claude-fable-9")], _acts) == "claude-fable-9"
   and any("NEEDS-HUMAN" in a for a in _acts), "no opus id at all: best-tier fallback, flagged")
ok(convert.resolve_model("claude-sonnet-9", [("best", "claude-opus-9-9")], []) == "claude-sonnet-9",
   "--model overrides the Opus default")
ok(convert.resolve_model(None, [], []) is None, "empty list-models: model left unset")

# ---------- verify helpers: convict + acquit ----------
print("[verify] mcp_refs_only + find_leaks")
ok(
    verify.mcp_refs_only(
        {
            "mcpServers": {
                "a": {"env": {"K": "${K}"}, "headers": {"Authorization": "Bearer ${T}"}}
            }
        }
    )
    == [],
    "ACQUIT: refs-only .mcp.json passes",
)
ok(
    verify.mcp_refs_only({"mcpServers": {"a": {"env": {"K": SECRET}}}}) == ["a.env.K"],
    "CONVICT: literal value in .mcp.json flagged",
)

# ---------- end-to-end on a synthetic codex agent ----------
print("[e2e] detect -> convert (dry-run, apply) -> verify")
tmp = tempfile.mkdtemp()
old_env = dict(os.environ)
try:
    home = os.path.join(tmp, "home")
    os.makedirs(os.path.join(home, ".codex"))
    open(os.path.join(home, ".codex", "config.toml"), "w").write(CODEX_TOML)
    json.dump(
        {
            "mcpServers": {
                "shared": {"type": "http", "url": "https://shared.example.com/mcp"}
            }
        },
        open(os.path.join(home, ".claude.json"), "w"),
    )
    bindir = os.path.join(tmp, "bin")
    os.makedirs(bindir)
    fake = os.path.join(bindir, "cortextos")
    open(fake, "w").write(
        "#!/bin/sh\n[ \"$2\" = list-models ] && printf 'best      opus\\nbest      claude-test-9\\nbest      claude-opus-9-9\\nstrong    claude-opus-9\\nfast      claude-mini-1\\n'\nexit 0\n"
    )
    os.chmod(fake, 0o755)
    env = dict(os.environ, HOME=home, PATH=bindir + os.pathsep + os.environ["PATH"])

    agents = os.path.join(tmp, "orgs", "acme", "agents")
    src = os.path.join(agents, "alpha-codex")
    tgt = os.path.join(agents, "alpha-claude")
    ctx = os.path.join(tmp, "ctx")
    sk = os.path.join(src, "plugins", "cortextos-agent-skills", "skills")
    os.makedirs(os.path.join(sk, "heartbeat"))
    open(os.path.join(sk, "heartbeat", "SKILL.md"), "w").write("hb")
    os.makedirs(os.path.join(sk, "digest", "scripts"))
    open(os.path.join(sk, "digest", "SKILL.md"), "w").write(
        "Run plugins/cortextos-agent-skills/skills/digest/scripts/run.sh\n"
    )
    open(os.path.join(sk, "digest", "scripts", "run.sh"), "w").write("echo ok\n")
    os.makedirs(os.path.join(sk, "leaky", "scripts"))
    open(os.path.join(sk, "leaky", "SKILL.md"), "w").write("leaky\n")
    open(os.path.join(sk, "leaky", "scripts", "go.sh"), "w").write(
        "codex exec 'do it'\n"
    )
    os.makedirs(os.path.join(src, ".agents", "skills", "repo-skill"))
    open(os.path.join(src, ".agents", "skills", "repo-skill", "SKILL.md"), "w").write(
        "repo\n"
    )
    os.makedirs(os.path.join(src, "memory"))
    open(os.path.join(src, "memory", "MEMORY.md"), "w").write("m\n")
    os.makedirs(os.path.join(src, ".venv-x", "bin"))
    open(os.path.join(src, "AGENTS.md"), "w").write(
        "# Agent (codex-app-server runtime)\nRead plugins/cortextos-agent-skills/skills/digest/SKILL.md\n"
    )
    open(os.path.join(src, "IDENTITY.md"), "w").write("You are a codex agent.\n")
    open(os.path.join(src, ".env"), "w").write(
        "BOT_TOKEN=123:FAKE\nCHAT_ID=1000000000\nALLOWED_USER=1000000000\n"
    )
    json.dump(
        {
            "agent_name": "alpha-codex",
            "enabled": True,
            "runtime": "codex-app-server",
            "model": "gpt-5-codex",
            "codex_context_cap": 256000,
            "timezone": "UTC",
            "ctx_handoff_threshold": 85,
            "working_directory": "",
            "crons": [
                {
                    "name": "digest",
                    "type": "recurring",
                    "interval": "24h",
                    "enabled": True,
                    "prompt": "cd orgs/acme/agents/alpha-codex && bash plugins/cortextos-agent-skills/skills/digest/scripts/run.sh",
                },
                {
                    "name": "paused",
                    "type": "recurring",
                    "interval": "4h",
                    "prompt": "p",
                },
            ],
        },
        open(os.path.join(src, "config.json"), "w"),
        indent=2,
    )
    regd = os.path.join(ctx, ".cortextOS", "state", "agents", "alpha-codex")
    os.makedirs(regd)
    json.dump(
        {
            "crons": [
                {"name": "paused", "schedule": "4h", "enabled": False, "prompt": "p"},
                {
                    "name": "regonly",
                    "schedule": "0 9 * * *",
                    "enabled": True,
                    "prompt": "r",
                },
            ]
        },
        open(os.path.join(regd, "crons.json"), "w"),
    )
    sstate = os.path.join(ctx, "state", "alpha-codex")
    os.makedirs(sstate)
    for fn in (".onboarded", "codex-app-server-thread.json", "heartbeat.json"):
        open(os.path.join(sstate, fn), "w").write("{}")

    def tree_hash(root):
        h = hashlib.sha256()
        for dp, dn, fns in sorted(os.walk(root)):
            dn.sort()
            for fn in sorted(fns):
                fp = os.path.join(dp, fn)
                h.update(fp.encode())
                h.update(open(fp, "rb").read())
        return h.hexdigest()

    src_before = tree_hash(src)
    reg_before = tree_hash(regd)

    man = os.path.join(tmp, "manifest.json")
    r = subprocess.run(
        [
            sys.executable,
            os.path.join(SCRIPTS, "detect.py"),
            "--src-dir",
            src,
            "--ctx-root",
            ctx,
            "--agent",
            "alpha-codex",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    ok(r.returncode == 0, f"detect exit 0 ({r.stderr[-200:]})")
    open(man, "w").write(r.stdout)
    m = json.loads(r.stdout)
    ok(
        SECRET not in r.stdout and BEARER_SECRET not in r.stdout,
        "manifest carries no secret value",
    )
    ok(
        {s["name"]: s["disposition"] for s in m["skills"]["custom"]}
        == {"digest": "transform", "leaky": "needs_human", "repo-skill": "transform"},
        "skills classified: clean custom, codex-leaky, .agents/skills repo skill",
    )
    ok(
        any(n["name"] == ".venv-x" for n in m["buckets"]["not_carried"]),
        "virtualenv not carried",
    )
    ok(
        "IDENTITY.md" in m["instructions"]["codex_wording_lines"],
        "codex wording in IDENTITY.md flagged",
    )

    # skeleton the way add-agent lays it (minimal)
    os.makedirs(os.path.join(tgt, ".claude", "skills", "heartbeat"))
    open(os.path.join(tgt, ".claude", "skills", "heartbeat", "SKILL.md"), "w").write(
        "hb"
    )
    json.dump(
        {"hooks": {"Stop": []}, "permissions": {}},
        open(os.path.join(tgt, ".claude", "settings.json"), "w"),
    )
    json.dump(
        {
            "agent_name": "alpha-claude",
            "enabled": True,
            "runtime": "claude-code",
            "crons": [],
        },
        open(os.path.join(tgt, "config.json"), "w"),
    )
    open(os.path.join(tgt, "CLAUDE.md"), "w").write("# template claude md\n")
    os.makedirs(os.path.join(ctx, "config"))
    json.dump(
        {"alpha-codex": {"enabled": True}, "alpha-claude": {"enabled": True}},
        open(os.path.join(ctx, "config", "enabled-agents.json"), "w"),
    )
    tgt_before = tree_hash(tgt)

    base = [
        sys.executable,
        os.path.join(SCRIPTS, "convert.py"),
        "--manifest",
        man,
        "--src-dir",
        src,
        "--target-dir",
        tgt,
        "--target-agent",
        "alpha-claude",
        "--ctx-root",
        ctx,
    ]
    r = subprocess.run(base, capture_output=True, text=True, env=env)
    ok(r.returncode == 0, f"dry-run convert exit 0 ({r.stderr[-300:]})")
    ok(
        tree_hash(tgt) == tgt_before
        and not os.path.exists(os.path.join(ctx, "state", "alpha-claude")),
        "DRY-RUN writes nothing (target + state unchanged)",
    )
    ok(
        json.loads(r.stdout)["model"] == "claude-opus-9-9",
        "default model = best-tier claude-opus-* id, not the first best-tier id",
    )

    r = subprocess.run(base + ["--apply"], capture_output=True, text=True, env=env)
    ok(r.returncode == 0, f"apply convert exit 0 ({r.stderr[-300:]})")
    out = json.loads(r.stdout)
    ok(
        tree_hash(src) == src_before and tree_hash(regd) == reg_before,
        "SOURCE agent + its cron registry untouched",
    )
    cfg = json.load(open(os.path.join(tgt, "config.json")))
    ok(
        cfg["runtime"] == "claude-code"
        and cfg["model"] == "claude-opus-9-9"
        and "codex_context_cap" not in cfg
        and cfg["ctx_handoff_threshold"] == 85
        and cfg["enabled"] is False and cfg["telegram_polling"] is False,
        "config transformed + knobs carried + disabled",
    )
    by = {c["name"]: c for c in cfg["crons"]}
    ok(set(by) == {"digest", "paused", "regonly"}, "cron UNION of config + registry")
    ok(
        by["paused"]["type"] == "disabled" and by["digest"]["type"] == "recurring"
        and all(set(c) <= convert.CRON_CONFIG_KEYS for c in cfg["crons"])
        and by["regonly"].get("cron") == "0 9 * * *",
        "registry-disabled cron stays disabled",
    )
    ok(
        "agents/alpha-claude" in by["digest"]["prompt"]
        and ".claude/skills/digest" in by["digest"]["prompt"],
        "cron prompt: workspace + skills path translated",
    )
    ok(
        open(os.path.join(tgt, "CLAUDE.md")).read() == "@AGENTS.md\n",
        "CLAUDE.md is the one-line import",
    )
    ok(
        ".claude/skills/digest" in open(os.path.join(tgt, "AGENTS.md")).read(),
        "AGENTS.md skill paths rewritten",
    )
    ok(
        os.path.isfile(
            os.path.join(tgt, ".claude", "skills", "digest", "scripts", "run.sh")
        )
        and os.path.isfile(
            os.path.join(tgt, ".claude", "skills", "repo-skill", "SKILL.md")
        ),
        "custom skills (plugins + .agents/skills) copied into .claude/skills",
    )
    ok(
        not os.path.exists(os.path.join(tgt, ".claude", "skills", "leaky")),
        "codex-leaky skill NOT copied",
    )
    ok(
        not os.path.exists(os.path.join(tgt, "plugins"))
        and not os.path.exists(os.path.join(tgt, ".agents"))
        and not os.path.exists(os.path.join(tgt, ".venv-x")),
        "no codex layout or venv in target",
    )
    envtxt = open(os.path.join(tgt, ".env")).read()
    ok(
        "BOT_TOKEN" not in envtxt and "CHAT_ID=1000000000" in envtxt,
        ".env carried without BOT_TOKEN",
    )
    ok(
        stat.S_IMODE(os.stat(os.path.join(tgt, ".env")).st_mode) == 0o600,
        ".env is 0600",
    )
    mcp = json.load(open(os.path.join(tgt, ".mcp.json")))
    ok(
        set(mcp["mcpServers"]) == {"notes", "remote"},
        ".mcp.json has only migratable servers",
    )
    alltxt = "".join(
        open(os.path.join(dp, fn), errors="ignore").read()
        for dp, _, fns in os.walk(tgt)
        for fn in fns
    )
    ok(
        SECRET not in alltxt and BEARER_SECRET not in alltxt,
        "NO secret value in ANY target file",
    )
    ok(
        json.load(open(os.path.join(tgt, ".claude", "settings.json"))).get(
            "enableAllProjectMcpServers"
        )
        is True,
        "project MCP servers enabled in settings",
    )
    ok(
        {v["var"] for v in out["env_vars"]} >= {"REMOTE_TOKEN", "REMOTE_ORG"},
        "env vars to set are listed",
    )
    tstate = os.path.join(ctx, "state", "alpha-claude")
    ok(
        os.path.isfile(os.path.join(tstate, ".onboarded"))
        and os.path.isfile(os.path.join(tstate, ".force-fresh"))
        and not os.path.exists(os.path.join(tstate, "codex-app-server-thread.json")),
        "state: .onboarded carried, .force-fresh dropped, codex thread excluded",
    )
    regj = json.load(open(os.path.join(ctx, "config", "enabled-agents.json")))
    ok(
        regj["alpha-claude"]["enabled"] is False
        and regj["alpha-codex"]["enabled"] is True,
        "registry: target disabled, source untouched",
    )

    vcmd = [
        sys.executable,
        os.path.join(SCRIPTS, "verify.py"),
        "--target-dir",
        tgt,
        "--target-agent",
        "alpha-claude",
        "--ctx-root",
        ctx,
        "--source-dir",
        src,
        "--source-agent",
        "alpha-codex",
    ]
    r = subprocess.run(vcmd, capture_output=True, text=True, env=env)
    ok(
        r.returncode == 0,
        "verify passes on the converted agent"
        + ("" if r.returncode == 0 else "\n" + r.stdout),
    )
    ok(SECRET not in r.stdout, "verify output never prints a secret value")

    # NEGATIVE: plant the secret in a target file -> leak gate fails, location reported
    open(os.path.join(tgt, "memory", "notes.md"), "w").write(f"oops {SECRET}\n")
    r = subprocess.run(vcmd, capture_output=True, text=True, env=env)
    ok(
        r.returncode == 1
        and "[mcp_servers.notes.env].NOTES_HEADERS" in r.stdout
        and SECRET not in r.stdout,
        "CONVICT: planted secret caught by location, value not printed",
    )
    os.remove(os.path.join(tgt, "memory", "notes.md"))

    # refuses in-place conversion
    r = subprocess.run(
        base[:5] + ["--target-dir", src] + base[7:] + ["--apply"],
        capture_output=True,
        text=True,
        env=env,
    )
    ok(
        r.returncode == 2 and tree_hash(src) == src_before,
        "refuses target == source (never in place)",
    )
finally:
    os.environ.clear()
    os.environ.update(old_env)
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- leakage guard over the shipped skill ----------
print("[leak] no real chat-id / token literals in shipped files")
root = os.path.dirname(HERE)
hits = []
for dp, dn, fns in os.walk(root):
    dn[:] = [d for d in dn if not d.startswith(".") and d != "__pycache__"]
    for fn in fns:
        fp = os.path.join(dp, fn)
        if fp == os.path.abspath(__file__):
            continue
        txt = open(fp, errors="ignore").read()
        for mm in re.finditer(r"send-(?:telegram|message)\s+(-?\d{7,})", txt):
            d = mm.group(1).lstrip("-")
            if not d.endswith("0000"):
                hits.append(f"{fn}:{d}")
        for mm in re.finditer(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b", txt):
            hits.append(f"{fn}:bot-token-shape")
ok(hits == [], f"no hardcoded chat-id or bot token in shipped files ({hits})")

print(f"\n=== {P} passed, {F} failed ===")
sys.exit(1 if F else 0)
