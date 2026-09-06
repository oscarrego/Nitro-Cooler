$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serviceManifest = Join-Path $projectRoot 'aeroforge-service\Cargo.toml'
$tauriManifest = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$serviceExe = Join-Path $projectRoot 'aeroforge-service\target\release\aeroforge-service.exe'
$helperExe = Join-Path $projectRoot 'src-tauri\target\release\aeroforge-hotkey-helper.exe'
$installerServiceScript = Join-Path $projectRoot 'src-tauri\resources\Install-AeroForgeBundledService.ps1'
$pawnIoSetup = Join-Path $projectRoot 'third_party\pawnio\PawnIO_setup.exe'
$intelMsrModule = Join-Path $projectRoot 'third_party\pawnio-modules\IntelMSR.bin'
$webView2Loader = Join-Path $projectRoot 'src-tauri\target\release\WebView2Loader.dll'
$webView2LoaderSource = Join-Path $projectRoot 'src-tauri\target\release\build\webview2-com-sys-f11524e41924e515\out\x64\WebView2Loader.dll'

function Resolve-CargoPath {
  $fallbacks = @(
    'C:\Users\noah\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe',
    'C:\Users\noah\.cargo\bin\cargo.exe'
  )

  foreach ($candidate in $fallbacks) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  $cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
  if ($cargoCommand) {
    return $cargoCommand.Source
  }

  throw 'Unable to locate cargo.exe. Install or repair the Rust toolchain path first.'
}

$cargoPath = Resolve-CargoPath

# Tauri validates declared bundle resources while compiling helper binaries. Stage the
# architecture-matched WebView2 loader before that validation so a clean checkout can build.
if (-not (Test-Path -LiteralPath $webView2Loader)) {
  if (-not (Test-Path -LiteralPath $webView2LoaderSource)) {
    throw "WebView2 loader source missing: $webView2LoaderSource"
  }
  Copy-Item -LiteralPath $webView2LoaderSource -Destination $webView2Loader -Force
}

# The helper is itself a declared bundle resource. A placeholder lets Tauri's build
# script validate the resource while Cargo compiles the real helper executable.
if (-not (Test-Path -LiteralPath $helperExe)) {
  New-Item -ItemType File -Path $helperExe -Force | Out-Null
}

& $cargoPath build --release --manifest-path $serviceManifest
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to build aeroforge-service.exe.'
}

& $cargoPath build --release --manifest-path $tauriManifest --bin aeroforge-hotkey-helper
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to build aeroforge-hotkey-helper.exe.'
}

foreach ($requiredPath in @($serviceExe, $helperExe, $installerServiceScript, $pawnIoSetup, $intelMsrModule, $webView2Loader)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required bundle resource missing: $requiredPath"
  }
}

Write-Output "Prepared bundle resources:"
Write-Output "  $serviceExe"
Write-Output "  $helperExe"
Write-Output "  $installerServiceScript"
Write-Output "  $pawnIoSetup"
Write-Output "  $intelMsrModule"
Write-Output "  $webView2Loader"
