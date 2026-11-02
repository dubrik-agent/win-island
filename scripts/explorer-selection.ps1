# Folder + selection of every Explorer window, without closing anything.
$shell = New-Object -ComObject Shell.Application
foreach ($w in $shell.Windows()) {
  try {
    $sel = @($w.Document.SelectedItems() | ForEach-Object { $_.Name })
    $focused = ""
    try { $focused = $w.Document.FocusedItem.Name } catch { }
    "{0} | selected=[{1}] focused={2}" -f $w.LocationURL, ($sel -join ", "), $focused
  } catch { }
}
