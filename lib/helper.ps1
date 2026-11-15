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
  [string]$Hwnd = '',
  [string]$InputAction = '',
  [string]$Key = '',
  [int]$Amount = 0,
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
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessage")]
  public static extern IntPtr SendMessageStr(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessage")]
  public static extern IntPtr SendMessageInt(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessage")]
  public static extern IntPtr SendMessageSB(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
}
"@


$WM_SETTEXT = 0x000C
$WM_GETTEXT = 0x000D
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

# window still captures correctly. PW_RENDERFULLCONTENT (2) is what Chromium
# apps need; CopyFromScreen is the fallback.
function New-WindowInfo($w, $fg) {
  $c = $w.Current
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

function Get-TargetWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $fg = [W32cu]::GetForegroundWindow()

  # 1) An explicit handle is the only unambiguous identity.
  if ($Hwnd -ne '') {
    $want = [IntPtr]::Zero
    try { $want = [IntPtr][long]$Hwnd } catch { throw "invalid hwnd: $Hwnd" }
    foreach ($w in $wins) {
      $h = [IntPtr]$w.Current.NativeWindowHandle
      if ($h -eq $want) { return (New-WindowInfo $w $fg) }
    }
    throw "window handle $Hwnd is not a visible top-level window"
  }

  # 2) No selector at all: the caller decides (list / full-screen capture).
  if ($TargetPid -le 0 -and $Title -eq '') { return $null }

  # 3) pid/title filter. Several matches are ambiguous: report them instead of
  #    silently acting on the first one (A06).
  $matches = @()
  foreach ($w in $wins) {
    $c = $w.Current
    if ($TargetPid -gt 0 -and $c.ProcessId -ne $TargetPid) { continue }
    if ($Title -ne '' -and $c.Name -notlike "*$Title*") { continue }
    $matches += (New-WindowInfo $w $fg)
  }

  if ($matches.Count -eq 0) { return $null }
  if ($matches.Count -gt 1) {
    $desc = ($matches | ForEach-Object { "$($_.hwnd)|pid=$($_.pid)|$($_.name)" }) -join ' ;; '
    throw "ambiguous target: $($matches.Count) windows matched. Pass hwnd explicitly: $desc"
  }
  return $matches[0]
}

# Virtual-key lookup for the foreground input channel ("ctrl+s", "enter", "f5").
function Get-Vk($name) {
  $n = [string]$name
  if ([string]::IsNullOrWhiteSpace($n)) { throw 'empty key name' }
  $n = $n.Trim().ToLower()
  $map = @{
    'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
    'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
    'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
    'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
    'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
    'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
  }
  if ($map.ContainsKey($n)) { return [int]$map[$n] }
  if ($n.Length -eq 1) {
    $c = [char]::ToUpperInvariant($n[0])
    if (($c -ge 'A' -and $c -le 'Z') -or ($c -ge '0' -and $c -le '9')) { return [int]$c }
  }
  throw "unknown key: $name"
}

# Offset from the window's top-left (what screenshots are relative to) to the
# client area's top-left (what WM_LBUTTONDOWN coordinates are relative to).
function Get-ClientOffset($t) {
  if (-not $t) { return @{ dx = 0; dy = 0 } }
  $rect = New-Object W32cu+RECT
  [void][W32cu]::GetWindowRect([IntPtr]$t.hwnd, [ref]$rect)
  $pt = New-Object W32cu+POINT
  $pt.X = 0; $pt.Y = 0
  [void][W32cu]::ClientToScreen([IntPtr]$t.hwnd, [ref]$pt)
  return @{ dx = ($pt.X - $rect.Left); dy = ($pt.Y - $rect.Top) }
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
        # Read the actual text, not just the capability flag: knowing whether a
        # control CAN expose text is useless when what we need is its content.
        # Bounded: this costs one call per candidate and can be slow.
        $textValue = $null
        if ($hasText -and $i -lt 80) {
          try {
            $tp = [System.Windows.Automation.TextPattern]$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            $raw = $tp.DocumentRange.GetText(500)
            if ($null -ne $raw) {
              $raw = $raw.Trim()
              if ($raw -ne '') { $textValue = $raw }
            }
          } catch { $textValue = $null }
        }
        $elems += @{
          index = $i
          type = $ct
          class = $c.ClassName
          name = $c.Name
          hwnd = $c.NativeWindowHandle
          enabled = $c.IsEnabled
          offscreen = $c.IsOffscreen
          rect = @{ x = (SafeInt $r.X); y = (SafeInt $r.Y); w = (SafeInt $r.Width); h = (SafeInt $r.Height) }
          value = $hasValue
          invoke = $hasInvoke
          text = $hasText
          textValue = $textValue
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
      return $res
    }

    'scrollto' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $e = Get-ElementAt $t $Index
      $sp = $null
      try {
        $sp = [System.Windows.Automation.ScrollItemPattern]$e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
      } catch { $sp = $null }
      if ($null -eq $sp) {
        throw 'element does not support ScrollItemPattern; scroll its container with computer_input scroll instead'
      }
      $sp.ScrollIntoView()
      Start-Sleep -Milliseconds 220
      $r = $e.Current.BoundingRectangle
      return @{
        ok = $true
        method = 'uia-scrollitem'
        state = 'scrolled'
        index = $Index
        name = $e.Current.Name
        rect = @{ x = (SafeInt $r.X); y = (SafeInt $r.Y); w = (SafeInt $r.Width); h = (SafeInt $r.Height) }
      }
    }

    'settext' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $e = Get-ElementAt $t $Index
      $method = ''
      $targetHwnd = [IntPtr]::Zero

      # 1) ValuePattern replaces the control's value; it never simulates typing.
      $vp = $null
      try {
        $vp = [System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      } catch { $vp = $null }

      if ($null -ne $vp) {
        # A pattern that EXISTS but fails must not silently fall back to messages.
        try {
          $vp.SetValue($Text)
          $method = 'uia-value'
        } catch {
          throw ("ValuePattern.SetValue failed: " + $_.Exception.Message)
        }
      } else {
        # Legacy control: only write through its OWN native handle. Falling back
        # to the top-level window handle would retitle the window instead (A08).
        $targetHwnd = [IntPtr]$e.Current.NativeWindowHandle
        if ($targetHwnd -eq [IntPtr]::Zero) {
          throw 'element exposes neither ValuePattern nor a native HWND; refusing to write (a top-level WM_SETTEXT would hit the window title)'
        }
        $ret = [W32cu]::SendMessageStr($targetHwnd, $WM_SETTEXT, [IntPtr]::Zero, $Text)
        if ($ret -eq [IntPtr]::Zero) { throw 'WM_SETTEXT returned 0: the control rejected the text' }
        $method = 'wm-settext'
      }

      # 2) Read back. "the call returned" is not "the value is there" (A09).
      # Keep the handle captured BEFORE the write: a UIA element can go stale
      # once the control's content changes, and re-reading NativeWindowHandle
      # then yields 0 (which made the verification read an empty buffer).
      $actual = $null
      $verified = $false
      try {
        if ($null -ne $vp) {
          $actual = $vp.Current.Value
        } elseif ($targetHwnd -ne [IntPtr]::Zero) {
          # Cast to Int32: StringBuilder(Int64) resolves to the string overload,
          # which would seed the buffer with the number instead of the text.
          $len = [int]([W32cu]::SendMessageInt($targetHwnd, $WM_GETTEXTLENGTH, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64())
          if ($len -ge 0 -and $len -lt 1000000) {
            $sb = New-Object System.Text.StringBuilder ([int]($len + 1))
            [void][W32cu]::SendMessageSB($targetHwnd, $WM_GETTEXT, [IntPtr]($len + 1), $sb)
            $actual = $sb.ToString()
          }
        }
        # -ceq, not -eq: PowerShell's -eq is case-insensitive, which would call
        # "ABC" a verified write of "abc" (A09).
        if ($null -ne $actual) { $verified = ($actual -ceq $Text) }
      } catch { $actual = $null }

      return @{
        ok = $true
        method = $method
        state = $(if ($verified) { 'verified' } else { 'applied-unverified' })
        verified = $verified
        index = $Index
        element = @{ type = $e.Current.ControlType.ProgrammaticName; name = $e.Current.Name; class = $e.Current.ClassName }
        requested = $Text
        actual = $actual
      }
    }

    'invoke' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $e = Get-ElementAt $t $Index
      try {
        $ip = [System.Windows.Automation.InvokePattern]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $ip.Invoke()
        return @{ ok = $true; method = 'uia-invoke'; state = 'invoked-unverified'; index = $Index; name = $e.Current.Name }
      } catch {
        throw ("invoke not supported: " + $_.Exception.Message)
      }
    }

    'clickxy' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $hwnd = [IntPtr]$t.hwnd
      # Input coordinates are window-relative (the same space as screenshots);
      # WM_LBUTTONDOWN coordinates are client-relative. Convert (A11).
      $off = Get-ClientOffset $t
      $cx = $X - $off.dx
      $cy = $Y - $off.dy
      $lp = [IntPtr](($cy -shl 16) -bor ($cx -band 0xFFFF))
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lp)
      Start-Sleep -Milliseconds 40
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONUP, [IntPtr]::Zero, $lp)
      return @{
        ok = $true
        method = 'wm-click'
        state = 'sent-unverified'
        x = $X
        y = $Y
        clientX = $cx
        clientY = $cy
        offset = $off
        window = $t.name
      }
    }

    'drag' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $hwnd = [IntPtr]$t.hwnd
      $off = Get-ClientOffset $t
      $sx = $X - $off.dx
      $sy = $Y - $off.dy
      $ex = $X2 - $off.dx
      $ey = $Y2 - $off.dy
      $steps = 14
      $lp = [IntPtr](($sy -shl 16) -bor ($sx -band 0xFFFF))
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lp)
      Start-Sleep -Milliseconds 60
      for ($i = 1; $i -le $steps; $i++) {
        $cx = [int]($sx + ($ex - $sx) * $i / $steps)
        $cy = [int]($sy + ($ey - $sy) * $i / $steps)
        $mv = [IntPtr](($cy -shl 16) -bor ($cx -band 0xFFFF))
        [void][W32cu]::SendMessageInt($hwnd, $WM_MOUSEMOVE, [IntPtr]$MK_LBUTTON, $mv)
        Start-Sleep -Milliseconds 18
      }
      $end = [IntPtr](($ey -shl 16) -bor ($ex -band 0xFFFF))
      [void][W32cu]::SendMessageInt($hwnd, $WM_LBUTTONUP, [IntPtr]::Zero, $end)
      return @{
        ok = $true
        method = 'wm-drag'
        state = 'sent-unverified'
        from = @{ x = $X; y = $Y }
        to = @{ x = $X2; y = $Y2 }
        offset = $off
        steps = $steps
        window = $t.name
        note = 'message-based drag needs no focus, but controls relying on real mouse capture may ignore it'
      }
    }

    'activate' {
      $t = Get-TargetWindow
      if (-not $t) { throw 'target window not found' }
      $hwnd = [IntPtr]$t.hwnd

      if ($t.minimized) { [void][W32cu]::ShowWindow($hwnd, 9) }  # SW_RESTORE
      [void][W32cu]::BringWindowToTop($hwnd)
      $ok = [W32cu]::SetForegroundWindow($hwnd)

      # Windows only honours SetForegroundWindow from the foreground process.
      # Attaching to the current foreground thread lifts that restriction.
      if (-not $ok) {
        $fg = [W32cu]::GetForegroundWindow()
        $fgPid = [uint32]0
        $fgTid = [W32cu]::GetWindowThreadProcessId($fg, [ref]$fgPid)
        $myTid = [W32cu]::GetCurrentThreadId()
        if ($fgTid -ne 0 -and $fgTid -ne $myTid) {
          [void][W32cu]::AttachThreadInput($myTid, $fgTid, $true)
          $ok = [W32cu]::SetForegroundWindow($hwnd)
          [void][W32cu]::AttachThreadInput($myTid, $fgTid, $false)
        }
      }

      Start-Sleep -Milliseconds 120
      $now = [W32cu]::GetForegroundWindow()
      return @{
        ok = $true
        method = 'setforegroundwindow'
        state = $(if ($now -eq $hwnd) { 'foreground' } else { 'not-foreground' })
        activated = ($now -eq $hwnd)
        window = $t.name
        hwnd = $t.hwnd
        note = $(if ($now -eq $hwnd) { '' } else { 'the window is not foreground; Windows may be blocking focus changes, and keyboard input would go elsewhere' })
      }
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
      $script:Hwnd = ''
      $script:InputAction = ''
      $script:Key = ''
      $script:Amount = 0
      $script:WithShot = $false

      if ($null -ne $req.pid) { $script:TargetPid = [int]$req.pid }
      if ($null -ne $req.index) { $script:Index = [int]$req.index }
      if ($null -ne $req.max) { $script:Max = [int]$req.max }
      if ($null -ne $req.x) { $script:X = [int]$req.x }
      if ($null -ne $req.y) { $script:Y = [int]$req.y }
      if ($null -ne $req.x2) { $script:X2 = [int]$req.x2 }
      if ($null -ne $req.y2) { $script:Y2 = [int]$req.y2 }
      if ($null -ne $req.out) { $script:Out = [string]$req.out }
      if ($null -ne $req.hwnd) { $script:Hwnd = [string]$req.hwnd }
      if ($null -ne $req.inputAction) { $script:InputAction = [string]$req.inputAction }
      if ($null -ne $req.key) { $script:Key = [string]$req.key }
      if ($null -ne $req.amount) { $script:Amount = [int]$req.amount }
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
