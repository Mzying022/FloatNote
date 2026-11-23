@echo off
cd /d "%~dp0"

echo.
echo   ============================================
echo      FloatNote - Let the numbered notation float
echo   ============================================
echo.
echo   Starting local server...
echo   Browser will open at http://localhost:8080/
echo   Close this window to stop the server.
echo.

ping -n 3 127.0.0.1 >nul
start "" http://localhost:8080/
echo   Server running at http://localhost:8080/
py -m http.server 8080

echo.
echo   Server stopped.
pause
