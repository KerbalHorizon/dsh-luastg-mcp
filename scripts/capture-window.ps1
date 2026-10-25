# Captures one top-level window to a PNG file.
#
# Used by the luastg_take_screenshot tool as the fallback when the editor bridge has no
# take_screenshot action (bridge protocol v1). The window is restored, raised, and captured
# with System.Drawing/CopyFromScreen, so it works without rebuilding the editor.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/capture-window.ps1 `
#       -Out C:\Temp\shot.png -TitleLike "LuaSTG Editor"
#
# Prints "OK|<path>|<width>|<height>|<title>" on success; exits non-zero with a message
# on stderr when no window matches or the capture fails.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$TitleLike = 'LuaSTG',
    [switch]$NoFocus,
    [switch]$NoRestore
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    public const uint WM_SYSCOMMAND = 0x0112;
    public const int SC_RESTORE = 0xF120;

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    /// Returns "handle|title|area" for every window whose title contains <paramref name="needle"/>.
    public static List<string> Find(string needle)
    {
        List<string> found = new List<string>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(hWnd, sb, 512);
            string title = sb.ToString();
            if (title.Length == 0) return true;
            if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;

            bool visible = IsWindowVisible(hWnd);
            bool iconic = IsIconic(hWnd);
            if (!visible && !iconic) return true;

            found.Add(hWnd.ToInt64().ToString() + "|" + title);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// Un-minimizes the window (minimized windows have a bogus -32000 rect), raises it, returns its rect.
    public static string Prepare(IntPtr hWnd, bool restore, bool focus)
    {
        if (restore)
        {
            SendMessage(hWnd, WM_SYSCOMMAND, (IntPtr)SC_RESTORE, IntPtr.Zero);
            System.Threading.Thread.Sleep(700);
        }

        if (focus)
        {
            SetForegroundWindow(hWnd);
            System.Threading.Thread.Sleep(350);
        }

        RECT r;
        if (!GetWindowRect(hWnd, out r)) return null;
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (w <= 200 || h <= 200) return null;
        return r.Left + "|" + r.Top + "|" + w + "|" + h;
    }
}
'@

# GetWindowRect and the screen bitmap must agree on the unit: physical pixels.
[void][WindowCapture]::SetProcessDPIAware()

$matches = [WindowCapture]::Find($TitleLike)
if ($matches.Count -eq 0) {
    [Console]::Error.WriteLine("no window whose title contains '$TitleLike'")
    exit 2
}

$best = $null
$bestArea = -1
$bestTitle = ''
foreach ($entry in $matches) {
    $parts = $entry.Split('|', 2)
    $handle = [IntPtr][long]$parts[0]
    $size = [WindowCapture]::Prepare($handle, (-not $NoRestore.IsPresent), (-not $NoFocus.IsPresent))
    if ($null -eq $size) { continue }
    $dims = $size.Split('|')
    $area = [int]$dims[2] * [int]$dims[3]
    if ($area -gt $bestArea) { $bestArea = $area; $best = $size; $bestTitle = $parts[1] }
}

if ($null -eq $best) {
    [Console]::Error.WriteLine("window '$TitleLike' has no usable size (still minimized?)")
    exit 3
}

$dims = $best.Split('|')
$left = [int]$dims[0]; $top = [int]$dims[1]; $width = [int]$dims[2]; $height = [int]$dims[3]

# A maximized window extends past the screen edge by its shadow: clamp, or CopyFromScreen
# returns black borders / throws.
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x0 = [Math]::Max($left, $screen.Left)
$y0 = [Math]::Max($top, $screen.Top)
$x1 = [Math]::Min($left + $width, $screen.Left + $screen.Width)
$y1 = [Math]::Min($top + $height, $screen.Top + $screen.Height)
if ($x1 - $x0 -lt 200 -or $y1 - $y0 -lt 200) {
    [Console]::Error.WriteLine("window '$TitleLike' is outside the screen ($left,$top ${width}x${height})")
    exit 4
}
$width = $x1 - $x0
$height = $y1 - $y0

$folder = Split-Path -Parent $Out
if ($folder -and -not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($x0, $y0, 0, 0, (New-Object System.Drawing.Size $width, $height))
    $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

Write-Output ("OK|" + $Out + "|" + $width + "|" + $height + "|" + $bestTitle)
