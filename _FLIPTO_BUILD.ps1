$distFolder = "C:\Git\snowplow-javascript-tracker\trackers\javascript-tracker\dist\"
$spLite = "sp.lite.js"
$ftSa = "ftsa.js"
$spLitePath = $distFolder + $spLite
$spLiteMapPath = $spLitePath + ".map"
$ftSaPath = $distFolder + $ftSa
$ftsaMapPath = $ftSaPath + ".map";

cd C:\Git\snowplow-javascript-tracker\
rush build
if (Test-Path $ftSaPath) {
  Remove-Item $ftSaPath
}
if (Test-Path $ftsaMapPath) {
  Remove-Item $ftsaMapPath
}

# rush update
cd .\trackers\javascript-tracker\
rushx build --whitelabel=ftSpacetimeGlobalNamespace

(Get-Content $spLitePath).Replace($spLite, $ftSa) | Set-Content $ftSaPath
(Get-Content $spLiteMapPath).Replace($spLite, $ftSa) | Set-Content $ftsaMapPath

cd C:\Git\snowplow-javascript-tracker\