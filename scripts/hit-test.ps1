param([int[]]$Points = @())
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class HT3 {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$proc = Get-Process win-island -ErrorAction SilentlyContinue
if (-not $proc) { "app not running"; exit }
$h = $proc.MainWindowHandle
$r = New-Object HT3+RECT
[HT3]::GetWindowRect($h, [ref]$r) | Out-Null
"island hwnd=$h rect=$($r.L),$($r.T) -> $($r.R),$($r.B) visible=$([HT3]::IsWindowVisible($h))"

for ($i = 0; $i + 1 -lt $Points.Count; $i += 2) {
  $x = $Points[$i]; $y = $Points[$i + 1]
  $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
  $res = [HT3]::SendMessage($h, 0x0084, [IntPtr]::Zero, $lp).ToInt64()
  $name = switch ($res) { -1 { "HTTRANSPARENT (click passes through)" } 1 { "HTCLIENT (island)" } default { "code $res" } }
  "point $x,$y -> $name"
}
