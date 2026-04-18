#!/usr/bin/env python3
"""
Minimal OTLP HTTP receiver for Claude Code telemetry + dashboard HTTP API.

Listens on localhost:4318:
  POST /v1/logs, /v1/metrics  — OTLP JSON ingest (writes to JSONL)
  GET  /api/dashboard         — aggregated today's stats as JSON (for web UI)
  OPTIONS *                   — CORS preflight

Usage:
    python dashboard_server.py
    python dashboard_server.py --port 4318 --out /tmp/claude_otel_events.jsonl
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

# Force UTF-8 stdout on Windows (cp1252 default breaks non-ASCII log messages)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


DEFAULT_OUT = os.path.join(tempfile.gettempdir(), "claude_otel_events.jsonl")
RATE_LIMITS_JSON = os.environ.get(
    "CLAUDE_RATE_LIMITS_JSON",
    os.path.join(tempfile.gettempdir(), "claude_rate_limits.json"),
)


def extract_attr(attributes: list, key: str):
    """Extract a value from OTLP attribute list [{key, value:{stringValue|intValue|doubleValue}}]."""
    for a in attributes:
        if a.get("key") == key:
            v = a.get("value", {})
            return (
                v.get("stringValue")
                or v.get("doubleValue")
                or v.get("intValue")
            )
    return None


def process_logs(body: dict, out_path: str):
    """Parse OTLP LogsData, write api_request events to JSONL."""
    written = 0
    for rl in body.get("resourceLogs", []):
        for sl in rl.get("scopeLogs", []):
            for rec in sl.get("logRecords", []):
                attrs = rec.get("attributes", [])
                event_name = extract_attr(attrs, "event.name")
                if event_name != "api_request":
                    continue

                ts_ns = int(rec.get("timeUnixNano", 0))
                ts = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc).isoformat()

                event = {
                    "ts": ts,
                    "event": "api_request",
                    "model":                 extract_attr(attrs, "model"),
                    "cost_usd":              extract_attr(attrs, "cost_usd"),
                    "duration_ms":           extract_attr(attrs, "duration_ms"),
                    "input_tokens":          extract_attr(attrs, "input_tokens"),
                    "output_tokens":         extract_attr(attrs, "output_tokens"),
                    "cache_read_tokens":     extract_attr(attrs, "cache_read_tokens"),
                    "cache_creation_tokens": extract_attr(attrs, "cache_creation_tokens"),
                    "speed":                 extract_attr(attrs, "speed"),
                    "session_id":            extract_attr(attrs, "session.id"),
                    "user_email":            extract_attr(attrs, "user.email"),
                }
                event = {k: v for k, v in event.items() if v is not None}

                with open(out_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(event) + "\n")
                written += 1

    return written


def process_metrics(body: dict, out_path: str):
    """Parse OTLP MetricsData, write cost/token metrics to JSONL."""
    written = 0
    ts_now = datetime.now(tz=timezone.utc).isoformat()

    for rm in body.get("resourceMetrics", []):
        for sm in rm.get("scopeMetrics", []):
            for metric in sm.get("metrics", []):
                name = metric.get("name", "")
                if name not in ("claude_code.cost.usage", "claude_code.token.usage"):
                    continue

                for dp in metric.get("sum", {}).get("dataPoints", []):
                    attrs = dp.get("attributes", [])
                    event = {
                        "ts": ts_now,
                        "event": "metric",
                        "metric": name,
                        "value": dp.get("asDouble") or dp.get("asInt"),
                        "type":  extract_attr(attrs, "type"),
                        "model": extract_attr(attrs, "model"),
                        "session_id": extract_attr(attrs, "session.id"),
                    }
                    event = {k: v for k, v in event.items() if v is not None}
                    with open(out_path, "a", encoding="utf-8") as f:
                        f.write(json.dumps(event) + "\n")
                    written += 1

    return written


def _resets_at_to_unix(val):
    """resets_at → float seconds. Accepts int/float (s or ms), or ISO string."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        if val <= 0:
            return None
        v = float(val)
        if v > 1e12:  # looks like milliseconds
            v = v / 1000.0
        return v
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except ValueError:
            return None
    return None


def _reset_local_str(ts_unix):
    """Unix seconds → 'YYYY-MM-DDTHH:MM' local time (datetime-local input format)."""
    if ts_unix is None:
        return ""
    try:
        return datetime.fromtimestamp(ts_unix).strftime("%Y-%m-%dT%H:%M")
    except (OSError, ValueError, OverflowError):
        return ""


