@echo off
setlocal

rem Pulls the latest counter, then starts it. Use this one day-to-day; use
rem start-counter.cmd if you want to run exactly what is on disk without
rem touching the network.
rem
rem An update that fails is not a reason not to stream: every failure below
rem falls through to starting whatever version you already have, and says so.

cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo   Git is not on your PATH, so this cannot update itself.
  echo   Starting the counter you already have.
  echo.
  goto :start
)

echo   Checking for a newer counter...

git rev-parse --abbrev-ref HEAD > "%TEMP%\pushup-branch.txt" 2>nul
set /p BRANCH=< "%TEMP%\pushup-branch.txt"
del "%TEMP%\pushup-branch.txt" >nul 2>&1

if not "%BRANCH%"=="main" (
  echo   This copy is on "%BRANCH%", not main. Leaving it alone.
  echo.
  goto :start
)

git diff --quiet
if errorlevel 1 (
  echo   There are uncommitted changes here, so nothing was pulled.
  echo   Sort them out if you expected an update.
  echo.
  goto :start
)

git pull --ff-only
if errorlevel 1 (
  echo.
  echo   Could not update -- offline, or main has moved in a way that needs a
  echo   merge. Starting the version you already have.
  echo.
)

:start
call "%~dp0start-counter.cmd"
