#!/bin/bash
# start.sh — Khởi động dashboard server trên macOS/Linux

if ! command -v uv &> /dev/null; then
    echo "Chưa có uv. Đang cài đặt..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source "$HOME/.local/bin/env"
fi

echo "Đang cấu hình Claude Code..."
uv run setup_claude.py

echo "Đang khởi động server..."
uv run dashboard_server.py
