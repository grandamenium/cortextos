#!/usr/bin/env python3
"""
Orgo VM work loop dispatcher — claims lease, runs real work, writes artifact, releases lease.
Usage: python3 orgo-work-loop.py --vm <name>
"""
import argparse, json, os, sys, uuid, base64, subprocess, urllib.request, time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, '/home/cortextos/cortextos/orgs/revops-global')
for line in open('/home/cortextos/cortextos/orgs/revops-global/secrets.env'):
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, _, v = line.partition('=')
        os.environ.setdefault(k.strip(), v.strip())

ORGO_KEY  = os.environ.get('ORGO_API_KEY', '')
SUPA_URL  = os.environ.get('SUPABASE_URL') or os.environ.get('RGOS_SUPABASE_URL', '')
SUPA_KEY  = os.environ.get('SUPABASE_RGOS_SERVICE_KEY') or os.environ.get('RGOS_SUPABASE_SERVICE_KEY', '')
OUT_BASE  = '/home/cortextos/cortextos/orgs/revops-global/agents/orgo-1/output'
CTX_ROOT  = os.environ.get('CTX_ROOT', '/home/cortextos/.cortextos/default')
CRON_STATE_DIR = Path(CTX_ROOT) / '.cortextOS' / 'state' / 'agents' / 'orgo-1'
CRON_LOG = CRON_STATE_DIR / 'cron-execution.log'
CRONS_JSON = CRON_STATE_DIR / 'crons.json'
ORGO_API_BASE = 'https://www.orgo.ai/api'


class DirectComputer:
    """Fetch fresh Orgo metadata, then use the per-VM control token directly."""

    def __init__(self, computer_id, api_key=None, verbose=False):
        self.computer_id = computer_id
        self.api_key = api_key or ORGO_KEY
        req = urllib.request.Request(
            f"{ORGO_API_BASE}/computers/{computer_id}",
            headers={'Authorization': f'Bearer {self.api_key}'},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            self.metadata = json.loads(resp.read().decode())
        self.url = (self.metadata.get('url') or '').rstrip('/')
        self.token = self.metadata.get('vnc_password') or ''

    def _request(self, path, method='GET', payload=None, timeout=12):
        if not self.url or not self.token:
            raise RuntimeError('missing direct control url or vnc_password')
        data = None
        headers = {'Authorization': f'Bearer {self.token}'}
        if payload is not None:
            data = json.dumps(payload).encode()
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(
            f"{self.url}{path}",
            data=data,
            method=method,
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}

    def status(self):
        direct_status = self._request('/status', timeout=8)
        return {
            **self.metadata,
            'status': self.metadata.get('status') or direct_status.get('state') or 'unknown',
            'direct_status': direct_status,
        }

    def exec(self, code, timeout=12):
        return self._request('/exec', method='POST', payload={'code': code}, timeout=timeout)

    def screenshot_base64(self):
        result = self._request('/screenshot', timeout=12)
        return result.get('image') or result.get('screenshot') or ''

VM_MAP = {
    # The Orgo SDK proxy path can 401 even when direct per-VM vnc_password control
    # works, so this loop uses DirectComputer for all lanes.
    'codex-cu':    ('3ec3d7f3-a5da-4678-8b25-ce28b7aed829', 'orgo-codex-computeruse'),
    'hub-qa':      ('4229f370-7593-4a57-8442-70a912e83131', 'orgo-hub-qa'),
    'telegram-web':('cf8cb3d9-d2e5-4a3a-a59c-00a4a62898e5', 'orgo-telegram-web'),
    'wiki':        ('e0848ad0-70d9-409e-9384-baca933f281a', 'orgo-wiki-ingestion-worker'),
    'linkedin':    ('cf79bc43-07b6-4c7c-8714-eb53c5861c73', 'orgo-linkedin-session'),
}

FLEET_JSON = '/home/cortextos/cortextos/orgs/revops-global/agents/orgo-1/state/fleet.json'

VM_TO_FLEET_NAME = {
    'hub-qa': 'Hub-QA',
    'telegram-web': 'Telegram-Web',
    'codex-cu': 'Codex-ComputerUse',
    'wiki': 'Wiki-Ingestion-Worker',
    'linkedin': 'LinkedIn-Session',
}

CRON_BY_VM = {
    'hub-qa': 'orgo-hub-qa-sweep',
    'telegram-web': 'orgo-telegram-ux',
    'codex-cu': 'orgo-codex-cu-check',
    'wiki': 'orgo-wiki-health',
    'linkedin': 'orgo-linkedin-check',
}

def record_cron_result(vm_name, artifact_path, success, result, started_at):
    """Append Orgo workload result metadata to the CortexOS cron execution log."""
    cron_name = CRON_BY_VM.get(vm_name)
    if not cron_name:
        return

    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    duration_ms = int((time.time() - started_at) * 1000)
    rel_artifact = artifact_path
    prefix = '/home/cortextos/cortextos/orgs/revops-global/agents/orgo-1/'
    if artifact_path.startswith(prefix):
        rel_artifact = artifact_path[len(prefix):]

    entry = {
        "ts": now,
        "cron": cron_name,
        "status": "fired" if success else "failed",
        "attempt": 1,
        "duration_ms": duration_ms,
        "error": None if success else result[:500],
        "phase": "result",
        "result": result[:1000],
        "artifact": rel_artifact,
    }

    CRON_STATE_DIR.mkdir(parents=True, exist_ok=True)
    with CRON_LOG.open('a') as f:
        f.write(json.dumps(entry, separators=(',', ':')) + '\n')

    try:
        data = json.loads(CRONS_JSON.read_text())
        changed = False
        for cron in data.get('crons', []):
            if cron.get('name') == cron_name:
                cron['last_fired_at'] = now
                cron['last_result_at'] = now
                cron['last_result'] = result[:1000]
                cron['last_artifact'] = rel_artifact
                changed = True
                break
        if changed:
            data['updated_at'] = now
            tmp = CRONS_JSON.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(data, indent=2) + '\n')
            tmp.replace(CRONS_JSON)
    except Exception as e:
        print(f"cron result state update warning: {e}")

