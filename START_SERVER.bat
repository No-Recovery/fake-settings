@echo off
cd /d "%~dp0"
title Vo1dek Server
echo Starting Vo1dek server on port 5000...
echo.
echo Local access:    http://127.0.0.1:5000
echo Home network:    http://192.168.0.197:5000
echo.
echo Press Ctrl+C to stop
echo.
python server.py
pause