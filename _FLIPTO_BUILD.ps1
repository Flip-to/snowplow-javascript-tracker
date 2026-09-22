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

$rush = Join-Path $repoRoot 'common\scripts\install-run-rush.js'
$rushx = Join-Path $repoRoot 'common\scripts\install-run-rushx.js'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# $ErrorActionPreference does not apply to native commands, so every exit code is checked by hand.
# Without this the script reported success over a failed rollup and shipped the previous build.
function Invoke-NodeChecked {
    param([string]$Description, [string[]]$Arguments)

    & node @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

# A stale bundle must not survive a failed build and be copied as if it were fresh. The whitelabel
# loaders are on this list because they are written while rollup evaluates its config, so a build
# that then fails still leaves them behind.
foreach ($path in @(
        $sourcePath,
        "$sourcePath.map",
        $targetPath,
        "$targetPath.map",
        $plainSnapshot,
        (Join-Path $distFolder 'tag.js'),
        (Join-Path $distFolder 'tag.min.js'))) {
    if (Test-Path $path) {
        Remove-Item $path
    }
}

Invoke-NodeChecked 'rush install' @($rush, 'install')

# Dependencies only. The tracker itself is built with rushx below, because rush build is
# incremental against git-tracked inputs and dist is gitignored, so deleting the bundle above does
# not invalidate the project and a second run would skip it and leave nothing to copy.
# --to-except also keeps a cold run from building the expensive project three times.
Invoke-NodeChecked 'rush build' @($rush, 'build', '--to-except', '@snowplow/javascript-tracker')

Push-Location $trackerDir
try {
    Invoke-NodeChecked 'plain build' @($rushx, 'build')

    # Kept so the whitelabel can be proven to change only the global name.
    Copy-Item $sourcePath $plainSnapshot

    Invoke-NodeChecked 'whitelabel build' @($rushx, 'build', "--whitelabel=$namespace")
}
finally {
    Pop-Location
}

# Only the sourcemap reference is rewritten. The banner stays: its six newlines put the bundle on
# generated line 7, which is where sp.lite.js.map's six leading semicolons expect it, so stripping
# it shifts every mapping in the published sourcemap. It also carries the BSD-3-Clause notice,
# which a redistributed build should keep.
foreach ($suffix in @('', '.map')) {
    $from = $sourcePath + $suffix
    $to = $targetPath + $suffix
    if (-not (Test-Path $from)) {
        throw "Expected build output not found: $from"
    }
    $content = [System.IO.File]::ReadAllText($from).Replace($source, $target)
    [System.IO.File]::WriteAllText($to, $content, $utf8NoBom)
}

$built = [System.IO.File]::ReadAllText($targetPath)

# IndexOf with an ordinal comparison, rather than -like or Contains. -like would parse *, ? and [
# out of an interpolated namespace, and the two-argument Contains overload is .NET Core only, so it
# throws on Windows PowerShell 5.1 after the build has already run.
if ($built.IndexOf($namespace, [System.StringComparison]::Ordinal) -lt 0) {
    throw "$target does not contain $namespace. Platform's loader will not find the tracker."
}
if ($built.IndexOf($defaultNamespace, [System.StringComparison]::Ordinal) -ge 0) {
    throw "$target still contains $defaultNamespace. The whitelabel replace did not apply everywhere."
}

# The whitelabel must change the global name and nothing else. Reversing the token has to reproduce
# the plain bundle exactly; when it does, the event surface measured against sp.lite.js in
# trackers/javascript-tracker/test/surface describes the served file too.
#
# String.Equals with an ordinal comparison, not -ne: PowerShell's comparison operators are
# case-insensitive, so two bundles differing only in identifier casing compare equal. The
# whitelabel token is two characters longer than the default, which is enough for terser to
# reallocate identifiers, and a casing shift is exactly what this is here to catch.
$plain = [System.IO.File]::ReadAllText($plainSnapshot)
$reversed = $built.Replace($namespace, $defaultNamespace).Replace($target, $source)
if (-not [string]::Equals($reversed, $plain, [System.StringComparison]::Ordinal)) {
    throw "$target is not the plain bundle with the namespace replaced. The whitelabel changed something else."
}
Remove-Item $plainSnapshot

Write-Host "Built $targetPath"
Write-Host "Whitelabel verified: differs from $source by the global name only."
