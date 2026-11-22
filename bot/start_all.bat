@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   AI WeightLoss Bot + Proxy
echo ============================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found!
    pause
    exit /b 1
)

echo [1/2] Starting AI proxy on port 8080...
start "AI Proxy" cmd /c ".venv\Scripts\python.exe proxy.py"
timeout /t 2 /nobreak >nul

echo [2/2] Starting Telegram bot...
".venv\Scripts\python.exe" main.py
pause