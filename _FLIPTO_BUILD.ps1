# Builds the Flip.to whitelabel tracker bundle served at https://cdn.flip.to/public/ftsa2.js.
#
# Produces dist/ftsa2.js and dist/ftsa2.js.map from sp.lite.js. The global namespace below must
# stay in step with Platform's analytics.util.ts, which reads the tracker off window under it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# rush exits non-zero on a build that only produced warnings, and a stale caniuse-lite warns on
# every package. The CI workflows set the same variable for the same reason.
$env:BROWSERSLIST_IGNORE_OLD_DATA = 'true'

$repoRoot = $PSScriptRoot
$trackerDir = Join-Path $repoRoot 'trackers\javascript-tracker'
$distFolder = Join-Path $trackerDir 'dist'

$source = 'sp.lite.js'
$target = 'ftsa2.js'
$namespace = 'ftSpacetimeGlobalNamespace'

$sourcePath = Join-Path $distFolder $source
$targetPath = Join-Path $distFolder $target

# $ErrorActionPreference does not apply to native commands, so every exit code is checked by hand.
# Without this the script reported success over a failed rollup and shipped the previous build.
function Invoke-Checked {
    param([string]$Description, [string[]]$Arguments)

    & node @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

# A stale bundle must not survive a failed build and be copied as if it were fresh.
foreach ($path in @($sourcePath, "$sourcePath.map", $targetPath, "$targetPath.map")) {
    if (Test-Path $path) {
        Remove-Item $path
    }
}

Invoke-Checked 'rush install' @((Join-Path $repoRoot 'common\scripts\install-run-rush.js'), 'install')
Invoke-Checked 'rush build' @((Join-Path $repoRoot 'common\scripts\install-run-rush.js'), 'build')

Push-Location $trackerDir
try {
    Invoke-Checked 'whitelabel build' @(
        (Join-Path $repoRoot 'common\scripts\install-run-rushx.js'), 'build', "--whitelabel=$namespace")
}
finally {
    Pop-Location
}

foreach ($suffix in @('', '.map')) {
    $from = $sourcePath + $suffix
    $to = $targetPath + $suffix
    if (-not (Test-Path $from)) {
        throw "Expected build output not found: $from"
    }
    (Get-Content $from -Raw).Replace($source, $target) | Set-Content $to -NoNewline
}

if (-not (Select-String -Path $targetPath -Pattern $namespace -SimpleMatch -Quiet)) {
    throw "$target does not contain $namespace. Platform's loader will not find the tracker."
}

Write-Host "Built $targetPath"
