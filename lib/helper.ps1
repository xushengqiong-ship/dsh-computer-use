# Windows UI Automation helper for dsh-computer-use.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so any
# non-ASCII literal here would corrupt the parser.
#
# Two modes:
#   single  : -Action <name> ...   -> run once, print one JSON line, exit
#   serve   : -Action serve        -> read JSON request lines from stdin,
#                                     answer with one JSON line each. Keeps the
#                                     -Process alive so UIA calls stop paying
#                                     process-startup cost (~300ms per call).
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
  [int]$X2 = 0,
  [int]$Y2 = 0,
  [int]$Max = 120,
  [string]$Out = '',
  [switch]$WithShot
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
$WM_GETTEMPLATE = 0
$WM_GETTEXTLENGTH = 0x000E
$WM_LBUTTONDOWN = 0x0201
$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONUP = 0x0202
$MK_LBUTTON = 0x0001

function Emit($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

# Non-ASCII arguments arrive base64-encoded: passing them through the Windows
# command line depends on the console code page and mangles CJK text.
function Decode($b64) {
  if ([string]::IsNullOrEmpty($b64)) { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

# Shared capture path: PrintWindow renders the window itself, so an occluded
# window still captures correctly. PW_RENDERFULLCONTENT (2) is what Chromium
# apps need; CopyFromScreen is the fallback.
function Capture-Window($t, $outPath) {
  if ([string]::IsNullOrEmpty($outPath)) { throw 'capture needs an output path' }
  $left = 0; $top = 0; $w = 0; $h = 0
  if ($t) {
    $rect = New-Object W32cu+RECT
    [void][W32cu]::GetWindowRect([IntPtr]$t.hwnd, [ref]$rect)
    $left = $rect.Left; $top = $rect.Top
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  } else {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $w = $b.Width; $h = $b.Height
  }
  if ($w -le 0 -or $h -le 0) { throw 'window has no area (minimized?)' }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $mode = 'screen-copy'
  if ($t) {
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
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return @{ path = $outPath; width = $w; height = $h; mode = $mode }
}

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

function Get-ElementAt {
  param($t, $idx)
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $t.element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($idx -lt 0 -or $idx -ge $all.Count) { throw "index out of range (0..$($all.Count - 1))" }
  $e = $all[$idx]
  if ($ExpectName -ne '' -and $e.Current.Name -ne $ExpectName) {
    throw ("name mismatch: expected '" + $ExpectName + "' but index " + $idx + " is '" + $e.Current.Name + "'")
  }
  return $e
}

function Invoke-Action {
  switch ($Action) {

    'list' {
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
      return @{ ok = $true; count = $list.Count; windows = $list }
    }

    'observe' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
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
      $res = @{
        ok = $true
        window = @{ pid = $t.pid; title = $t.name; class = $t.cls; hwnd = $t.hwnd; foreground = $t.foreground; rect = $t.rect }
        total = $all.Count
        returned = $elems.Count
        elements = $elems
      }
      if ($WithShot -and $Out -ne '') {
        try { $res.screenshot = Capture-Window $t $Out }
        catch { $res.screenshotError = $_.Exception.Message }
      }
      return $res
    }

    'settext' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $e = Get-ElementAt $t $Index
      $method = ''
      try {
        $vp = [System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $vp.SetValue($Text)
        $method = 'uia-value'
      } catch {
        $h = [IntPtr]$e.Current.NativeWindowHandle
        if ($h -eq [IntPtr]::Zero) { $h = [IntPtr]$t.hwnd }
        [void][W32cu]::SendMessageStr($h, $WM_SETTEXT, [IntPtr]::Zero, $Text)
        $method = 'wm-settext'
      }
      return @{
        ok = $true
        method = $method
        index = $Index
        element = @{ type = $e.Current.ControlType.ProgrammaticName; name = $e.Current.Name; class = $e.Current.ClassName }
        written = $Text
      }
    }

    'invoke' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $e = Get-ElementAt $t $Index
      try {
        $ip = [System.Windows.Automation.InvokePattern]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $ip.Invoke()
        return @{ ok = $true; method = 'uia-invoke'; index = $Index; name = $e.Current.Name }
      } catch {
        throw ("invoke not supported: " + $_.Exception.Message)
      }
    }

    'clickxy' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $hwnd = [IntPtr]$t.hwnd
      $lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lp)
      Start-Sleep -Milliseconds 40
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONUP, [IntPtr]::Zero, $lp)
      return @{ ok = $true; method = 'wm-click'; x = $X; y = $Y; window = $t.name }
    }

    'drag' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $hwnd = [IntPtr]$t.hwnd
      $steps = 14
      $lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lp)
      Start-Sleep -Milliseconds 60
      for ($i = 1; $i -le $steps; $i++) {
        $cx = [int]($X + ($X2 - $X) * $i / $steps)
        $cy = [int]($Y + ($Y2 - $Y) * $i / $steps)
        $mv = [IntPtr](($cy -shl 16) -bor ($cx -band 0xFFFF))
        [void][W32cu]::SendMessageInt($hwnd, $WM_MOUSEMOVE, [IntPtr]$MK_LBUTTON, $mv)
        Start-Sleep -Milliseconds 18
      }
      $end = [IntPtr](($Y2 -shl 16) -bor ($X2 -band 0xFFFF))
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONUP, [IntPtr]::Zero, $end)
      return @{
        ok = $true
        method = 'wm-drag'
        from = @{ x = $X; y = $Y }
        to = @{ x = $X2; y = $Y2 }
        steps = $steps
        window = $t.name
      }
    }

    'screenshot' {
      if ($Out -eq '') { throw 'need -Out path' }
      $t = Get-TargetWindow
      $shot = Capture-Window $t $Out
      $shot.ok = $true
      $shot.window = $(if ($t) { $t.name } else { '(full screen)' })
      return $shot
    }

    default { throw "unknown action: $Action" }
  }
}

