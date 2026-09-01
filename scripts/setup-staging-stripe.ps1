[CmdletBinding()]
param(
  [string]$Branch = "feature/post-checkout-approval",
  [string]$Scope = "skie1",
  [string]$PreviewUrl = "https://skie-events-production-git-feature-post-checkout-approval-skie1.vercel.app"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertFrom-SecureValue([Security.SecureString]$Value) {
  return [System.Net.NetworkCredential]::new("", $Value).Password
}

function Invoke-NpxCommand {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$InputText,
    [switch]$Quiet
  )

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    if ($PSBoundParameters.ContainsKey("InputText")) {
      if ($Quiet) { $InputText | & npx @Arguments *> $null }
      else { $InputText | & npx @Arguments }
    }
    else {
      if ($Quiet) { & npx @Arguments *> $null }
      else { & npx @Arguments }
    }
    return $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
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
  if ($exitCode -ne 0) { throw "Failed to set branch-specific Preview variable: $Name" }
  Write-Host "Configured $Name for Preview branch $Branch" -ForegroundColor Green
}

$currentBranch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $Branch) {
  throw "Run this script from the $Branch branch. Current branch: $currentBranch"
}

Write-Host "Enter STRIPE TEST-MODE values only. Nothing is written to the repository." -ForegroundColor Yellow
$publishableSecure = Read-Host "Stripe test publishable key (pk_test_...)" -AsSecureString
$secretSecure = Read-Host "Stripe test secret key (sk_test_...)" -AsSecureString
$webhookSecure = Read-Host "Stripe test webhook signing secret (whsec_...)" -AsSecureString

$publishableKey = ConvertFrom-SecureValue $publishableSecure
$secretKey = ConvertFrom-SecureValue $secretSecure
$webhookSecret = ConvertFrom-SecureValue $webhookSecure

if (-not $publishableKey.StartsWith("pk_test_")) { throw "Publishable key must be a Stripe test key beginning pk_test_." }
if (-not $secretKey.StartsWith("sk_test_")) { throw "Secret key must be a Stripe test key beginning sk_test_." }
if (-not $webhookSecret.StartsWith("whsec_")) { throw "Webhook secret must begin whsec_." }

Set-BranchEnvironmentVariable -Name "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY" -Value $publishableKey -Sensitive
Set-BranchEnvironmentVariable -Name "STRIPE_SECRET_KEY" -Value $secretKey -Sensitive
Set-BranchEnvironmentVariable -Name "STRIPE_WEBHOOK_SECRET" -Value $webhookSecret -Sensitive
Set-BranchEnvironmentVariable -Name "POST_CHECKOUT_APPROVAL_ENABLED" -Value "true"

$publishableKey = $null
$secretKey = $null
$webhookSecret = $null

Write-Host "Stripe test mode configured. Redeploying Preview..." -ForegroundColor Cyan
$redeployExitCode = Invoke-NpxCommand -Arguments @("vercel", "redeploy", $PreviewUrl, "--target=preview", "--scope", $Scope)
if ($redeployExitCode -ne 0) { throw "Vercel Preview redeployment failed." }

Write-Host "Staging Stripe configuration submitted successfully." -ForegroundColor Green
Write-Host "Preview URL: $PreviewUrl"
Write-Host "POST_CHECKOUT_APPROVAL_ENABLED is true for this Preview branch only." -ForegroundColor Yellow
Write-Host "Production environment variables were not changed." -ForegroundColor Green
