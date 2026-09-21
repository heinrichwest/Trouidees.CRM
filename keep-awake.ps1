param([double]$Hours = 12)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KeepAwake {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint executionState);
}
"@

$continuous = [Convert]::ToUInt32("80000000", 16)
$systemRequired = [uint32]0x00000001
$deadline = (Get-Date).AddHours([Math]::Max(1, $Hours))

try {
  [KeepAwake]::SetThreadExecutionState($continuous -bor $systemRequired) | Out-Null
  while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 30 }
} finally {
  [KeepAwake]::SetThreadExecutionState($continuous) | Out-Null
}
