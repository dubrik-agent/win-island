Add-Type @"
using System; using System.Runtime.InteropServices;
public class RGNT {
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$h = (Get-Process win-island).MainWindowHandle
function Read-Rgn($h) {
  $rgn = [RGNT]::CreateRectRgn(0, 0, 1, 1)
  $kind = [RGNT]::GetWindowRgn($h, $rgn)
  $box = New-Object RGNT+RECT
  [void][RGNT]::GetRgnBox($rgn, [ref]$box)
  [void][RGNT]::DeleteObject($rgn)
  "  kind=$kind box=$($box.L),$($box.T) -> $($box.R),$($box.B)"
}
"before:"; Read-Rgn $h
$r = [RGNT]::CreateRectRgn(10, 5, 110, 35)
$res = [RGNT]::SetWindowRgn($h, $r, $false)
"SetWindowRgn returned $res"
Start-Sleep -Milliseconds 300
"after:"; Read-Rgn $h
