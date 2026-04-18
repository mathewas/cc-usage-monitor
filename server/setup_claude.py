#!/usr/bin/env python3
"""
One-time setup: patch ~/.claude/settings.json so Claude Code exports
telemetry to our OTLP receiver and writes rate-limit info each status
line update.

Idempotent — preserves any existing settings, only adds/updates the
keys this monitor needs.
"""

import json
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


REQUIRED_ENV = {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
}

PY_CMD = "python" if os.name == "nt" else "python3"

STATUS_LINE_SCRIPT = (
    "import json,os,subprocess,sys,tempfile; "
    "data=json.load(sys.stdin); "
    "rl=data.get('rate_limits',{}); "
    "email='Claude Code'; "
    "r=subprocess.run(['claude','auth','status'],capture_output=True,text=True,timeout=10); "
    "a=json.loads(r.stdout) if r.returncode==0 else {}; "
    "email=a.get('email',email); "
    "out={'rate_limits':rl,'email':email,'organization':a.get('orgName','')}; "
    "open(os.path.join(tempfile.gettempdir(),'claude_rate_limits.json'),'w')"
    ".write(json.dumps(out,indent=2))"
)

STATUS_LINE = {
    "type": "command",
    "command": f'{PY_CMD} -c "{STATUS_LINE_SCRIPT}"',
}


def main():
    settings_path = Path.home() / ".claude" / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            backup = settings_path.with_suffix(".json.bak")
            settings_path.replace(backup)
            print(f"[setup] {settings_path} khong phai JSON hop le, da sao luu -> {backup}")
            settings = {}
    else:
        settings = {}

    changed = False

    env = settings.setdefault("env", {})
    for k, v in REQUIRED_ENV.items():
        if env.get(k) != v:
            env[k] = v
            changed = True

    if settings.get("statusLine") != STATUS_LINE:
        settings["statusLine"] = STATUS_LINE
        changed = True

    if changed:
        settings_path.write_text(
            json.dumps(settings, indent=2) + "\n", encoding="utf-8"
        )
        print(f"[setup] Da cap nhat {settings_path}")
        print("[setup] >> Hay khoi dong lai Claude Code de cai dat co hieu luc.")
    else:
        print(f"[setup] {settings_path} da cau hinh san. Khong thay doi.")


if __name__ == "__main__":
    main()