def load_rate_limits(path: str) -> dict:
    """
    Parse claude_rate_limits.json (written by Claude Code statusLine). Accepts
    either the full dump with `rate_limits: {five_hour, seven_day}` or just
    `{five_hour, seven_day}` at top level.
    Returns a dict with zeros if the file is missing/invalid.
    """
    out = {
        "pct_5h": 0, "reset_5h": "",
        "pct_7d": 0, "reset_7d": "",
        "email": "", "organization": "",
        "source": None,
    }
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return out
    if not isinstance(data, dict):
        return out

    rl = data.get("rate_limits")
    if rl is None and ("five_hour" in data or "seven_day" in data):
        rl = data
    if not isinstance(rl, dict):
        return out

    fh = rl.get("five_hour") if isinstance(rl.get("five_hour"), dict) else {}
    sd = rl.get("seven_day") if isinstance(rl.get("seven_day"), dict) else {}

    def pct(block):
        v = block.get("used_percentage")
        return int(round(float(v))) if v is not None else 0

    out["pct_5h"]   = pct(fh)
    out["pct_7d"]   = pct(sd)
    out["reset_5h"] = _reset_local_str(_resets_at_to_unix(fh.get("resets_at")))
    out["reset_7d"] = _reset_local_str(_resets_at_to_unix(sd.get("resets_at")))

    email = data.get("email")
    if isinstance(email, str) and email.strip():
        out["email"] = email.strip()
    org = data.get("organization") or data.get("org") or ""
    if isinstance(org, str):
        out["organization"] = org

    out["source"] = path
    return out


def aggregate_today(events_path: str) -> dict:
    """Read the JSONL events file and sum today's api_request stats."""
    today = date.today().isoformat()
    stats = {
        "date":                today,
        "cost_usd":            0.0,
        "tokens_input":        0,
        "tokens_output":       0,
        "tokens_cache_read":   0,
        "tokens_cache_write":  0,
        "requests":            0,
        "sessions":            0,
        "user_email":          "",
        "updated_at":          datetime.now(tz=timezone.utc).isoformat(),
    }
    session_ids = set()

    try:
        with open(events_path, encoding="utf-8") as f:
            lines = f.readlines()
    except (OSError, FileNotFoundError):
        return stats

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("event") != "api_request":
            continue

        ts = ev.get("ts", "")
        try:
            ev_date = datetime.fromisoformat(ts).astimezone().date().isoformat()
        except (ValueError, TypeError):
            continue
        if ev_date != today:
            continue

        stats["cost_usd"]           += float(ev.get("cost_usd") or 0)
        stats["tokens_input"]       += int(ev.get("input_tokens") or 0)
        stats["tokens_output"]      += int(ev.get("output_tokens") or 0)
        stats["tokens_cache_read"]  += int(ev.get("cache_read_tokens") or 0)
        stats["tokens_cache_write"] += int(ev.get("cache_creation_tokens") or 0)
        stats["requests"]           += 1

        sid = ev.get("session_id")
        if sid:
            session_ids.add(sid)
        email = ev.get("user_email")
        if email and not stats["user_email"]:
            stats["user_email"] = email

    stats["sessions"] = len(session_ids)
    stats["cost_usd"] = round(stats["cost_usd"], 4)
    return stats


class OTLPHandler(BaseHTTPRequestHandler):
    out_path = DEFAULT_OUT

    # ── Shared CORS helper ────────────────────────────────────────────────────
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") == "/api/dashboard":
            stats  = aggregate_today(self.out_path)
            limits = load_rate_limits(RATE_LIMITS_JSON)
            # Rate-limits file wins for email if present (it's the active account)
            if limits["email"]:
                stats["user_email"] = limits["email"]
            stats.update({
                "pct_5h":   limits["pct_5h"],
                "reset_5h": limits["reset_5h"],
                "pct_7d":   limits["pct_7d"],
                "reset_7d": limits["reset_7d"],
                "organization":     limits["organization"],
                "rate_limits_path": limits["source"],
            })
            payload = json.dumps(stats).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400)
            self._cors()
            self.end_headers()
            return

        written = 0
        if self.path == "/v1/logs":
            written = process_logs(body, self.out_path)
        elif self.path == "/v1/metrics":
            written = process_metrics(body, self.out_path)

        if written:
            print(f"  [{self.path}] +{written} records >> {self.out_path}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(b'{"partialSuccess":{}}')

    def log_message(self, fmt, *args):
        pass  # suppress default access log


def main():
    p = argparse.ArgumentParser(description="OTLP receiver + dashboard API for Claude Code")
    p.add_argument("--port", type=int, default=4318)
    p.add_argument("--out", default=DEFAULT_OUT)
    args = p.parse_args()

    OTLPHandler.out_path = args.out

    print(f"OTLP receiver listening on http://localhost:{args.port}")
    print(f"  POST /v1/logs, /v1/metrics    → OTel ingest")
    print(f"  GET  /api/dashboard           → aggregated stats (for web UI)")
    print(f"Events file:       {args.out}")
    print(f"Rate-limits file:  {RATE_LIMITS_JSON}")
    print("Waiting for Claude Code telemetry... (Ctrl+C to stop)\n")

    server = HTTPServer(("localhost", args.port), OTLPHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
