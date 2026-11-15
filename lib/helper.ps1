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
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
}
"@

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32in {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mi;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  // Real pointer/keyboard injection. Unlike WM_* messages this is honoured by
  // every application, including canvas-only and game UIs -- but it moves the
  // system cursor and needs the target to be foreground for typing.
  public static void MouseButton(uint flags) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0; // INPUT_MOUSE
    a[0].mi.dwFlags = flags;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Wheel(int delta) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].mi.dwFlags = MOUSEEVENTF_WHEEL;
    a[0].mi.mouseData = unchecked((uint)delta);
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void KeyDown(ushort vk) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1; // INPUT_KEYBOARD
    a[0].ki.wVk = vk;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void KeyUp(ushort vk) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].ki.wVk = vk;
    a[0].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void TypeChar(char c) {
    INPUT[] a = new INPUT[2];
    a[0].type = 1;
    a[0].ki.wScan = c;
    a[0].ki.dwFlags = KEYEVENTF_UNICODE;
    a[1].type = 1;
    a[1].ki.wScan = c;
    a[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
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

# UWP/WinUI elements can report an infinite BoundingRectangle; [int] on that
# throws and kills the whole observation. Clamp to a usable int instead.
function SafeInt($v) {
  if ($null -eq $v) { return 0 }
  try { $d = [double]$v } catch { return 0 }
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 0 }
  if ($d -gt 2147483647) { return 2147483647 }
  if ($d -lt -2147483648) { return -2147483648 }
  return [int]$d
}

# Hardware-accelerated surfaces can make PrintWindow return an all-black bitmap.
# Sampling a few points lets us warn instead of handing back a silent lie.
function Test-BlackImage($path) {
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $bmp = [System.Drawing.Bitmap]::FromFile($path)
    $w = $bmp.Width
    $h = $bmp.Height
    if ($w -lt 8 -or $h -lt 8) { $bmp.Dispose(); return $false }
    $dark = 0
    $n = 0
    for ($i = 1; $i -le 24; $i++) {
      $x = [int]($w * ((($i - 1) % 6) + 0.5) / 6)
      $y = [int]($h * ([math]::Floor(($i - 1) / 6) + 0.5) / 4)
      if ($x -ge $w) { $x = $w - 1 }
      if ($y -ge $h) { $y = $h - 1 }
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -lt 10 -and $c.G -lt 10 -and $c.B -lt 10) { $dark++ }
      $n++
    }
    $bmp.Dispose()
    return ($n -gt 0 -and $dark -eq $n)
  } catch {
    return $false
  }
}

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

function Invoke-Input {
  $act = [string]$InputAction
  switch ($act) {
    'move' {
      if (-not [W32in]::SetCursorPos($X, $Y)) { throw 'SetCursorPos failed' }
      return @{ ok = $true; method = 'sendinput'; action = 'move'; x = $X; y = $Y; state = 'moved' }
    }
    'click' {
      [void][W32in]::SetCursorPos($X, $Y)
      Start-Sleep -Milliseconds 30
      [W32in]::MouseButton([W32in]::MOUSEEVENTF_LEFTDOWN)
      Start-Sleep -Milliseconds 30
      [W32in]::MouseButton([W32in]::MOUSEEVENTF_LEFTUP)
      return @{ ok = $true; method = 'sendinput'; action = 'click'; x = $X; y = $Y; state = 'sent-unverified' }
    }
    'drag' {
      [void][W32in]::SetCursorPos($X, $Y)
      Start-Sleep -Milliseconds 60
      [W32in]::MouseButton([W32in]::MOUSEEVENTF_LEFTDOWN)
      Start-Sleep -Milliseconds 60
      $steps = 16
      for ($i = 1; $i -le $steps; $i++) {
        $cx = [int]($X + ($X2 - $X) * $i / $steps)
        $cy = [int]($Y + ($Y2 - $Y) * $i / $steps)
        [void][W32in]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 15
      }
      [W32in]::MouseButton([W32in]::MOUSEEVENTF_LEFTUP)
      return @{ ok = $true; method = 'sendinput'; action = 'drag'; from = @{ x = $X; y = $Y }; to = @{ x = $X2; y = $Y2 }; state = 'sent-unverified' }
    }
    'scroll' {
      [void][W32in]::SetCursorPos($X, $Y)
      $delta = $(if ($Amount -ne 0) { $Amount } else { -120 })
      [W32in]::Wheel($delta)
      return @{ ok = $true; method = 'sendinput'; action = 'scroll'; x = $X; y = $Y; amount = $delta; state = 'sent-unverified' }
    }
    'press' {
      # "ctrl+s" -> down ctrl, down s, up s, up ctrl
      $parts = @($Key -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
      if ($parts.Count -eq 0) { throw 'press needs key (e.g. "enter" or "ctrl+s")' }
      $vks = @($parts | ForEach-Object { Get-Vk $_ })
      foreach ($vk in $vks) { [W32in]::KeyDown([uint16]$vk); Start-Sleep -Milliseconds 20 }
      for ($i = $vks.Count - 1; $i -ge 0; $i--) { [W32in]::KeyUp([uint16]$vks[$i]); Start-Sleep -Milliseconds 20 }
      return @{ ok = $true; method = 'sendinput'; action = 'press'; keys = $parts; state = 'sent-unverified' }
    }
    'type' {
      if ($Text -eq '') { return @{ ok = $true; method = 'sendinput'; action = 'type'; chars = 0; state = 'noop' } }
      foreach ($ch in $Text.ToCharArray()) {
        [W32in]::TypeChar($ch)
        Start-Sleep -Milliseconds 8
      }
      return @{ ok = $true; method = 'sendinput'; action = 'type'; chars = $Text.Length; state = 'sent-unverified' }
    }
    default { throw "unknown input action: $act (move/click/drag/scroll/press/type)" }
  }
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

    'input' {
      return (Invoke-Input)
    }

    'screenshot' {
      if ($Out -eq '') { throw 'need -Out path' }
      $t = Get-TargetWindow
      # A selector was given but nothing matched: fail instead of silently
      # capturing the whole screen, which would be read as the target (A10).
      if (-not $t -and ($TargetPid -gt 0 -or $Title -ne '' -or $Hwnd -ne '')) {
        throw 'target window not found; refusing to capture the whole screen instead'
      }
      $shot = Capture-Window $t $Out
      # A minimized window has no usable geometry: capturing it yields a tiny
      # meaningless bitmap that looks like a real result. Refuse instead.
      if ($t -and $t.minimized) {
        Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
        throw "target window is minimized; restore it first (its client area has no size while minimized)"
      }
      $shot.ok = $true
      $shot.scope = $(if ($t) { 'window' } else { 'screen' })
      $shot.window = $(if ($t) { $t.name } else { '(full screen)' })
      $shot.windowId = $(if ($t) { $t.hwnd } else { 0 })
      if (Test-BlackImage $Out) {
        $shot.allBlack = $true
        $shot.warning = 'bitmap is entirely black: the window may use a hardware-accelerated surface that PrintWindow cannot read. Try the foreground channel or capture the screen instead.'
      }
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
