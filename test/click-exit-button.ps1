param([int]$TargetProcessId = 0)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YTTestNativeButton {
    [DllImport("user32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

if ($TargetProcessId) {
    $processes = @(Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)
} else {
    if (!$env:YT_VERIFIED_EXE) { throw 'Missing disposable installed executable path.' }
    $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:YT_VERIFIED_EXE })
}
foreach ($p in $processes) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($window in $windows) {
        $buttonCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '关闭浏览器并退出')
        $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
        foreach ($button in $buttons) {
            $pattern = $null
            if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                $pattern.Invoke()
                "INVOKED UIAutomation PID=$($p.Id)"
                exit 0
            }
            # Windows TaskDialog's CCPushButton may expose no InvokePattern.
            # Send BM_CLICK to the real button HWND, not a mocked dialog response.
            # https://learn.microsoft.com/en-us/windows/win32/controls/bm-click
            if ($button.Current.ClassName -eq 'CCPushButton' -and $button.Current.NativeWindowHandle -ne 0 -and $button.Current.ProcessId -eq $p.Id) {
                $sent = [YTTestNativeButton]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 245, [IntPtr]::Zero, [IntPtr]::Zero)
                if (!$sent) { throw 'Failed to send native button click.' }
                "INVOKED BM_CLICK PID=$($p.Id)"
                exit 0
            }
        }
    }
}
