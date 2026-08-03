export const WINDOWS_SAMPLER_SCRIPT = String.raw`param(
  [int]$IntervalSeconds = 15
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$ErrorActionPreference = "SilentlyContinue"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WorkbenchCaptureWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO lastInputInfo);

  public static uint GetIdleSeconds() {
    var lastInputInfo = new LASTINPUTINFO();
    lastInputInfo.cbSize = (uint)Marshal.SizeOf(lastInputInfo);
    if (!GetLastInputInfo(ref lastInputInfo)) return 0;
    return unchecked((uint)Environment.TickCount - lastInputInfo.dwTime) / 1000;
  }
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
      idleSeconds = [WorkbenchCaptureWin32]::GetIdleSeconds()
    }
    $record | ConvertTo-Json -Compress
  } catch {
    $record = [ordered]@{
      sampledAt = [DateTime]::UtcNow.ToString("o")
      processName = ""
      windowTitle = ""
      idleSeconds = 0
    }
    $record | ConvertTo-Json -Compress
  }

  Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds))
}
`;

