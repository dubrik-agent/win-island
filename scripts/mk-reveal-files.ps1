$dir1 = Join-Path $env:TEMP "opencode\reveal-a"
$dir2 = Join-Path $env:TEMP "opencode\reveal-b"
New-Item -ItemType Directory -Force -Path $dir1, $dir2 | Out-Null
$f1 = Join-Path $dir1 "same-name.txt"
$f2 = Join-Path $dir2 "same-name.txt"
Set-Content -Path $f1 -Value "a" -Encoding UTF8
Set-Content -Path $f2 -Value "b" -Encoding UTF8
"$f1`n$f2"
