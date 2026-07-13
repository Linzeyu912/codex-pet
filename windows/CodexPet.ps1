param(
    [switch]$Smoke
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$projectRoot = Split-Path -Parent $PSScriptRoot
$atlasPath = Join-Path $projectRoot 'public\local\spritesheet.png'
$iconPath = Join-Path $projectRoot 'src-tauri\icons\icon.ico'
$stateDirectory = Join-Path $HOME '.codex-pet'
$statePath = Join-Path $stateDirectory 'state.json'
$settingsDirectory = Join-Path $env:APPDATA 'Codex Pet'
$windowStatePath = Join-Path $settingsDirectory 'window-state.json'
$startupPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Codex Pet.lnk'
$smokePath = Join-Path $projectRoot '.local-assets\qq-penguin\powershell-smoke.png'

if (-not (Test-Path -LiteralPath $atlasPath)) {
    throw "Local sprite atlas not found: $atlasPath. Run 'pnpm assets:prepare' first."
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Codex Pet" Width="260" Height="286"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        WindowStartupLocation="Manual">
  <Grid Name="Root" Background="Transparent">
    <Border Name="Bubble" HorizontalAlignment="Center" VerticalAlignment="Top"
            Margin="0,6,0,0" Padding="12,7" CornerRadius="14"
            BorderBrush="#B8FFFFFF" BorderThickness="1" Background="#F2FFFFFF"
            Visibility="Collapsed">
      <Border.Effect>
        <DropShadowEffect BlurRadius="12" ShadowDepth="3" Opacity="0.24"/>
      </Border.Effect>
      <TextBlock Name="BubbleText" Text="陪着你" Foreground="#12243A"
                 FontFamily="Microsoft YaHei UI" FontSize="12" FontWeight="Bold"/>
    </Border>
    <Image Name="PetImage" Width="215" Height="233" Margin="0,42,0,7"
           HorizontalAlignment="Center" VerticalAlignment="Bottom"
           Stretch="Fill" RenderOptions.BitmapScalingMode="NearestNeighbor"/>
    <Ellipse Name="StateDot" Width="10" Height="10" Margin="0,0,19,18"
             HorizontalAlignment="Right" VerticalAlignment="Bottom"
             Stroke="#E8FFFFFF" StrokeThickness="2" Fill="#70D68A"/>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$root = $window.FindName('Root')
$petImage = $window.FindName('PetImage')
$bubble = $window.FindName('Bubble')
$bubbleText = $window.FindName('BubbleText')
$stateDot = $window.FindName('StateDot')

$bitmap = New-Object Windows.Media.Imaging.BitmapImage
$bitmap.BeginInit()
$bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$bitmap.UriSource = [Uri]::new($atlasPath, [UriKind]::Absolute)
$bitmap.EndInit()
$bitmap.Freeze()

$animations = @{
    'idle'          = @{ Row = 0; Frames = 6; Milliseconds = 180; Label = '陪着你' }
    'running-right' = @{ Row = 1; Frames = 8; Milliseconds = 120; Label = '向右散步' }
    'running-left'  = @{ Row = 2; Frames = 8; Milliseconds = 120; Label = '向左散步' }
    'waving'        = @{ Row = 3; Frames = 4; Milliseconds = 140; Label = '你好呀'; Transient = 2600 }
    'jumping'       = @{ Row = 4; Frames = 5; Milliseconds = 140; Label = '完成啦'; Transient = 2600 }
    'failed'        = @{ Row = 5; Frames = 8; Milliseconds = 140; Label = '遇到问题了'; Transient = 4200 }
    'waiting'       = @{ Row = 6; Frames = 6; Milliseconds = 150; Label = '等你确认' }
    'running'       = @{ Row = 7; Frames = 6; Milliseconds = 120; Label = 'Codex 正在工作' }
    'review'        = @{ Row = 8; Frames = 6; Milliseconds = 150; Label = '正在检查' }
}
$demoOrder = @('idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review')
$script:action = 'idle'
$script:frame = 0
$script:paused = $false
$script:lastFrameAt = [DateTime]::UtcNow
$script:lastPollAt = [DateTime]::MinValue
$script:lastStateStamp = [long]0
$script:transientAt = [DateTime]::MinValue
$script:allowExit = $false
$script:smokeTimer = $null

function Show-Frame {
    $definition = $animations[$script:action]
    $rectangle = [Windows.Int32Rect]::new(
        ([int]$script:frame * 192),
        ([int]$definition.Row * 208),
        192,
        208
    )
    $crop = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap, $rectangle)
    $crop.Freeze()
    $petImage.Source = $crop
}

function Set-PetAction([string]$Action, [long]$Stamp = 0) {
    if (-not $animations.ContainsKey($Action)) { return }
    if ($script:action -ne $Action) {
        $script:action = $Action
        $script:frame = 0
        $script:transientAt = [DateTime]::UtcNow
    }
    if ($Stamp -gt $script:lastStateStamp) { $script:lastStateStamp = $Stamp }
    $definition = $animations[$script:action]
    $bubbleText.Text = $definition.Label
    switch ($script:action) {
        'running' { $stateDot.Fill = [Windows.Media.Brushes]::DodgerBlue }
        'review'  { $stateDot.Fill = [Windows.Media.Brushes]::DodgerBlue }
        'waiting' { $stateDot.Fill = [Windows.Media.Brushes]::Gold }
        'failed'  { $stateDot.Fill = [Windows.Media.Brushes]::Tomato }
        default   { $stateDot.Fill = [Windows.Media.Brushes]::MediumSeaGreen }
    }
    Show-Frame
}

function Read-PetState {
    if (-not (Test-Path -LiteralPath $statePath)) { return }
    try {
        $payload = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        $stamp = [long]$payload.updatedAt
        if ($stamp -gt $script:lastStateStamp) {
            Set-PetAction -Action ([string]$payload.state) -Stamp $stamp
        }
    } catch {
        # Ignore a partially written or unknown state update.
    }
}

function Save-WindowPosition {
    if ($Smoke) { return }
    New-Item -ItemType Directory -Force -Path $settingsDirectory | Out-Null
    @{ Left = $window.Left; Top = $window.Top } |
        ConvertTo-Json |
        Set-Content -LiteralPath $windowStatePath -Encoding UTF8
}

function Restore-WindowPosition {
    $virtualLeft = [Windows.SystemParameters]::VirtualScreenLeft
    $virtualTop = [Windows.SystemParameters]::VirtualScreenTop
    $virtualRight = $virtualLeft + [Windows.SystemParameters]::VirtualScreenWidth
    $virtualBottom = $virtualTop + [Windows.SystemParameters]::VirtualScreenHeight
    $fallbackLeft = $virtualRight - $window.Width - 32
    $fallbackTop = $virtualBottom - $window.Height - 32
    if (Test-Path -LiteralPath $windowStatePath) {
        try {
            $saved = Get-Content -Raw -LiteralPath $windowStatePath | ConvertFrom-Json
            if ($saved.Left -ge ($virtualLeft - 160) -and $saved.Left -le ($virtualRight - 80) -and
                $saved.Top -ge ($virtualTop - 160) -and $saved.Top -le ($virtualBottom - 80)) {
                $window.Left = [double]$saved.Left
                $window.Top = [double]$saved.Top
                return
            }
        } catch { }
    }
    $window.Left = $fallbackLeft
    $window.Top = $fallbackTop
}

function Set-Autostart([bool]$Enabled) {
    if ($Enabled) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($startupPath)
        $shortcut.TargetPath = (Get-Command powershell.exe).Source
        $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -File `"$PSCommandPath`""
        $shortcut.WorkingDirectory = $projectRoot
        $shortcut.IconLocation = $iconPath
        $shortcut.Save()
    } elseif (Test-Path -LiteralPath $startupPath) {
        Remove-Item -LiteralPath $startupPath -Force
    }
}

