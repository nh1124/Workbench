export const WINDOWS_SAMPLER_SCRIPT = String.raw`param(
  [int]$IntervalSeconds = 15
)

$ErrorActionPreference = "SilentlyContinue"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WorkbenchCaptureWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

while ($true) {
  try {
    $handle = [WorkbenchCaptureWin32]::GetForegroundWindow()
    $builder = New-Object System.Text.StringBuilder 1024
    [void][WorkbenchCaptureWin32]::GetWindowText($handle, $builder, $builder.Capacity)
    [uint32]$processId = 0
    [void][WorkbenchCaptureWin32]::GetWindowThreadProcessId($handle, [ref]$processId)
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $record = [ordered]@{
      sampledAt = [DateTime]::UtcNow.ToString("o")
      processName = if ($process) { $process.ProcessName } else { "" }
      windowTitle = $builder.ToString()
    }
    $record | ConvertTo-Json -Compress
  } catch {
    $record = [ordered]@{
      sampledAt = [DateTime]::UtcNow.ToString("o")
      processName = ""
      windowTitle = ""
    }
    $record | ConvertTo-Json -Compress
  }

  Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds))
}
`;

