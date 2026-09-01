[CmdletBinding()]
param(
  [string]$Branch = "feature/post-checkout-approval",
  [string]$Scope = "skie1",
  [string]$Project = "skie-events-production",
  [string]$PreviewUrl = "https://skie-events-production-git-feature-post-checkout-approval-skie1.vercel.app",
  [string]$StagingSupabaseUrl = "https://tmfbdnkntafzgmqbqihe.supabase.co"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-SkieSecret {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
  }
  finally {
    $rng.Dispose()
  }
}

function ConvertFrom-SecureValue([Security.SecureString]$Value) {
  return [System.Net.NetworkCredential]::new("", $Value).Password
}

function Invoke-NpxCommand {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$InputText,
    [switch]$Quiet
  )

  # Windows PowerShell converts native stderr into a NativeCommandError record.
  # Vercel writes its harmless version banner to stderr even when the command
  # succeeds, so temporarily use Continue and judge success only by exit code.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($PSBoundParameters.ContainsKey("InputText")) {
      if ($Quiet) {
        $InputText | & npx @Arguments *> $null
      }
      else {
        $InputText | & npx @Arguments
      }
    }
    else {
      if ($Quiet) {
        & npx @Arguments *> $null
      }
      else {
        & npx @Arguments
      }
    }
    return $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Invoke-Vercel {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $exitCode = Invoke-NpxCommand -Arguments (@("vercel") + $Arguments)
  if ($exitCode -ne 0) {
    throw "Vercel command failed: vercel $($Arguments -join ' ')"
  }
}

function Set-BranchEnvironmentVariable {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value,
    [switch]$Sensitive
  )

  $arguments = @("vercel", "env", "add", $Name, "preview", $Branch, "--force", "--scope", $Scope)
  if ($Sensitive) { $arguments += "--sensitive" }

  $exitCode = Invoke-NpxCommand -Arguments $arguments -InputText $Value
  if ($exitCode -ne 0) {
    throw "Failed to set branch-specific Preview variable: $Name"
  }
  Write-Host "Configured $Name for Preview branch $Branch" -ForegroundColor Green
}

$currentBranch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $Branch) {
  throw "Run this script from the $Branch branch. Current branch: $currentBranch"
}

Write-Host "Checking Vercel authentication..." -ForegroundColor Cyan
$whoamiExitCode = Invoke-NpxCommand -Arguments @("vercel", "whoami", "--scope", $Scope) -Quiet
if ($whoamiExitCode -ne 0) {
  Write-Host "Vercel login is required. Complete the browser login, then return here." -ForegroundColor Yellow
  Invoke-Vercel -Arguments @("login", "--scope", $Scope)
}

Write-Host "Linking the local repository to the existing Vercel project..." -ForegroundColor Cyan
Invoke-Vercel -Arguments @("link", "--yes", "--project", $Project, "--scope", $Scope)

Write-Host "Enter STAGING Supabase keys only. Values remain hidden and are never written to the repository." -ForegroundColor Yellow
$publishableSecure = Read-Host "Staging Supabase publishable/anon key" -AsSecureString
$serviceRoleSecure = Read-Host "Staging Supabase secret/service-role key" -AsSecureString
$publishableKey = ConvertFrom-SecureValue $publishableSecure
$serviceRoleKey = ConvertFrom-SecureValue $serviceRoleSecure

if ([string]::IsNullOrWhiteSpace($publishableKey) -or [string]::IsNullOrWhiteSpace($serviceRoleKey)) {
  throw "Both staging Supabase keys are required."
}

$authSecret = New-SkieSecret
$ticketSecret = New-SkieSecret
$notificationWorkerSecret = New-SkieSecret
$postCheckoutWorkerSecret = New-SkieSecret

$plainVariables = [ordered]@{
  APP_MODE = "live"
  DATA_PROVIDER = "supabase"
  NEXT_PUBLIC_SITE_URL = $PreviewUrl
  NEXT_PUBLIC_BRAND_NAME = "SKIE EVENTS"
  NEXT_PUBLIC_SUPABASE_URL = $StagingSupabaseUrl
  APP_TIMEZONE = "Australia/Melbourne"
  APP_CURRENCY = "AUD"
  POST_CHECKOUT_APPROVAL_ENABLED = "false"
  POST_CHECKOUT_FORM_MINUTES = "120"
  POST_CHECKOUT_REVIEW_HOURS = "24"
  POST_CHECKOUT_CAPTURE_SAFETY_MINUTES = "60"
  EMAIL_PROVIDER = "local"
  EMAIL_FROM = "SKIE EVENTS <tickets@skieevents.com>"
  EMAIL_REPLY_TO = "hello@skieevents.com"
  SMS_PROVIDER = "local"
  NOTIFICATION_DEFAULT_COUNTRY = "AU"
  MEDIA_VIDEO_PROVIDER = "local"
  WHATSAPP_NOTIFICATIONS_ENABLED = "false"
}

$sensitiveVariables = [ordered]@{
  NEXT_PUBLIC_SUPABASE_ANON_KEY = $publishableKey
  SUPABASE_SERVICE_ROLE_KEY = $serviceRoleKey
  AUTH_SECRET = $authSecret
  TICKET_TOKEN_SECRET = $ticketSecret
  NOTIFICATION_WORKER_SECRET = $notificationWorkerSecret
  POST_CHECKOUT_WORKER_SECRET = $postCheckoutWorkerSecret
}

Write-Host "Applying branch-specific Preview variables..." -ForegroundColor Cyan
foreach ($entry in $plainVariables.GetEnumerator()) {
  Set-BranchEnvironmentVariable -Name $entry.Key -Value $entry.Value
}
foreach ($entry in $sensitiveVariables.GetEnumerator()) {
  Set-BranchEnvironmentVariable -Name $entry.Key -Value $entry.Value -Sensitive
}

$publishableKey = $null
$serviceRoleKey = $null
$authSecret = $null
$ticketSecret = $null
$notificationWorkerSecret = $null
$postCheckoutWorkerSecret = $null

Write-Host "Listing branch-specific Preview variable names..." -ForegroundColor Cyan
$envListExitCode = Invoke-NpxCommand -Arguments @("vercel", "env", "ls", "preview", $Branch, "--scope", $Scope)
if ($envListExitCode -ne 0) {
  Write-Warning "Vercel could not display the optional environment-variable list. Configuration already succeeded, so continuing to redeploy."
}

Write-Host "Redeploying the stable Preview branch deployment with the new environment..." -ForegroundColor Cyan
Invoke-Vercel -Arguments @("redeploy", $PreviewUrl, "--target=preview", "--scope", $Scope)

Write-Host "Staging Preview configuration submitted successfully." -ForegroundColor Green
Write-Host "Preview URL: $PreviewUrl"
Write-Host "POST_CHECKOUT_APPROVAL_ENABLED remains false. Stripe has not been connected." -ForegroundColor Yellow
