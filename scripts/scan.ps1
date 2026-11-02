param([string]$Path)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $Path
$bg = $bmp.GetPixel(2, 2)
$minX = 99999; $minY = 99999; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $bmp.Height; $y++) {
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $d = [Math]::Abs($c.R - $bg.R) + [Math]::Abs($c.G - $bg.G) + [Math]::Abs($c.B - $bg.B)
    if ($d -gt 24) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
"bg=$($bg.R),$($bg.G),$($bg.B) content=$minX,$minY -> $maxX,$maxY ($($maxX-$minX+1)x$($maxY-$minY+1))"
$bmp.Dispose()
