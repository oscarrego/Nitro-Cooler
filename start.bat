@echo off
setlocal
cd /d "%~dp0"

title Nitro Cooler - UI Testing

echo ====================================================
echo   NITRO COOLER - UI Browser Testing Server
echo ====================================================
echo.

if not exist "node_modules\" (
    echo Dependencies not found. Installing node_modules...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Please check your Node.js installation.
        pause
        exit /b 1
    )
    echo.
)

echo Starting development server...
echo URL: http://127.0.0.1:1420
echo Opening browser...
echo.

call npm run dev

pause