$contextMenu = New-Object Windows.Controls.ContextMenu
$pauseItem = New-Object Windows.Controls.MenuItem
$pauseItem.Header = '暂停动画'
$demoItem = New-Object Windows.Controls.MenuItem
$demoItem.Header = '演示下一个动作'
$autostartItem = New-Object Windows.Controls.MenuItem
$autostartItem.Header = '开机自动启动'
$autostartItem.IsCheckable = $true
$autostartItem.IsChecked = Test-Path -LiteralPath $startupPath
$hideItem = New-Object Windows.Controls.MenuItem
$hideItem.Header = '暂时隐藏'
$exitItem = New-Object Windows.Controls.MenuItem
$exitItem.Header = '退出'

$pauseItem.Add_Click({
    $script:paused = -not $script:paused
    $pauseItem.Header = if ($script:paused) { '继续动画' } else { '暂停动画' }
})
$demoItem.Add_Click({
    $index = [Array]::IndexOf($demoOrder, $script:action)
    Set-PetAction -Action $demoOrder[(($index + 1) % $demoOrder.Count)]
})
$autostartItem.Add_Click({ Set-Autostart -Enabled $autostartItem.IsChecked })
$hideItem.Add_Click({ $window.Hide() })
$exitItem.Add_Click({ $script:allowExit = $true; $window.Close() })

