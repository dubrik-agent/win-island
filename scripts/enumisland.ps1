Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class ENUM3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$target = (Get-Process win-island).Id
$rows = New-Object System.Collections.ArrayList
$cb = [ENUM3+EnumProc] {
  param($h, $l)
  $pid2 = 0
  [void][ENUM3]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($pid2 -eq $target) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][ENUM3]::GetClassName($h, $sb, 256)
    $tx = New-Object System.Text.StringBuilder 256
    [void][ENUM3]::GetWindowTextW($h, $tx, 256)
    $r = New-Object ENUM3+RECT
    [void][ENUM3]::GetWindowRect($h, [ref]$r)
    $rgn = [ENUM3]::CreateRectRgn(0, 0, 1, 1)
    $kind = [ENUM3]::GetWindowRgn($h, $rgn)
    $box = New-Object ENUM3+RECT
    [void][ENUM3]::GetRgnBox($rgn, [ref]$box)
    [void][ENUM3]::DeleteObject($rgn)
    [void]$rows.Add("hwnd=$h vis=$([ENUM3]::IsWindowVisible($h)) class=$($sb.ToString()) title='$($tx.ToString())' rect=$($r.L),$($r.T)->$($r.R),$($r.B) rgnKind=$kind rgn=$($box.L),$($box.T)->$($box.R),$($box.B)")
  }
  return $true
}
[void][ENUM3]::EnumWindows($cb, [IntPtr]::Zero)
$rows
