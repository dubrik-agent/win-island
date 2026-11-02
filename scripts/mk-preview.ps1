Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 240, 140
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 60, 140, 200))
$g.FillEllipse([System.Drawing.Brushes]::Orange, 40, 30, 90, 80)
$out = Join-Path $env:TEMP "preview-test.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$out
