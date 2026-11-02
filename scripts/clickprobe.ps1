param([int[]]$Points = @())
# DPI-aware hit-test probe. Without per-monitor awareness WindowFromPoint and
# GetWindowRgn answer in virtualized coordinates, which makes a correct region
# look broken (this cost me an hour). Awareness must be set before any window
# is created in this process, hence the very first call.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WP4 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
$aware = [WP4]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not $aware) { $aware = [WP4]::SetProcessDPIAware() }

$proc = Get-Process win-island -ErrorAction SilentlyContinue
if (-not $proc) { "app not running"; exit }
$h = $proc.MainWindowHandle
$r = New-Object WP4+RECT
[void][WP4]::GetWindowRect($h, [ref]$r)
$ex = [WP4]::GetWindowLongPtr($h, -20).ToInt64()
$tool = if ($ex -band 0x80) { "WS_EX_TOOLWINDOW" } else { "no toolwindow" }
$rgn = [WP4]::CreateRectRgn(0, 0, 1, 1)
$kind = [WP4]::GetWindowRgn($h, $rgn)
$box = New-Object WP4+RECT
[void][WP4]::GetRgnBox($rgn, [ref]$box)
[void][WP4]::DeleteObject($rgn)
"dpiAware=$aware windowDpi=$([WP4]::GetDpiForWindow($h))"
"island hwnd=$h rect=$($r.L),$($r.T) -> $($r.R),$($r.B) ($($r.R - $r.L)x$($r.B - $r.T)) visible=$([WP4]::IsWindowVisible($h)) exstyle=0x$($ex.ToString('X')) $tool"
"region kind=$kind box=$($box.L),$($box.T) -> $($box.R),$($box.B) ($($box.R - $box.L)x$($box.B - $box.T))"

function Describe([int]$x, [int]$y) {
  $p = New-Object WP4+POINT
  $p.X = $x; $p.Y = $y
  $w = [WP4]::WindowFromPoint($p)
  if ($w -eq [IntPtr]::Zero) { return "point $x,$y -> <none>" }
  $sb = New-Object System.Text.StringBuilder 256
  [void][WP4]::GetClassName($w, $sb, 256)
  $procId = 0
  [void][WP4]::GetWindowThreadProcessId($w, [ref]$procId)
  $name = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "?" }
  $owner = if ($procId -eq $proc.Id) { "  <-- ISLAND" } else { "" }
  "point $x,$y -> $($sb.ToString()) [$name : $procId]$owner"
}

if ($Points.Count -eq 0) {
  $cx = [int](($r.L + $r.R) / 2)
  for ($y = $r.T; $y -le $r.B; $y += 4) { Describe $cx $y }
  Describe ($r.L + 2) ([int](($r.T + $r.B) / 2))
  Describe ($r.R - 2) ([int](($r.T + $r.B) / 2))
} else {
  for ($i = 0; $i + 1 -lt $Points.Count; $i += 2) { Describe $Points[$i] $Points[$i + 1] }
}
