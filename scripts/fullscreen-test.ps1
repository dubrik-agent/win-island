Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class FS2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

function Describe($h) {
  if ($h -eq [IntPtr]::Zero) { return "no foreground" }
  $r = New-Object FS2+RECT
  [FS2]::GetWindowRect($h, [ref]$r) | Out-Null
  $sb = New-Object System.Text.StringBuilder 256
  [FS2]::GetClassName($h, $sb, 256) | Out-Null
  "fg hwnd=$h class=$($sb.ToString()) rect=$($r.L),$($r.T)-$($r.R),$($r.B)"
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = "None"
$form.Bounds = $bounds
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 32)
$form.Show()
$form.Activate()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 500
"screen: $($bounds.Width)x$($bounds.Height) at $($bounds.X),$($bounds.Y)"
Describe ([FS2]::GetForegroundWindow())

Start-Sleep -Milliseconds 2200
$h = (Get-Process win-island).MainWindowHandle
"island hwnd=$h visible=" + $(if ($h -eq 0) { "False (hidden)" } else { [FS2]::IsWindowVisible($h) })

$form.Close()
$form.Dispose()
Start-Sleep -Milliseconds 2200
$h = (Get-Process win-island).MainWindowHandle
"after close: island hwnd=$h visible=" + $(if ($h -eq 0) { "False" } else { [FS2]::IsWindowVisible($h) })
