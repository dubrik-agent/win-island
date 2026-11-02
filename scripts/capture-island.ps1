Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IslandCap {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@

$found = [IntPtr]::Zero
$callback = [IslandCap+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [IslandCap]::GetClassName($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq "Tauri Window") {
    $script:found = $h
    return $false
  }
  return $true
}
[IslandCap]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { Write-Output "no Tauri Window found"; exit 1 }

$rect = New-Object IslandCap+RECT
[IslandCap]::GetWindowRect($found, [ref]$rect) | Out-Null
$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [IslandCap]::PrintWindow($found, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
$out = Join-Path $PSScriptRoot '..\data\window.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$ok $out ${w}x${h}"
