$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$port = 3213
$baseUrl = "http://127.0.0.1:$port"
$browserProfile = Join-Path $env:TEMP "skie-phase3-browser-profile"
$browserOutput = Join-Path $env:TEMP "skie-phase3-browser-dom.html"
$browserError = Join-Path $env:TEMP "skie-phase3-browser-error.log"
$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
)
$edge = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $edge) {
  throw "Microsoft Edge is required for the Phase 3 browser smoke test."
}

function Get-BrowserDom([string]$Path) {
  $url = "$baseUrl$Path"
  $browserProcess = Start-Process -FilePath $edge `
    -ArgumentList @("--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=$browserProfile", "--dump-dom", $url) `
    -RedirectStandardOutput $browserOutput `
    -RedirectStandardError $browserError `
    -WindowStyle Hidden `
    -PassThru `
    -Wait
  if ($browserProcess.ExitCode -ne 0) {
    throw "The browser could not load the local path $Path."
  }
  return Get-Content -LiteralPath $browserOutput -Raw
}

function Assert-Contains([string]$Actual, [string]$Expected, [string]$Label) {
  if (-not $Actual.Contains($Expected)) {
    throw "$Label did not contain the expected safe page marker."
  }
  Write-Host "PASS $Label"
}

function Stop-StartedProcessTree([int]$RootProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-StartedProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

$previousMode = $env:APP_MODE
$previousProvider = $env:DATA_PROVIDER
$previousSiteUrl = $env:NEXT_PUBLIC_SITE_URL
$server = $null

try {
  $env:APP_MODE = "test"
  $env:DATA_PROVIDER = "local"
  $env:NEXT_PUBLIC_SITE_URL = $baseUrl

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $server = Start-Process -FilePath $npm `
    -ArgumentList @("run", "dev", "--", "--hostname", "127.0.0.1", "--port", "$port") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($server.HasExited) {
      throw "The local Next.js server exited before the browser test began."
    }
    try {
      $response = Invoke-WebRequest -Uri "$baseUrl/events" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    throw "The local Next.js server did not become ready for the browser test."
  }

  $eventsDom = Get-BrowserDom "/events"
  Assert-Contains $eventsDom "Redline House Party" "public event listing"
  Assert-Contains $eventsDom "Skip to main content" "public skip link"
  Assert-Contains $eventsDom 'id="main-content"' "public main landmark target"
  Assert-Contains $eventsDom 'aria-label="Main navigation"' "labelled main navigation"
  Assert-Contains $eventsDom "Events - SKIE EVENTS" "meaningful events page title"

  $homeDom = Get-BrowserDom "/"
  Assert-Contains $homeDom "Play featured slides" "reduced-motion-safe carousel control"

  $accountDom = Get-BrowserDom "/account"
  Assert-Contains $accountDom "Log back into the night." "protected account redirect"
  Assert-Contains $accountDom "/signup?next=%2Faccount" "account return path"

  $checkoutDom = Get-BrowserDom "/checkout/event/redline-house-party"
  Assert-Contains $checkoutDom "Log back into the night." "protected checkout redirect"
  Assert-Contains $checkoutDom "/signup?next=%2Fcheckout%2Fevent%2Fredline-house-party" "checkout return path"

  $unsafeNextDom = Get-BrowserDom "/login?next=https%3A%2F%2Fexample.invalid"
  Assert-Contains $unsafeNextDom "/signup?next=%2Faccount" "external return-path rejection"

  $paymentDom = Get-BrowserDom "/payment/success"
  Assert-Contains $paymentDom 'aria-live="polite"' "payment status live region"
  Assert-Contains $paymentDom "Payment status - SKIE EVENTS" "meaningful payment status title"
  Write-Host "PASS Phase 3 local browser smoke test"
} finally {
  if ($server) { Stop-StartedProcessTree $server.Id }
  $env:APP_MODE = $previousMode
  $env:DATA_PROVIDER = $previousProvider
  $env:NEXT_PUBLIC_SITE_URL = $previousSiteUrl
}
