param([string]$Key = "h")
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class HK2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
}
"@
$VK_CONTROL = 0x11
$VK_MENU = 0x12
$KEYEVENTF_KEYUP = 0x0002

function Get-IslandHwnd {
  $proc = Get-Process win-island -ErrorAction SilentlyContinue
  if (-not $proc) { return [IntPtr]::Zero }
  $targetPid = $proc.Id
  $script:found = [IntPtr]::Zero
  $cb = [HK2+EnumProc]{
    param($h, $l)
    $p = 0
    [HK2]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    if ($p -eq $targetPid) {
      $sb = New-Object System.Text.StringBuilder 256
      [HK2]::GetClassName($h, $sb, 256) | Out-Null
      if ($sb.ToString() -eq "Tauri Window") { $script:found = $h }
    }
    return $true
  }
  [HK2]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

function Tap([byte]$vk) {
  [HK2]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  [HK2]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
  [HK2]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [HK2]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  [HK2]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  [HK2]::keybd_event($VK_CONTROL, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

$vk = [byte][char]$Key.ToUpper()
$ok = [HK2]::RegisterHotKey([IntPtr]::Zero, 9911, 0x0003, $vk)
if ($ok) { "Ctrl+Alt+$($Key.ToUpper()) is FREE -> not registered by app"; [HK2]::UnregisterHotKey([IntPtr]::Zero, 9911) | Out-Null }
else { "Ctrl+Alt+$($Key.ToUpper()) registered by app (err=" + [HK2]::GetLastError() + ")" }

$h = Get-IslandHwnd
"hwnd=$h start visible=" + $(if ($h -eq [IntPtr]::Zero) { "no window" } else { [HK2]::IsWindowVisible($h) })
Tap $vk
$seen = @()
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 150
  $h = Get-IslandHwnd
  $seen += $(if ($h -eq [IntPtr]::Zero) { "none" } else { [HK2]::IsWindowVisible($h) })
}
"after hotkey -> " + ($seen -join ",")
