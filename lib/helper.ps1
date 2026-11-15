# Windows UI Automation helper for dsh-computer-use-win.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so any
# non-ASCII literal here would corrupt the parser.
param(
  [string]$Action = 'list',
  [string]$Title = '',
  [int]$TargetPid = 0,
  [int]$Index = -1,
  [string]$ExpectName = '',
  [string]$TextB64 = '',
  [string]$TitleB64 = '',
  [string]$ExpectNameB64 = '',
  [string]$Text = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Max = 120,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W32cu {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessage")]
  public static extern IntPtr SendMessageStr(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessage")]
  public static extern IntPtr SendMessageInt(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
}
"@

$WM_SETTEXT = 0x000C
$WM_GETTEXT = 0x000D
$WM_GETTEXTLENGTH = 0x000E

# Non-ASCII arguments arrive base64-encoded: passing them through the Windows
# command line depends on the console code page and mangles CJK text.
function Decode($b64) {
  if ($b64 -eq '') { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}
if ($TextB64 -ne '') { $Text = Decode $TextB64 }
if ($TitleB64 -ne '') { $Title = Decode $TitleB64 }
if ($ExpectNameB64 -ne '') { $ExpectName = Decode $ExpectNameB64 }

function Emit($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

function Fail($msg) {
  @{ ok = $false; error = $msg } | ConvertTo-Json -Compress
  exit 1
}

# --- locate the target top-level window ---
function Get-TargetWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $fg = [W32cu]::GetForegroundWindow()

  foreach ($w in $wins) {
    $c = $w.Current
    if ($TargetPid -gt 0 -and $c.ProcessId -ne $TargetPid) { continue }
    if ($Title -ne '' -and $c.Name -notlike "*$Title*") { continue }
    if ($TargetPid -le 0 -and $Title -eq '') { continue }

    $hwnd = [IntPtr]$c.NativeWindowHandle
    $rect = New-Object W32cu+RECT
    [void][W32cu]::GetWindowRect($hwnd, [ref]$rect)
    return [pscustomobject]@{
      element = $w
      pid = $c.ProcessId
      name = $c.Name
      cls = $c.ClassName
      hwnd = $hwnd.ToInt64()
      foreground = ($hwnd -eq $fg)
      minimized = [W32cu]::IsIconic($hwnd)
      rect = @{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
    }
  }
  return $null
}

# --- enumerate windows ---
if ($Action -eq 'list') {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $fg = [W32cu]::GetForegroundWindow()
  $list = @()
  foreach ($w in $wins) {
    $c = $w.Current
    $hwnd = [IntPtr]$c.NativeWindowHandle
    if (-not [W32cu]::IsWindowVisible($hwnd)) { continue }
    $rect = New-Object W32cu+RECT
    [void][W32cu]::GetWindowRect($hwnd, [ref]$rect)
    $list += @{
      pid = $c.ProcessId
      title = $c.Name
      class = $c.ClassName
      hwnd = $hwnd.ToInt64()
      foreground = ($hwnd -eq $fg)
      minimized = [W32cu]::IsIconic($hwnd)
      width = ($rect.Right - $rect.Left)
      height = ($rect.Bottom - $rect.Top)
    }
  }
  Emit @{ ok = $true; count = $list.Count; windows = $list }
}

# --- observe: bounded UIA tree of the target window ---
if ($Action -eq 'observe') {
  $t = Get-TargetWindow
  if (-not $t) { Fail 'target window not found' }

  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $t.element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $elems = @()
  $i = 0
  foreach ($e in $all) {
    if ($i -ge $Max) { break }
    $c = $e.Current
    $ct = ''
    try { $ct = $c.ControlType.ProgrammaticName -replace 'ControlType\.', '' } catch {}
    $r = $c.BoundingRectangle
    $hasValue = $false; $hasInvoke = $false; $hasText = $false
    try { [void]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $hasValue = $true } catch {}
    try { [void]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $hasInvoke = $true } catch {}
    try { [void]$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $hasText = $true } catch {}
    $elems += @{
      index = $i
      type = $ct
      class = $c.ClassName
      name = $c.Name
      hwnd = $c.NativeWindowHandle
      enabled = $c.IsEnabled
      offscreen = $c.IsOffscreen
      rect = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
      value = $hasValue
      invoke = $hasInvoke
      text = $hasText
    }
    $i++
  }
  Emit @{
    ok = $true
    window = @{ pid = $t.pid; title = $t.name; class = $t.cls; hwnd = $t.hwnd; foreground = $t.foreground; rect = $t.rect }
    total = $all.Count
    returned = $elems.Count
    elements = $elems
  }
}

# --- settext: no-focus write via UIA ValuePattern, else WM_SETTEXT ---
if ($Action -eq 'settext') {
  $t = Get-TargetWindow
  if (-not $t) { Fail 'target window not found' }

  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $t.element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($Index -lt 0 -or $Index -ge $all.Count) { Fail "index out of range (0..$($all.Count - 1))" }
  $e = $all[$Index]
  if ($ExpectName -ne '' -and $e.Current.Name -ne $ExpectName) {
    Fail ("name mismatch: expected '" + $ExpectName + "' but index " + $Index + " is '" + $e.Current.Name + "'")
  }

  $method = ''
  try {
    $vp = [System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($Text)
    $method = 'uia-value'
  } catch {
    $h = [IntPtr]$e.Current.NativeWindowHandle
    if ($h -eq [IntPtr]::Zero) {
      $r = $e.Current.BoundingRectangle
      $h = [IntPtr]$t.hwnd
    }
    $ret = [W32cu]::SendMessageStr($h, $WM_SETTEXT, [IntPtr]::Zero, $Text)
    $method = 'wm-settext'
  }

  # read back for verification
  $readBack = ''
  try {
    $h2 = [IntPtr]$e.Current.NativeWindowHandle
    $len = [W32cu]::SendMessageInt($h2, $WM_GETTEXTLENGTH, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
    if ($len -ge 0 -and $len -lt 100000) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][W32cu]::SendMessageInt($h2, $WM_GETTEXT, [IntPtr]($len + 1), [IntPtr]::Zero)
    }
  } catch {}

  Emit @{
    ok = $true
    method = $method
    index = $Index
    element = @{ type = $e.Current.ControlType.ProgrammaticName; name = $e.Current.Name; class = $e.Current.ClassName }
    written = $Text
  }
}

# --- invoke: UIA InvokePattern ---
if ($Action -eq 'invoke') {
  $t = Get-TargetWindow
  if (-not $t) { Fail 'target window not found' }
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $t.element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($Index -lt 0 -or $Index -ge $all.Count) { Fail "index out of range (0..$($all.Count - 1))" }
  $e = $all[$Index]
  if ($ExpectName -ne '' -and $e.Current.Name -ne $ExpectName) {
    Fail ("name mismatch: expected '" + $ExpectName + "' but index " + $Index + " is '" + $e.Current.Name + "'")
  }
  try {
    $ip = [System.Windows.Automation.InvokePattern]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
    Emit @{ ok = $true; method = 'uia-invoke'; index = $Index; name = $e.Current.Name }
  } catch {
    Fail ("invoke not supported: " + $_.Exception.Message)
  }
}

# --- clickxy: no-focus click at window-relative coordinates ---
if ($Action -eq 'clickxy') {
  $t = Get-TargetWindow
  if (-not $t) { Fail 'target window not found' }
  $hwnd = [IntPtr]$t.hwnd
  $WM_LBUTTONDOWN = 0x0201
  $WM_LBUTTONUP = 0x0202
  $MK_LBUTTON = 0x0001
  $lparam = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
  [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lparam)
  Start-Sleep -Milliseconds 40
  [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONUP, [IntPtr]::Zero, $lparam)
  Emit @{ ok = $true; method = 'wm-click'; x = $X; y = $Y; window = $t.name }
}

# --- screenshot: capture window rect to PNG ---
if ($Action -eq 'screenshot') {
  if ($Out -eq '') { Fail 'need -Out path' }
  $t = Get-TargetWindow
  $left = 0; $top = 0; $w = 0; $h = 0
  if ($t) {
    $rect = New-Object W32cu+RECT
    [void][W32cu]::GetWindowRect([IntPtr]$t.hwnd, [ref]$rect)
    $left = $rect.Left; $top = $rect.Top
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  } else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $w = $bounds.Width; $h = $bounds.Height
  }
  if ($w -le 0 -or $h -le 0) { Fail 'window has no area (minimized?)' }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $mode = 'screen-copy'
  if ($t) {
    # PrintWindow renders the window itself, so an occluded window still
    # captures correctly. PW_RENDERFULLCONTENT (2) is what Chromium apps need.
    try {
      $hdc = $g.GetHdc()
      $ok = [W32cu]::PrintWindow([IntPtr]$t.hwnd, $hdc, 2)
      $g.ReleaseHdc($hdc)
      if ($ok) { $mode = 'print-window' }
    } catch {
      try { $g.ReleaseHdc($hdc) } catch {}
    }
  }
  if ($mode -eq 'screen-copy') {
    $g.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size $w, $h))
  }
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Emit @{ ok = $true; path = $Out; width = $w; height = $h; mode = $mode; window = $(if ($t) { $t.name } else { '(full screen)' }) }
}

Fail "unknown action: $Action"