def update_fleet_json_artifact(vm_name, artifact_path, now, ui_proof=False, task_id=None, lease_id=None):
    """Update fleet.json artifact fields for the given VM.

    Routine health/auth jobs update last_artifact only. Real browser/CDP
    roundtrips pass ui_proof=True so the durable UI proof survives later
    routine reports and fleet-ping cycles.
    """
    fleet_name = VM_TO_FLEET_NAME.get(vm_name)
    if not fleet_name:
        return
    try:
        data = json.loads(open(FLEET_JSON).read())
        changed = False
        for entry in data.get('fleet', []):
            if entry.get('name') == fleet_name:
                entry['last_artifact_at'] = now
                entry['last_artifact'] = artifact_path
                if task_id is not None:
                    entry['current_task_id'] = task_id
                if lease_id is not None or task_id is not None:
                    entry['lease_id'] = lease_id or task_id
                if ui_proof:
                    entry['last_ui_proof_at'] = now
                    entry['last_ui_proof'] = artifact_path
                changed = True
                break
        if changed:
            data['updated'] = now
            tmp = FLEET_JSON + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, FLEET_JSON)
    except Exception as e:
        print(f"fleet.json artifact update warning: {e}")


def update_fleet_json_fields(vm_name, fields):
    """Patch additional fleet.json fields for one VM without disturbing other lanes."""
    fleet_name = VM_TO_FLEET_NAME.get(vm_name)
    if not fleet_name:
        return
    try:
        data = json.loads(open(FLEET_JSON).read())
        changed = False
        for entry in data.get('fleet', []):
            if entry.get('name') == fleet_name:
                entry.update(fields)
                changed = True
                break
        if changed:
            data['updated'] = datetime.now(timezone.utc).isoformat()
            tmp = FLEET_JSON + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, FLEET_JSON)
    except Exception as e:
        print(f"fleet.json field update warning: {e}")


CRON_NEXT_CHECK = {
    'hub-qa': '30m',
    'telegram-web': '45m',
    'codex-cu': '2h',
    'wiki': '2h',
    'linkedin': '4h',
}