[void]$contextMenu.Items.Add($pauseItem)
[void]$contextMenu.Items.Add($demoItem)
[void]$contextMenu.Items.Add($autostartItem)
[void]$contextMenu.Items.Add((New-Object Windows.Controls.Separator))
[void]$contextMenu.Items.Add($hideItem)
[void]$contextMenu.Items.Add($exitItem)
$root.ContextMenu = $contextMenu

$root.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)
    if ($eventArgs.ClickCount -ge 2) {
        Set-PetAction -Action 'waving'
        return
    }
    try { $window.DragMove(); Save-WindowPosition } catch { }
})
$root.Add_MouseEnter({ $bubble.Visibility = [Windows.Visibility]::Visible })
$root.Add_MouseLeave({
    if ($script:action -notin @('waiting', 'failed', 'jumping')) {
        $bubble.Visibility = [Windows.Visibility]::Collapsed
    }
})

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(33)
$timer.Add_Tick({
    $now = [DateTime]::UtcNow
    if (($now - $script:lastPollAt).TotalMilliseconds -ge 600) {
        Read-PetState
        $script:lastPollAt = $now
    }
    $definition = $animations[$script:action]
    if (-not $script:paused -and ($now - $script:lastFrameAt).TotalMilliseconds -ge $definition.Milliseconds) {
        $script:frame = ($script:frame + 1) % [int]$definition.Frames
        $script:lastFrameAt = $now
        Show-Frame
    }
    if ($definition.ContainsKey('Transient') -and
        ($now - $script:transientAt).TotalMilliseconds -gt [int]$definition.Transient) {
        Set-PetAction -Action 'idle'
        $script:transientAt = [DateTime]::MinValue
    }
})

$notifyIcon = $null
if (-not $Smoke) {
    $notifyIcon = New-Object Windows.Forms.NotifyIcon
    $notifyIcon.Text = 'Codex Pet'
    $notifyIcon.Icon = [Drawing.Icon]::new($iconPath)
    $notifyMenu = New-Object Windows.Forms.ContextMenuStrip
    [void]$notifyMenu.Items.Add('显示宠物', $null, { $window.Show(); $window.Activate() })
    [void]$notifyMenu.Items.Add('隐藏宠物', $null, { $window.Hide() })
    [void]$notifyMenu.Items.Add('-')
    [void]$notifyMenu.Items.Add('退出', $null, { $script:allowExit = $true; $window.Close() })
    $notifyIcon.ContextMenuStrip = $notifyMenu
    $notifyIcon.Visible = $true
    $notifyIcon.Add_DoubleClick({ $window.Show(); $window.Activate() })
}

$window.Add_SourceInitialized({ Restore-WindowPosition })
$window.Add_Loaded({
    Set-PetAction -Action 'idle'
    $timer.Start()
    if ($Smoke) {
        $bubble.Visibility = [Windows.Visibility]::Visible
        $script:smokeTimer = New-Object Windows.Threading.DispatcherTimer
        $script:smokeTimer.Interval = [TimeSpan]::FromMilliseconds(800)
        $script:smokeTimer.Add_Tick({
            $script:smokeTimer.Stop()
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $smokePath) | Out-Null
            $render = [Windows.Media.Imaging.RenderTargetBitmap]::new(
                [int]$window.ActualWidth,
                [int]$window.ActualHeight,
                96,
                96,
                [Windows.Media.PixelFormats]::Pbgra32
            )
            $render.Render($window)
            $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
            [void]$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($render))
            $stream = [IO.File]::Open($smokePath, [IO.FileMode]::Create)
            try { $encoder.Save($stream) } finally { $stream.Dispose() }
            Write-Output "PowerShell smoke screenshot: $smokePath"
            $script:allowExit = $true
            $window.Close()
        })
        $script:smokeTimer.Start()
    }
})
$window.Add_Closing({
    if (-not $script:allowExit) {
        $_.Cancel = $true
        $window.Hide()
        return
    }
    Save-WindowPosition
    $timer.Stop()
    if ($notifyIcon) {
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
})

[void]$window.ShowDialog()
