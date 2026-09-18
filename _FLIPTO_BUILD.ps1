# Builds the Flip.to whitelabel tracker bundle served at https://cdn.flip.to/public/ftsa2.js.
#
# Produces dist/ftsa2.js and dist/ftsa2.js.map from sp.lite.js. The global namespace below must
# stay in step with Platform's analytics.util.ts, which reads the tracker off window under it.
#
# See _FLIPTO-README.md for what this fork changes and how the bundle reaches the CDN.

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
$defaultNamespace = 'GlobalSnowplowNamespace'

$sourcePath = Join-Path $distFolder $source
$targetPath = Join-Path $distFolder $target
$plainSnapshot = Join-Path $distFolder 'sp.lite.plain.js'

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
foreach ($path in @($sourcePath, "$sourcePath.map", $targetPath, "$targetPath.map", $plainSnapshot)) {
    if (Test-Path $path) {
        Remove-Item $path
    }
}

Invoke-Checked 'rush install' @((Join-Path $repoRoot 'common\scripts\install-run-rush.js'), 'install')
Invoke-Checked 'rush build' @((Join-Path $repoRoot 'common\scripts\install-run-rush.js'), 'build')

# The plain bundle, kept so the whitelabel can be proven to change only the global name.
Copy-Item $sourcePath $plainSnapshot

Push-Location $trackerDir
try {
    Invoke-Checked 'whitelabel build' @(
        (Join-Path $repoRoot 'common\scripts\install-run-rushx.js'), 'build', "--whitelabel=$namespace")
}
finally {
    Pop-Location
}

# The banner is stripped and the sourcemap reference renamed, which is what the served file carries.
# Doing it here rather than by hand is the difference between a deploy that can be verified with a
# byte comparison and one that cannot.
$bannerPattern = '(?s)^/\*!.*?\*/\s*'
foreach ($suffix in @('', '.map')) {
    $from = $sourcePath + $suffix
    $to = $targetPath + $suffix
    if (-not (Test-Path $from)) {
        throw "Expected build output not found: $from"
    }
    $content = (Get-Content $from -Raw).Replace($source, $target)
    if ($suffix -eq '') {
        $content = [regex]::Replace($content, $bannerPattern, '')
    }
    Set-Content $to $content -NoNewline
}

if (-not (Select-String -Path $targetPath -Pattern $namespace -SimpleMatch -Quiet)) {
    throw "$target does not contain $namespace. Platform's loader will not find the tracker."
}
if (Select-String -Path $targetPath -Pattern $defaultNamespace -SimpleMatch -Quiet) {
    throw "$target still contains $defaultNamespace. The whitelabel replace did not apply everywhere."
}

# The whitelabel must change the global name and nothing else. Reversing the token has to reproduce
# the plain bundle exactly; when it does, the event surface measured against sp.lite.js in
# trackers/javascript-tracker/test/surface describes the served file too.
$plain = [regex]::Replace([System.IO.File]::ReadAllText($plainSnapshot), $bannerPattern, '')
$reversed = ([System.IO.File]::ReadAllText($targetPath)).Replace($namespace, $defaultNamespace).Replace($target, $source)
if ($reversed -ne $plain) {
    throw "$target is not the plain bundle with the namespace replaced. The whitelabel changed something else."
}
Remove-Item $plainSnapshot

Write-Host "Built $targetPath"
Write-Host "Whitelabel verified: differs from $source by the global name only."