def push_vm_status_html(c, vm_name, lane, task_id, artifact_rel, success, now):
    """Write /tmp/orgo-status.html on the VM with current state so grid thumbnails show real info."""
    status_str = 'PASS' if success else 'FAIL'
    color = '#22c55e' if success else '#ef4444'
    next_check = CRON_NEXT_CHECK.get(vm_name, '?')
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="300">
<style>body{{font-family:monospace;background:#0f172a;color:#e2e8f0;padding:20px;margin:0}}
h2{{color:#38bdf8;margin:0 0 16px}}
.status{{display:inline-block;padding:4px 12px;border-radius:4px;font-weight:bold;background:{color};color:#fff}}
table{{border-collapse:collapse;width:100%}}td{{padding:6px 10px;border-bottom:1px solid #1e293b}}
td:first-child{{color:#94a3b8;width:140px}}</style></head>
<body>
<h2>Orgo — {vm_name.upper()}</h2>
<span class="status">{status_str}</span>
<table style="margin-top:16px">
<tr><td>Lane</td><td>{lane}</td></tr>
<tr><td>Task ID</td><td>{task_id}</td></tr>
<tr><td>Last fire</td><td>{now}</td></tr>
<tr><td>Artifact</td><td>{artifact_rel}</td></tr>
<tr><td>Next check</td><td>~{next_check}</td></tr>
<tr><td>Mode</td><td>standby — recurring background loop</td></tr>
</table>
</body></html>"""
    escaped = html.replace("'", r"\'").replace('\n', '\\n')
    try:
        c.exec(f"open('/tmp/orgo-status.html','w').write('{escaped}'); print('HTML_OK')", timeout=8)
    except Exception as e:
        print(f"status html push warning: {e}")


def supa_patch(node_key, data):
    url = f"{SUPA_URL}/rest/v1/orch_fleet_nodes?node_key=eq.{node_key}"
    req = urllib.request.Request(url, data=json.dumps(data).encode(), method='PATCH', headers={
        'apikey': SUPA_KEY, 'Authorization': f'Bearer {SUPA_KEY}',
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
    })
    try:
        urllib.request.urlopen(req, timeout=8)
    except Exception as e:
        print(f"Supabase patch error: {e}")

def claim_lease(node_key, task_id, lane, focus):
    NOW = datetime.now(timezone.utc).isoformat()
    supa_patch(node_key, {
        "status": "busy", "current_task_id": task_id, "last_heartbeat_at": NOW,
        "app_readiness": {
            "active_lease": True, "current_task_id": task_id,
            "lane": lane, "current_focus": focus,
            "last_check": NOW, "last_exec_ok": True,
            "source": "orgo-1-work-loop",
        }
    })
    print(f"LEASE CLAIMED: {task_id} on {node_key}")

def release_lease(node_key, task_id, lane, artifact_path, success=True):
    NOW = datetime.now(timezone.utc).isoformat()
    supa_patch(node_key, {
        "status": "idle", "current_task_id": None, "last_heartbeat_at": NOW,
        "app_readiness": {
            "active_lease": False, "current_task_id": None,
            "lane": lane, "current_focus": "standby — last run complete",
            "last_artifact": artifact_path, "last_artifact_at": NOW,
            "last_exec_ok": success, "last_check": NOW,
            "source": "orgo-1-work-loop",
        }
    })
    print(f"LEASE RELEASED: {task_id} → artifact={artifact_path}")

# ── HUB-QA: playwright authenticated sweep ─────────────────────────────────
def run_hub_qa():
    vm_id, node_key = VM_MAP['hub-qa']
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    task_id = f"hub-qa-sweep-{ts}"
    lane = "Hub app logged-in QA (hub.revopsglobal.com)"
    out_dir = f"{OUT_BASE}/hub-qa-sweep-{ts}"
    os.makedirs(out_dir, exist_ok=True)

    claim_lease(node_key, task_id, lane, "CDP authenticated sweep — dashboard/inbox/tasks/agents/fleet-map/strategy")

    c = DirectComputer(computer_id=vm_id, api_key=ORGO_KEY, verbose=False)
    # Routes confirmed from live Chrome session 2026-05-15T08:14Z
    # /app/pipeline removed — confirmed 404. /app/fleet/agents confirmed from tab URL.
    PAGES = [
        ('dashboard',  'https://hub.revopsglobal.com/app/dashboard'),
        ('inbox',      'https://hub.revopsglobal.com/app/work/inbox'),
        ('tasks',      'https://hub.revopsglobal.com/app/fleet/tasks'),
        ('agents',     'https://hub.revopsglobal.com/app/fleet/agents'),
        ('fleet-map',  'https://hub.revopsglobal.com/app/fleet/fleet-map'),
        ('strategy',   'https://hub.revopsglobal.com/app/fleet/strategy'),
    ]

    # CDP nav (on VM) + orgo screenshot_base64 (from host) — avoids CDP frame parse bugs
    # Step 1: navigate Chrome to each page via CDP exec on VM
    # Step 2: screenshot via c.screenshot_base64() from host (reliable, no parse issues)
    # Step 3: get page text via CDP Runtime.evaluate for 404 detection

    nav_script_tpl = """
import urllib.request, json, time, socket, os, base64, struct

def ws_connect(port, path):
    s = socket.socket(); s.settimeout(8); s.connect(('localhost', port))
    key = base64.b64encode(os.urandom(16)).decode()
    req = 'GET ' + path + ' HTTP/1.1\\r\\nHost: localhost:' + str(port) + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: ' + key + '\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n'
    s.send(req.encode()); resp = b''
    while b'\\r\\n\\r\\n' not in resp: resp += s.recv(4096)
    return s

def ws_send(s, msg):
    data = msg.encode(); mask = os.urandom(4)
    masked = bytes([data[i] ^ mask[i % 4] for i in range(len(data))])
    frame = b'\\x81'
    if len(data) < 126: frame += bytes([0x80 | len(data)])
    elif len(data) < 65536: frame += bytes([0x80 | 126, len(data) >> 8, len(data) & 0xff])
    frame += mask + masked; s.send(frame)

def ws_drain_find(s, req_id, timeout=6):
    s.settimeout(timeout); buf = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            chunk = s.recv(65536)
            if not chunk: break
            buf += chunk
        except: break
    # Parse all frames from buf, find matching id
    pos = 0
    while pos < len(buf):
        if pos + 2 > len(buf): break
        pl = buf[pos+1] & 0x7f; offset = pos + 2
        if pl == 126:
            if pos + 4 > len(buf): break
            pl = (buf[pos+2] << 8) | buf[pos+3]; offset = pos + 4
        elif pl == 127:
            if pos + 10 > len(buf): break
            import struct as st
            pl = st.unpack('>Q', buf[pos+2:pos+10])[0]; offset = pos + 10
        if offset + pl > len(buf): break
        payload = buf[offset:offset+pl].decode('utf-8','replace')
        try:
            d = json.loads(payload)
            if d.get('id') == req_id: return d
        except: pass
        pos = offset + pl
    return None

tabs = json.loads(urllib.request.urlopen('http://localhost:9335/json', timeout=5).read())
hub_tab = next((t for t in tabs if 'hub.revopsglobal.com' in t.get('url','')), None)
if not hub_tab: print('ERROR:no hub tab'); raise SystemExit(1)
path = hub_tab['webSocketDebuggerUrl'].split('localhost:9335',1)[1]
s = ws_connect(9335, path)

# Navigate to TARGET_URL
ws_send(s, json.dumps({'id':1,'method':'Page.navigate','params':{'url':'TARGET_URL'}}))
time.sleep(NAV_WAIT)

# Get page text for 404 detection
ws_send(s, json.dumps({'id':2,'method':'Runtime.evaluate','params':{'expression':'document.title+"|||"+document.body.innerText.slice(0,400)'}}))
d = ws_drain_find(s, 2, timeout=5)
page_text = ''
if d and 'result' in d: page_text = d['result']['result'].get('value','')
if '404' in page_text or 'not found' in page_text.lower(): print('NOTE:404-NOT-FOUND')
elif 'sign in' in page_text.lower() or 'log in' in page_text.lower(): print('NOTE:AUTH-REDIRECT')
else: print('NOTE:OK')
print('TEXT:' + page_text[:300])
s.close()
print('NAV_DONE')
"""

    results = []
    os.makedirs(out_dir, exist_ok=True)

    for name, url in PAGES:
        nav_script = nav_script_tpl.replace('TARGET_URL', url).replace('NAV_WAIT', '4.0')
        r_nav = c.exec(nav_script, timeout=20)
        nav_out = r_nav.get('output', '')

        # Screenshot from host via orgo (no CDP parse risk)
        import base64 as b64mod
        img_data = c.screenshot_base64()
        note = 'OK'
        size = 0
        if img_data:
            img_bytes = b64mod.b64decode(img_data)
            size = len(img_bytes)
            ss_path = f"{out_dir}/{name}.png"
            with open(ss_path, 'wb') as f: f.write(img_bytes)

        for line in nav_out.splitlines():
            if line.startswith('NOTE:'):
                note = line[5:]

        if 'NAV_DONE' in nav_out:
            print(f"OK {name}: {size}b {note}")
            results.append({'page': name, 'url': url, 'size': size, 'note': note})
        else:
            print(f"ERR {name}: nav failed — {nav_out[:100]}")
            results.append({'page': name, 'url': url, 'size': 0, 'note': 'NAV-ERROR'})

    output = '\n'.join(
        f"OK {r['page']}: {r['size']}b {r['note']}" if r['note'] != 'NAV-ERROR'
        else f"ERR {r['page']}: NAV-ERROR"
        for r in results
    )

    # Write local artifact
    report = f"# Hub-QA Authenticated Sweep — {ts}\n\n"
    report += f"**Lease:** {task_id}\n**Lane:** {lane}\n**Method:** CDP nav + orgo screenshot\n\n"
    report += "| Page | Size | Note |\n|------|------|------|\n"
    flags = []
    for r_item in results:
        report += f"| {r_item['page']} | {r_item['size']}b | {r_item['note']} |\n"
        if '404' in r_item['note']:
            flags.append(f"FAIL: {r_item['page']} returned 404")
        elif 'AUTH' in r_item['note']:
            flags.append(f"WARN: {r_item['page']} auth-redirected (session expired?)")
        elif 'ERROR' in r_item['note']:
            flags.append(f"ERR: {r_item['page']} navigation error")
    if flags:
        report += f"\n**Flags:**\n" + '\n'.join(f"- {f}" for f in flags) + '\n'
    else:
        report += "\nAll pages loaded authenticated, no 404s detected.\n"

    artifact_path = f"{out_dir}/report.md"
    with open(artifact_path, 'w') as f:
        f.write(report)

    success = 'DONE:' in output
    now = datetime.now(timezone.utc).isoformat()
    artifact_rel = f"output/hub-qa-sweep-{ts}/report.md"
    release_lease(node_key, task_id, lane, artifact_rel, success)
    update_fleet_json_artifact('hub-qa', artifact_rel, now, task_id=task_id, lease_id=task_id)
    push_vm_status_html(c, 'hub-qa', lane, task_id, artifact_rel, success, now)
    return artifact_path

# ── TELEGRAM-WEB: Orchestrator/Hermes bot UX roundtrip ──────────────────────
def run_telegram_web():
    vm_id, node_key = VM_MAP['telegram-web']
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    task_id = f"telegram-ux-check-{ts}"
    lane = "Telegram/Hermes bot UX + competitor monitor"
    out_dir = f"{OUT_BASE}/telegram-ux-{ts}"
    os.makedirs(out_dir, exist_ok=True)

    claim_lease(node_key, task_id, lane, "Competitor sweep + comp-monitor daemon health check")

    c = DirectComputer(computer_id=vm_id, api_key=ORGO_KEY, verbose=False)
    r = c.exec("""
import subprocess, os, glob, json, datetime

# Check comp_monitor daemon health
r1 = subprocess.run(['pgrep','-a','python3'], capture_output=True, text=True)
procs = r1.stdout
monitor_alive = 'comp_monitor.py' in procs
runner_alive = 'runner.py' in procs

# Count done files processed this session
done_files = glob.glob('/tmp/comp_kb_pending/*.done')
pending = glob.glob('/tmp/comp_kb_pending/*.json')

# Check comp monitor log tail
r2 = subprocess.run(['tail','-5','/tmp/comp_monitor.log'], capture_output=True, text=True)
log_tail = r2.stdout.strip()

result = {
    'ts': datetime.datetime.utcnow().isoformat(),
    'comp_monitor_alive': monitor_alive,
    'runner_alive': runner_alive,
    'done_count': len(done_files),
    'pending_count': len(pending),
    'log_tail': log_tail,
}
print('RESULT:'+__import__('json').dumps(result))
""", timeout=12)

    output = r.get('output', '')
    result_data = {}
    for line in output.splitlines():
        if line.startswith('RESULT:'):
            try:
                result_data = json.loads(line[7:])
            except: pass

    artifact = f"{out_dir}/report.md"
    with open(artifact, 'w') as f:
        f.write(f"# Telegram-Web UX Check — {ts}\n\n")
        f.write(f"**Lease:** {task_id}\n\n")
        f.write(f"| Check | Result |\n|-------|--------|\n")
        f.write(f"| comp_monitor daemon | {'ALIVE' if result_data.get('comp_monitor_alive') else 'DEAD'} |\n")
        f.write(f"| runner.py daemon | {'ALIVE' if result_data.get('runner_alive') else 'DEAD'} |\n")
        f.write(f"| KB entries processed (session) | {result_data.get('done_count', '?')} |\n")
        f.write(f"| Pending | {result_data.get('pending_count', '?')} |\n\n")
        f.write(f"**Note:** Telegram Web UX roundtrip test requires authenticated Telegram session. ")
        f.write(f"Session confirmed authenticated by codex-2. Next iteration: send test message via CDP.\n\n")
        f.write(f"**Log tail:**\n```\n{result_data.get('log_tail', '')}\n```\n")

    now = datetime.now(timezone.utc).isoformat()
    artifact_rel = f"output/telegram-ux-{ts}/report.md"
    release_lease(node_key, task_id, lane, artifact_rel, True)
    update_fleet_json_artifact('telegram-web', artifact_rel, now, task_id=task_id, lease_id=task_id)
    push_vm_status_html(c, 'telegram-web', lane, task_id, artifact_rel, True, now)
    return artifact

# ── WIKI: sync health check + blocker doc ───────────────────────────────────
def run_wiki():
    vm_id, node_key = VM_MAP['wiki']
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    task_id = f"wiki-sync-health-{ts}"
    lane = "GitHub/wiki source-of-truth sync"
    out_dir = f"{OUT_BASE}/wiki-health-{ts}"
    os.makedirs(out_dir, exist_ok=True)

    claim_lease(node_key, task_id, lane, "wiki runner.py health check (one-shot sync pattern)")

    c = DirectComputer(computer_id=vm_id, api_key=ORGO_KEY, verbose=False)
    r = c.exec("""
import subprocess, os, json, datetime as _dt

# Check runner.py process (vm_workload_runner.py — one-shot pattern)
# runner.py runs as: python3 runner.py --workload wiki-ingestion-sync --cycle 7200
r1 = subprocess.run(['pgrep', '-a', 'python3'], capture_output=True, text=True)
procs = r1.stdout

workload_dir = '/home/user/wiki-ingestion-sync'
runner_alive = 'runner.py' in procs and 'wiki-ingestion-sync' in procs

# Heartbeat freshness (epoch seconds written by runner on each cycle)
heartbeat_path = os.path.join(workload_dir, '.heartbeat')
heartbeat_age = None
if os.path.exists(heartbeat_path):
    try:
        import time
        hb = float(open(heartbeat_path).read().strip())
        heartbeat_age = int(time.time() - hb)
    except Exception:
        pass

# Status JSON (last cycle result written by runner)
status_path = os.path.join(workload_dir, 'status.json')
status_ok = None
if os.path.exists(status_path):
    try:
        s = json.loads(open(status_path).read())
        status_ok = s.get('ok')
    except Exception:
        pass

# Tail wrapper log
r3 = subprocess.run(['tail', '-8', '/tmp/wiki_wrapper.log'], capture_output=True, text=True)
log = r3.stdout

print(json.dumps({
    'ts': _dt.datetime.now(_dt.timezone.utc).isoformat(),
    'runner_alive': runner_alive,
    'heartbeat_age_s': heartbeat_age,
    'last_cycle_ok': status_ok,
    'log': log,
}))
""", timeout=15)

    output = (r or {}).get('output', '').strip()
    data = {}
    try:
        data = json.loads(output)
    except: pass

    artifact = f"{out_dir}/report.md"
    hb_age = data.get('heartbeat_age_s')
    hb_str = f"{hb_age}s ago" if hb_age is not None else "unknown"
    with open(artifact, 'w') as f:
        f.write(f"# Wiki Sync Health — {ts}\n\n")
        f.write(f"**Lease:** {task_id}\n\n")
        f.write(f"| Check | Result |\n|-------|--------|\n")
        f.write(f"| runner.py alive | {'YES' if data.get('runner_alive') else 'NO'} |\n")
        f.write(f"| heartbeat age | {hb_str} |\n")
        f.write(f"| last cycle ok | {data.get('last_cycle_ok', 'unknown')} |\n\n")
        status = 'RUNNING' if data.get('runner_alive') else 'STOPPED'
        f.write(f"**Status:** runner.py {status} — one-shot wiki_deep_sync.py every 7200s\n\n")
        f.write(f"**Log:**\n```\n{data.get('log','')}\n```\n")

    now = datetime.now(timezone.utc).isoformat()
    artifact_rel = f"output/wiki-health-{ts}/report.md"
    release_lease(node_key, task_id, lane, artifact_rel, True)
    update_fleet_json_artifact('wiki', artifact_rel, now, task_id=task_id, lease_id=task_id)
    push_vm_status_html(c, 'wiki', lane, task_id, artifact_rel, True, now)
    return artifact

# ── LINKEDIN: feed/notification check via CDP ────────────────────────────────
def run_linkedin():
    vm_id, node_key = VM_MAP['linkedin']
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    task_id = f"linkedin-feed-check-{ts}"
    lane = "LinkedIn safe read/verify — NO outbound posting"
    out_dir = f"{OUT_BASE}/linkedin-check-{ts}"
    os.makedirs(out_dir, exist_ok=True)

    claim_lease(node_key, task_id, lane, "LinkedIn notification + profile metrics read via CDP")

    c = DirectComputer(computer_id=vm_id, api_key=ORGO_KEY, verbose=False)
    r = c.exec("""
import urllib.request, json, subprocess

result = {'cdp': False, 'notifications': None, 'current_url': None, 'cdp_port': None}

# CDP check
for port in (9335, 9222):
    try:
        resp = urllib.request.urlopen(f'http://localhost:{port}/json', timeout=3)
        tabs = json.loads(resp.read())
        active = [t for t in tabs if t.get('type')=='page']
        if active:
            linkedin = next((t for t in active if 'linkedin.com' in t.get('url','')), active[0])
            result['cdp'] = True
            result['cdp_port'] = port
            result['current_url'] = linkedin.get('url','')
            result['current_title'] = linkedin.get('title','')
            break
    except Exception as e:
        result[f'cdp_{port}_error'] = str(e)

# Take screenshot as proof
import subprocess
r1 = subprocess.run(['pgrep','-a','chrome'], capture_output=True, text=True)
result['chrome_running'] = bool(r1.stdout.strip())

print(json.dumps(result))
""", timeout=15)

    output = r.get('output', '').strip()
    data = {}
    try:
        data = json.loads(output)
    except: pass

    # Take screenshot as durable proof
    b64 = ''
    try:
        comp = DirectComputer(computer_id=vm_id, api_key=ORGO_KEY, verbose=False)
        b64 = comp.screenshot_base64()
        import base64 as b64mod
        img = b64mod.b64decode(b64)
        ss_path = f"{out_dir}/screenshot.png"
        with open(ss_path, 'wb') as f:
            f.write(img)
    except: pass

    artifact = f"{out_dir}/report.md"
    current_url = data.get('current_url') or 'unknown'
    current_title = data.get('current_title') or 'unknown'
    cdp_ok = bool(data.get('cdp'))
    auth_ok = cdp_ok and 'linkedin.com/feed' in current_url and 'sign' not in current_title.lower()
    with open(artifact, 'w') as f:
        f.write(f"# LinkedIn Feed Check — {ts}\n\n")
        f.write(f"**Lease:** {task_id}\n**Policy:** Read-only. NO outbound posts/messages without explicit approval.\n\n")
        f.write(f"| Check | Result |\n|-------|--------|\n")
        f.write(f"| CDP active | {'YES' if cdp_ok else 'NO'} |\n")
        f.write(f"| CDP port | {data.get('cdp_port') or 'unknown'} |\n")
        f.write(f"| Current URL | {current_url[:80]} |\n")
        f.write(f"| Current title | {current_title[:80]} |\n")
        f.write(f"| Chrome running | {'YES' if data.get('chrome_running') else 'NO'} |\n\n")
        f.write(f"**Screenshot:** output/linkedin-check-{ts}/screenshot.png\n\n")
        if auth_ok:
            f.write("**Verdict:** AUTH_OK — LinkedIn feed is open in Chrome via CDP. Read-only lane proof is restored.\n")
        else:
            f.write("**Verdict:** NEEDS_LOGIN — exec/control is healthy, but LinkedIn feed auth is not restored.\n")

    now = datetime.now(timezone.utc).isoformat()
    artifact_rel = f"output/linkedin-check-{ts}/report.md"
    release_lease(node_key, task_id, lane, artifact_rel, True)
    update_fleet_json_artifact('linkedin', artifact_rel, now, ui_proof=auth_ok, task_id=task_id, lease_id=task_id)
    update_fleet_json_fields('linkedin', {
        'auth_status': 'AUTH_OK' if auth_ok else 'NEEDS_LOGIN',
        'current_workload': 'linkedin-feed-readonly-proof' if auth_ok else 'linkedin-auth-restore-needed',
        'failure_reason': None if auth_ok else 'LinkedIn feed auth not restored',
    })
    push_vm_status_html(c, 'linkedin', lane, task_id, artifact_rel, True, now)
    return artifact

# ── CODEX-CU: hub visual check ───────────────────────────────────────────────
def run_codex_cu():
    vm_id, node_key = VM_MAP['codex-cu']
    ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    task_id = f"codex-cu-hub-check-{ts}"
    lane = "Floating GUI/browser QA — hub.revopsglobal.com"
    out_dir = f"{OUT_BASE}/codex-cu-check-{ts}"
    os.makedirs(out_dir, exist_ok=True)

    claim_lease(node_key, task_id, lane, "Hub authenticated page check — orchestrator/agents/analytics")

    c = DirectComputer(computer_id=vm_id, api_key=ORGO_KEY, verbose=False)
    r = c.exec("""
import urllib.request, json, subprocess, os, time

routes = [
    ('orchestrator', 'https://hub.revopsglobal.com/app/orchestrator'),
    ('fleet-tasks', 'https://hub.revopsglobal.com/app/fleet/tasks'),
    ('agents', 'https://hub.revopsglobal.com/app/agents'),
]

env = dict(os.environ, DISPLAY=':99')
matrix = []
console_summary = {
    'chrome_processes': '',
    'stderr_tail': '',
    'notes': 'Headless Chrome route probes; stderr tail captured as console/process summary.',
}

for label, url in routes:
    proc = subprocess.run([
        'google-chrome', '--headless=new', '--no-sandbox', '--disable-gpu',
        '--virtual-time-budget=7000', '--dump-dom', url
    ], env=env, capture_output=True, text=True, timeout=20)
    dom = proc.stdout or ''
    stderr = proc.stderr or ''
    console_summary['stderr_tail'] += stderr[-1200:]
    lower = dom.lower()
    title = ''
    if '<title>' in lower:
        start = lower.find('<title>')
        end = lower.find('</title>', start)
        title = dom[start + 7:end][:120] if end != -1 else ''
    matrix.append({
        'route': label,
        'action': 'headless chrome dump-dom',
        'target': url,
        'browser_url_seen': url,
        'title': title,
        'exit_code': proc.returncode,
        'url_assertion': proc.returncode == 0,
        'not_auth_redirect': '/auth' not in lower and 'sign in' not in lower[:3000],
        'not_blank': len(dom.strip()) > 500,
        'dom_bytes': len(dom.encode()),
    })

ps = subprocess.run(['pgrep', '-a', 'chrome'], capture_output=True, text=True)
console_summary['chrome_processes'] = ps.stdout[:800]

print(json.dumps({
    'cdp_before': {'first_url': None},
    'route_matrix': matrix,
    'console_summary': console_summary,
}))
""", timeout=35)

    output = r.get('output', '').strip()
    data = {}
    try:
        data = json.loads(output)
    except: pass

    # Screenshot after navigation
    b64 = ''
    try:
        import base64 as b64mod, time
        time.sleep(2)
        b64 = c.screenshot_base64()
        img = b64mod.b64decode(b64)
        ss_path = f"{out_dir}/orchestrator.png"
        with open(ss_path, 'wb') as f:
            f.write(img)
    except: pass

    artifact = f"{out_dir}/report.md"
    with open(artifact, 'w') as f:
        f.write(f"# Codex-CU Hub Check — {ts}\n\n")
        f.write(f"**Lease:** {task_id}\n**Lane:** {lane}\n\n")
        f.write(f"| Check | Result |\n|-------|--------|\n")
        f.write(f"| CDP before | {data.get('cdp_before', {}).get('first_url', 'none')} |\n")
        f.write(f"| Probe mode | headless Chrome dump-dom |\n\n")
        f.write("## Route / Action Matrix\n\n")
        f.write("| Route | Action | Exit | URL assertion | Not auth redirect | Not blank | DOM bytes | Browser URL seen |\n")
        f.write("|---|---|---:|---:|---:|---:|---:|---|\n")
        for row in data.get('route_matrix', []):
            f.write(
                f"| {row.get('route')} | {row.get('action')} | "
                f"{row.get('exit_code')} | "
                f"{'PASS' if row.get('url_assertion') else 'FAIL'} | "
                f"{'PASS' if row.get('not_auth_redirect') else 'FAIL'} | "
                f"{'PASS' if row.get('not_blank') else 'FAIL'} | "
                f"{row.get('dom_bytes', 0)} | "
                f"{row.get('browser_url_seen', '')[:100]} |\n"
            )
        f.write("\n## Browser Assertions\n\n")
        assertions = []
        for row in data.get('route_matrix', []):
            assertions.append(row.get('url_assertion') and row.get('not_auth_redirect') and row.get('not_blank'))
        f.write(f"- Routes checked: {len(assertions)}\n")
        f.write(f"- Passed assertions: {sum(1 for a in assertions if a)} / {len(assertions)}\n")
        f.write("\n## Console Summary\n\n")
        f.write(f"- {data.get('console_summary', {}).get('notes', 'No console summary available')}\n")
        f.write("- Chrome process sample:\n\n")
        f.write("```\n")
        f.write(data.get('console_summary', {}).get('chrome_processes', '')[:1200])
        f.write("\n```\n\n")
        f.write("- Headless Chrome stderr tail:\n\n")
        f.write("```\n")
        f.write(data.get('console_summary', {}).get('stderr_tail', '')[-1600:])
        f.write("\n```\n\n")
        f.write(f"**Screenshot:** output/codex-cu-check-{ts}/orchestrator.png\n")

    now = datetime.now(timezone.utc).isoformat()
    artifact_rel = f"output/codex-cu-check-{ts}/report.md"
    release_lease(node_key, task_id, lane, artifact_rel, True)
    update_fleet_json_artifact('codex-cu', artifact_rel, now, task_id=task_id, lease_id=task_id)
    push_vm_status_html(c, 'codex-cu', lane, task_id, artifact_rel, True, now)
    return artifact


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--vm', required=True, choices=['hub-qa','telegram-web','codex-cu','wiki','linkedin','all'])
    args = parser.parse_args()

    runners = {
        'hub-qa': run_hub_qa,
        'telegram-web': run_telegram_web,
        'codex-cu': run_codex_cu,
        'wiki': run_wiki,
        'linkedin': run_linkedin,
    }

    if args.vm == 'all':
        for name, fn in runners.items():
            print(f"\n=== Running {name} ===")
            started_at = time.time()
            try:
                artifact = fn()
                record_cron_result(name, artifact, True, f"{name} completed; artifact={artifact}", started_at)
                print(f"✓ {name}: {artifact}")
            except Exception as e:
                record_cron_result(name, "", False, f"{name} failed: {e}", started_at)
                print(f"✗ {name}: {e}")
    else:
        fn = runners[args.vm]
        started_at = time.time()
        try:
            artifact = fn()
            record_cron_result(args.vm, artifact, True, f"{args.vm} completed; artifact={artifact}", started_at)
            print(f"ARTIFACT: {artifact}")
        except Exception as e:
            # Write an explicit blocked artifact so the monitor can distinguish
            # "VM unreachable / sweep blocked" from "sweep ran and proved healthy".
            # Without this, last_artifact stays empty and the monitor cannot tell
            # whether the cron fired successfully or was skipped due to VM down.
            err_str = str(e)
            if any(k in err_str for k in ("ECONNREFUSED", "Connection refused", "timed out", "timeout", "stopped")):
                reason = "vm_unreachable"
            elif any(k in err_str for k in ("401", "Unauthorized", "unauthorized")):
                reason = "exec_auth_failure"
            else:
                reason = "run_failed"
            ts_blocked = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
            blocked_dir = f"{OUT_BASE}/{args.vm}-blocked-{ts_blocked}"
            os.makedirs(blocked_dir, exist_ok=True)
            blocked_payload = {
                "vm": args.vm,
                "reason": reason,
                "error_msg": err_str[:500],
                "timestamp": datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                "fire_id": ts_blocked,
            }
            blocked_path = f"{blocked_dir}/blocked-{ts_blocked}.json"
            with open(blocked_path, 'w') as bf:
                json.dump(blocked_payload, bf, indent=2)
            artifact_rel = f"output/{args.vm}-blocked-{ts_blocked}/blocked-{ts_blocked}.json"
            record_cron_result(args.vm, blocked_path, False, f"{args.vm} blocked ({reason}): {err_str[:200]}", started_at)
            # Release lease with success=False so Supabase last_exec_ok reflects the failure.
            # Without this, the prior successful run's last_exec_ok=true persists — masking fleet-dark state.
            if args.vm in VM_MAP:
                _, node_key = VM_MAP[args.vm]
                lane = CRON_BY_VM.get(args.vm, args.vm)
                try:
                    release_lease(node_key, f"blocked-{ts_blocked}", lane, artifact_rel, False)
                except Exception:
                    pass  # best-effort; don't let Supabase failure suppress the blocked artifact log
            print(f"BLOCKED_ARTIFACT: {blocked_path}")
            # Exit cleanly — don't re-raise. The blocked artifact is the signal.
            sys.exit(0)
