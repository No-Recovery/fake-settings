@echo off
cd /d "%~dp0"
echo ==========================================
echo   Connecting tunnel for localhost.run...
echo ==========================================
echo.
echo Your public link will appear below (look for .lhr.life)
echo.
echo.
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=30 -R 80:localhost:5000 nokey@localhost.run
pause