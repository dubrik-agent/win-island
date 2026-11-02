# Reads the folder + selection of every open Explorer window (COM, no UI clicks)
# and closes the ones pointing at the temporary reveal-* test folders.
$shell = New-Object -ComObject Shell.Application
$rows = @()
foreach ($w in $shell.Windows()) {
  try {
    $url = $w.LocationURL
    $sel = @($w.Document.SelectedItems() | ForEach-Object { $_.Name })
    $rows += [pscustomobject]@{ Folder = $url; Selected = ($sel -join ", ") }
  } catch { }
}
if ($rows.Count -eq 0) {
  "no explorer windows"
} else {
  $rows | Format-Table -AutoSize | Out-String -Width 200
}
# Close only the test windows so the user's own Explorer windows stay untouched.
foreach ($w in @($shell.Windows())) {
  try {
    if ($w.LocationURL -match "reveal-a|reveal-b") { $w.Quit() }
  } catch { }
}