# Decode base64 arguments for the single-shot invocation.
if ($TextB64 -ne '') { $Text = Decode $TextB64 }
if ($TitleB64 -ne '') { $Title = Decode $TitleB64 }
if ($ExpectNameB64 -ne '') { $ExpectName = Decode $ExpectNameB64 }

# ---------------------------------------------------------------- serve mode
if ($Action -eq 'serve') {
  $stdout = [Console]::Out
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $req = $line | ConvertFrom-Json
      $script:Action = [string]$req.action
      $script:Title = ''
      $script:TargetPid = 0
      $script:Index = -1
      $script:ExpectName = ''
      $script:Text = ''
      $script:X = 0; $script:Y = 0; $script:X2 = 0; $script:Y2 = 0
      $script:Max = 120
      $script:Out = ''
      $script:WithShot = $false

      if ($null -ne $req.pid) { $script:TargetPid = [int]$req.pid }
      if ($null -ne $req.index) { $script:Index = [int]$req.index }
      if ($null -ne $req.max) { $script:Max = [int]$req.max }
      if ($null -ne $req.x) { $script:X = [int]$req.x }
      if ($null -ne $req.y) { $script:Y = [int]$req.y }
      if ($null -ne $req.x2) { $script:X2 = [int]$req.x2 }
      if ($null -ne $req.y2) { $script:Y2 = [int]$req.y2 }
      if ($null -ne $req.out) { $script:Out = [string]$req.out }
      if ($req.withShot) { $script:WithShot = $true }
      if ($req.titleB64) { $script:Title = Decode ([string]$req.titleB64) }
      if ($req.expectNameB64) { $script:ExpectName = Decode ([string]$req.expectNameB64) }
      if ($req.textB64) { $script:Text = Decode ([string]$req.textB64) }

      $result = Invoke-Action
      $stdout.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
    } catch {
      $stdout.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
    $stdout.Flush()
  }
  exit 0
}

# ---------------------------------------------------------------- single mode
try {
  Emit (Invoke-Action)
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
