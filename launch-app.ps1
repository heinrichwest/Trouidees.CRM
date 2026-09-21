param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$appUrl = "http://127.0.0.1:4173"
$healthUrl = "$appUrl/api/health"
$logsDirectory = Join-Path $PSScriptRoot "data\logs"

function Test-AppHealth {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

try {
  if (-not (Test-AppHealth)) {
    $node = Get-Command node.exe -ErrorAction Stop
    New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
    $outputLog = Join-Path $logsDirectory "server.log"
    $errorLog = Join-Path $logsDirectory "server-error.log"
    $server = Start-Process -FilePath $node.Source `
      -ArgumentList "--env-file-if-exists=.env", "server.mjs" `
      -WorkingDirectory $PSScriptRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $outputLog `
      -RedirectStandardError $errorLog `
      -PassThru

    for ($attempt = 0; $attempt -lt 40 -and -not (Test-AppHealth); $attempt += 1) {
      if ($server.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }

    if (-not (Test-AppHealth)) {
      throw "The local server could not start. See $errorLog"
    }
  }

  if (-not $NoBrowser) {
    Start-Process $appUrl
  }
  Write-Output "Prospect Intelligence Desk is ready at $appUrl"
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, "Prospect Intelligence Desk", "OK", "Error") | Out-Null
  exit 1
}
