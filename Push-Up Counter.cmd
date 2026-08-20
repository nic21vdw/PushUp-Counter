@echo off
setlocal
set "APPDIR=C:\Users\nic21\Documents\GitHub\PushUp-Counter"
set "URL=http://127.0.0.1:4747/control.html"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

call :server_ready
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory '%APPDIR%' -WindowStyle Hidden -PassThru | ForEach-Object { $_.Id } | Set-Content -Encoding ascii '%APPDIR%\.server.pid'"
  for /l %%N in (1,1,20) do (
    call :server_ready
    if not errorlevel 1 goto open
    powershell -NoProfile -Command "Start-Sleep -Milliseconds 500" >nul
  )
  echo The Push-Up Counter server did not come up on port 4747.
  pause
  exit /b 1
)

:open
start "" "%CHROME%" --app="%URL%" --window-size=520,900 --window-position=1180,60
exit /b 0

:server_ready
powershell -NoProfile -Command "try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri 'http://127.0.0.1:4747/api/state').StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
exit /b %errorlevel%
