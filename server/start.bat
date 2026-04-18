@echo off
REM start.bat — Khởi động dashboard server trên Windows
REM Tự động cài uv nếu chưa có, sau đó chạy dashboard_server.py

echo Dang kiem tra uv...
where uv >nul 2>&1
if %errorlevel% neq 0 (
    echo Chua co uv. Dang cai dat...
    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
)

echo Dang cau hinh Claude Code...
uv run setup_claude.py

echo Dang khoi dong server...
uv run dashboard_server.py
