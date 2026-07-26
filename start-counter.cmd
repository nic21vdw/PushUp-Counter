@echo off
setlocal

rem Starts the push-up counter and leaves it running.
rem
rem Double-click it, or put a shortcut to it in your Startup folder so the
rem counter is already up whenever OBS is -- see "Keeping it always on" in the
rem README. Every failure below prints a reason and waits, because a window
rem that flashes open and closes tells you nothing.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or not on your PATH.
  echo   Get it from https://nodejs.org ^(the LTS build^), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo   There is no .env file yet, so the counter has no YouTube key.
  echo.
  echo   Copy .env.example to .env, then fill in YOUTUBE_API_KEY and
  echo   YOUTUBE_CHANNEL_ID. Section 1 of the README walks through getting them.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the push-up counter. Leave this window open -- closing it
echo   stops the counter, and the OBS source goes with it.
echo.

node server.js

rem Only reached if the server exits. Say so rather than vanishing.
echo.
echo   The counter stopped. Anything printed above is the reason.
echo.
pause >nul
