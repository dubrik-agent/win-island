$p = Get-Process win-island -ErrorAction SilentlyContinue
if (-not $p) { "app not running"; exit }
$t0 = $p.TotalProcessorTime.TotalMilliseconds
$cores = [Environment]::ProcessorCount
Start-Sleep -Seconds 10
$p.Refresh()
$t1 = $p.TotalProcessorTime.TotalMilliseconds
$used = $t1 - $t0
"idle 10 s: {0:N0} ms CPU over {1} cores -> {2:N2} % of one core" -f $used, $cores, ($used / 100)
"working set: {0:N0} MB" -f ($p.WorkingSet64 / 1MB)
