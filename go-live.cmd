@echo off
conhost.exe --headless powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0go-live.ps1"
