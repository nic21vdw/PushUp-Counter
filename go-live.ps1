$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$overlay = 'http://127.0.0.1:4747/overlay.html'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) {
    $chrome = Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
}

function Test-CounterUp {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', 4747, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(150, $false)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $c.Close()
    }
}

if (-not (Test-CounterUp)) {
    $cmd = Join-Path $repo 'start-counter.cmd'
    Start-Process -FilePath $cmd -WorkingDirectory $repo -WindowStyle Minimized
    $deadline = (Get-Date).AddSeconds(8)
    while (-not (Test-CounterUp)) {
        if ((Get-Date) -gt $deadline) { break }
        Start-Sleep -Milliseconds 100
    }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    Start-Process -FilePath $node `
        -ArgumentList (Join-Path $repo 'go-live-obs.mjs') `
        -WorkingDirectory $repo `
        -WindowStyle Hidden
}

$tracker = Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like '*Push-Up Tracker*' } |
    Select-Object -First 1

if ($tracker) {
    $w = New-Object -ComObject WScript.Shell
    [void]$w.AppActivate($tracker.Id)
} elseif (Test-Path $chrome) {
    Start-Process -FilePath $chrome -ArgumentList '--new-window', $overlay
} else {
    Start-Process $overlay
}
