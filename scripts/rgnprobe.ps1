Add-Type @"
using System; using System.Runtime.InteropServices;
public class RGN2 {
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$proc = Get-Process win-island -ErrorAction SilentlyContinue
if (-not $proc) { "app not running"; exit }
$h = $proc.MainWindowHandle
$rgn = [RGN2]::CreateRectRgn(0, 0, 1, 1)
$kind = [RGN2]::GetWindowRgn($h, $rgn)
$box = New-Object RGN2+RECT
[void][RGN2]::GetRgnBox($rgn, [ref]$box)
"region kind=$kind box=$($box.L),$($box.T) -> $($box.R),$($box.B)"
[void][RGN2]::DeleteObject($rgn)
