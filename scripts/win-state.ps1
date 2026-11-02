param([int[]]$Points = @())
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class HT2 {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$proc = Get-Process win-island -ErrorAction SilentlyContinue
if (-not $proc) { "app not running"; exit }
$h = $proc.MainWindowHandle
$r = New-Object HT2+RECT
[HT2]::GetWindowRect($h, [ref]$r) | Out-Null
$sb = New-Object System.Text.StringBuilder 256
[HT2]::GetClassName($h, $sb, 256) | Out-Null
"island hwnd=$h class=$($sb.ToString()) rect=$($r.L),$($r.T) -> $($r.R),$($r.B) visible=$([HT2]::IsWindowVisible($h))"

for ($i = 0; $i + 1 -lt $Points.Count; $i += 2) {
  $pt = New-Object HT2+POINT
  $pt.X = $Points[$i]; $pt.Y = $Points[$i + 1]
  $w = [HT2]::WindowFromPoint($pt)
  $root = [HT2]::GetAncestor($w, 2)
  $cls = New-Object System.Text.StringBuilder 256
  if ($root -ne [IntPtr]::Zero) { [HT2]::GetClassName($root, $cls, 256) | Out-Null }
  "point $($pt.X),$($pt.Y) -> hwnd=$root class=$($cls.ToString())"
}
