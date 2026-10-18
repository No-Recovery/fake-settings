@echo off
cd /d "%~dp0"
title Vo1dek Tunnel
echo Starting tunnel for Vo1dek...
echo.
echo Your link (opens instantly, no verification) - look for .lhr.life:
echo.
echo.
echo. | ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=30 -R 80:localhost:5000 nokey@localhost.run
pause