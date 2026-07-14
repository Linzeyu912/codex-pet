param(
    [switch]$Smoke,
    [ValidateSet('idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'looking', 'rolling', 'lying', 'mischief')]
    [string]$SmokeAction = 'idle'
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
$smokeFileName = if ($SmokeAction -eq 'idle') { 'powershell-smoke.png' } else { "powershell-smoke-$SmokeAction.png" }
$smokePath = Join-Path $projectRoot ".local-assets\qq-penguin\$smokeFileName"

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
    'idle'          = @{ Row = 0; Frames = 6; Durations = @(280, 110, 110, 140, 140, 320); Label = '陪着你' }
    'running-right' = @{ Row = 1; Frames = 8; Durations = @(120, 120, 120, 120, 120, 120, 120, 220); Label = '向右散步' }
    'running-left'  = @{ Row = 2; Frames = 8; Durations = @(120, 120, 120, 120, 120, 120, 120, 220); Label = '向左散步' }
    'waving'        = @{ Row = 3; Frames = 4; Durations = @(140, 140, 140, 280); Label = '你好呀'; Cycles = 4 }
    'jumping'       = @{ Row = 4; Frames = 5; Durations = @(140, 140, 140, 140, 280); Label = '完成啦'; Cycles = 3 }
    'failed'        = @{ Row = 5; Frames = 8; Durations = @(140, 140, 140, 140, 140, 140, 140, 240); Label = '遇到问题了'; Cycles = 3 }
    'waiting'       = @{ Row = 6; Frames = 6; Durations = @(150, 150, 150, 150, 150, 260); Label = '等你确认' }
    'running'       = @{ Row = 7; Frames = 6; Durations = @(120, 120, 120, 120, 120, 220); Label = 'Codex 正在工作' }
    'review'        = @{ Row = 8; Frames = 6; Durations = @(150, 150, 150, 150, 150, 280); Label = '正在检查' }
    'rolling'       = @{ Row = 5; Frames = 8; Durations = @(140, 140, 140, 140, 140, 140, 140, 240); Label = '摔倒又爬起'; Cycles = 1 }
    'lying'         = @{ Cells = @(@{ Column = 0; Row = 5 }, @{ Column = 1; Row = 5 }, @{ Column = 2; Row = 5 }, @{ Column = 3; Row = 5 }, @{ Column = 4; Row = 5 }, @{ Column = 4; Row = 5 }, @{ Column = 4; Row = 5 }, @{ Column = 3; Row = 5 }, @{ Column = 2; Row = 5 }, @{ Column = 1; Row = 5 }, @{ Column = 0; Row = 5 }); Frames = 11; Durations = @(180, 160, 160, 180, 420, 900, 420, 180, 160, 160, 240); Label = '躺一会儿'; Cycles = 1 }
    'mischief'      = @{ Cells = @(@{ Column = 0; Row = 5 }, @{ Column = 1; Row = 5 }, @{ Column = 2; Row = 5 }, @{ Column = 3; Row = 5 }, @{ Column = 2; Row = 5 }, @{ Column = 1; Row = 5 }, @{ Column = 0; Row = 5 }); Frames = 7; Durations = @(180, 150, 150, 360, 150, 150, 240); Label = '嘿嘿，装摔一下'; Cycles = 1 }
}
$lookCells = @()
for ($lookIndex = 0; $lookIndex -lt 16; $lookIndex += 1) {
    $lookCells += @{ Column = $lookIndex % 8; Row = 9 + [Math]::Floor($lookIndex / 8) }
}
$animations['looking'] = @{ Cells = $lookCells; Frames = 16; Milliseconds = 170; Label = '四处看看'; Cycles = 1 }
$demoOrder = @('idle', 'running-right', 'running-left', 'waving', 'jumping', 'looking', 'mischief', 'rolling', 'lying', 'failed', 'waiting', 'running', 'review')
$autonomousActions = @(
    'running-right', 'running-right',
    'running-left', 'running-left',
    'waving', 'jumping', 'looking', 'mischief', 'mischief',
    'rolling', 'lying', 'idle'
)
$script:action = 'idle'
$script:frame = 0
$script:completedCycles = 0
$script:paused = $false
$script:autoRoam = $true
$script:externalState = 'idle'
$script:lastFrameAt = [DateTime]::UtcNow
$script:lastMotionAt = [DateTime]::UtcNow
$script:lastPollAt = [DateTime]::MinValue
$script:lastStateStamp = [long]0
$script:directionalActionEndsAt = [DateTime]::MinValue
$script:nextAutoActionAt = [DateTime]::UtcNow.AddSeconds(2)
$script:allowExit = $false
$script:smokeTimer = $null

function Show-Frame {
    $definition = $animations[$script:action]
    $column = [int]$script:frame
    $row = if ($definition.ContainsKey('Row')) { [int]$definition.Row } else { 0 }
    if ($definition.ContainsKey('Cells')) {
        $cell = $definition.Cells[$script:frame % $definition.Cells.Count]
        $column = [int]$cell.Column
        $row = [int]$cell.Row
    }
    $rectangle = [Windows.Int32Rect]::new(
        ($column * 192),
        ($row * 208),
        192,
        208
    )
    $crop = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap, $rectangle)
    $crop.Freeze()
    $petImage.Source = $crop
}

function Get-FrameDuration($definition, [int]$frame) {
    if ($definition.ContainsKey('Durations')) {
        return [int]$definition.Durations[$frame % $definition.Durations.Count]
    }
    return [int]$definition.Milliseconds
}

function Set-PetAction([string]$Action, [long]$Stamp = 0) {
    if (-not $animations.ContainsKey($Action)) { return }
    $changed = $script:action -ne $Action
    $newerState = $Stamp -gt $script:lastStateStamp
    $restartFiniteAction = $animations[$Action].ContainsKey('Cycles')
    if ($changed) {
        $script:action = $Action
    }
    if ($changed -or $newerState -or $restartFiniteAction) {
        $script:frame = 0
        $script:completedCycles = 0
        $script:lastFrameAt = [DateTime]::UtcNow
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
    if ($script:action -in @('waving', 'jumping', 'failed', 'waiting', 'looking', 'mischief', 'rolling', 'lying')) {
        $bubble.Visibility = [Windows.Visibility]::Visible
    } elseif (-not $root.IsMouseOver) {
        $bubble.Visibility = [Windows.Visibility]::Collapsed
    }
    Show-Frame
}

function Schedule-NextAutoAction(
    [int]$MinimumMilliseconds = 1600,
    [int]$MaximumMilliseconds = 4200
) {
    $delay = Get-Random -Minimum $MinimumMilliseconds -Maximum ($MaximumMilliseconds + 1)
    $script:nextAutoActionAt = [DateTime]::UtcNow.AddMilliseconds($delay)
}

function Start-AutonomousAction {
    if ($Smoke -or -not $script:autoRoam -or $script:paused -or $script:externalState -ne 'idle') { return }
    $choice = Get-Random -InputObject $autonomousActions
    $virtualLeft = [Windows.SystemParameters]::VirtualScreenLeft
    $virtualRight = $virtualLeft + [Windows.SystemParameters]::VirtualScreenWidth
    $center = $window.Left + ($window.Width / 2)
    if ($choice -eq 'running-left' -and $center -lt ($virtualLeft + 220)) { $choice = 'running-right' }
    if ($choice -eq 'running-right' -and $center -gt ($virtualRight - 220)) { $choice = 'running-left' }
    Set-PetAction -Action $choice
    if ($choice -in @('running-right', 'running-left')) {
        $script:directionalActionEndsAt = [DateTime]::UtcNow.AddMilliseconds(5200)
        $script:nextAutoActionAt = [DateTime]::MaxValue
    } elseif ($choice -eq 'idle') {
        Schedule-NextAutoAction
    } else {
        $script:directionalActionEndsAt = [DateTime]::MinValue
        $script:nextAutoActionAt = [DateTime]::MaxValue
    }
}

function Move-Pet([DateTime]$Now) {
    $elapsed = ($Now - $script:lastMotionAt).TotalSeconds
    $script:lastMotionAt = $Now
    if ($Smoke -or $script:paused -or $script:action -notin @('running-right', 'running-left')) { return }

    $virtualLeft = [Windows.SystemParameters]::VirtualScreenLeft + 12
    $virtualRight = [Windows.SystemParameters]::VirtualScreenLeft + [Windows.SystemParameters]::VirtualScreenWidth - $window.Width - 12
    $direction = if ($script:action -eq 'running-right') { 1 } else { -1 }
    $distance = [Math]::Min(7, [Math]::Max(0.5, $elapsed * 72))
    $nextLeft = $window.Left + ($direction * $distance)

    if ($nextLeft -ge $virtualRight) {
        $window.Left = $virtualRight
        if ($script:externalState -eq 'running-right') { $script:externalState = 'running-left' }
        Set-PetAction -Action 'running-left'
    } elseif ($nextLeft -le $virtualLeft) {
        $window.Left = $virtualLeft
        if ($script:externalState -eq 'running-left') { $script:externalState = 'running-right' }
        Set-PetAction -Action 'running-right'
    } else {
        $window.Left = $nextLeft
    }
}

function Read-PetState {
    if (-not (Test-Path -LiteralPath $statePath)) { return }
    try {
        $payload = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        $stamp = [long]$payload.updatedAt
        if ($stamp -gt $script:lastStateStamp) {
            $state = [string]$payload.state
            if (-not $animations.ContainsKey($state)) { return }
            $script:externalState = $state
            $script:directionalActionEndsAt = [DateTime]::MinValue
            Set-PetAction -Action $state -Stamp $stamp
            if ($state -eq 'idle') {
                Schedule-NextAutoAction
            } else {
                $script:nextAutoActionAt = [DateTime]::MaxValue
            }
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
$autoRoamItem = New-Object Windows.Controls.MenuItem
$autoRoamItem.Header = '自动闲逛'
$autoRoamItem.IsCheckable = $true
$autoRoamItem.IsChecked = $true
$actionsItem = New-Object Windows.Controls.MenuItem
$actionsItem.Header = '立即动作'
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
    $script:externalState = 'idle'
    $nextAction = $demoOrder[(($index + 1) % $demoOrder.Count)]
    Set-PetAction -Action $nextAction
    $script:directionalActionEndsAt = if ($nextAction -in @('running-right', 'running-left')) {
        [DateTime]::UtcNow.AddMilliseconds(5200)
    } else {
        [DateTime]::MinValue
    }
})
$autoRoamItem.Add_Click({
    $script:autoRoam = $autoRoamItem.IsChecked
    $script:externalState = 'idle'
    if ($script:autoRoam) {
        $script:directionalActionEndsAt = [DateTime]::MinValue
        Set-PetAction -Action 'idle'
        Schedule-NextAutoAction -MinimumMilliseconds 400 -MaximumMilliseconds 1000
    }
})
$quickActions = [ordered]@{
    '向左散步' = 'running-left'
    '向右散步' = 'running-right'
    '挥挥手' = 'waving'
    '跳一下' = 'jumping'
    '四处张望' = 'looking'
    '装摔一下' = 'mischief'
    '躺一下' = 'lying'
    '摔倒又爬起' = 'rolling'
}
foreach ($entry in $quickActions.GetEnumerator()) {
    $item = New-Object Windows.Controls.MenuItem
    $item.Header = $entry.Key
    $item.Tag = $entry.Value
    $item.Add_Click({
        param($sender, $eventArgs)
        $script:externalState = 'idle'
        $requestedAction = [string]$sender.Tag
        Set-PetAction -Action $requestedAction
        $script:directionalActionEndsAt = if ($requestedAction -in @('running-right', 'running-left')) {
            [DateTime]::UtcNow.AddMilliseconds(5200)
        } else {
            [DateTime]::MinValue
        }
    })
    [void]$actionsItem.Items.Add($item)
}
$autostartItem.Add_Click({ Set-Autostart -Enabled $autostartItem.IsChecked })
$hideItem.Add_Click({ $window.Hide() })
$exitItem.Add_Click({ $script:allowExit = $true; $window.Close() })

[void]$contextMenu.Items.Add($pauseItem)
[void]$contextMenu.Items.Add($autoRoamItem)
[void]$contextMenu.Items.Add($actionsItem)
[void]$contextMenu.Items.Add($demoItem)
[void]$contextMenu.Items.Add($autostartItem)
[void]$contextMenu.Items.Add((New-Object Windows.Controls.Separator))
[void]$contextMenu.Items.Add($hideItem)
[void]$contextMenu.Items.Add($exitItem)
$root.ContextMenu = $contextMenu

$root.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)
    if ($eventArgs.ClickCount -ge 2) {
        $script:externalState = 'idle'
        $script:directionalActionEndsAt = [DateTime]::MinValue
        Set-PetAction -Action 'waving'
        return
    }
    try { $window.DragMove(); Save-WindowPosition } catch { }
})
$root.Add_MouseEnter({ $bubble.Visibility = [Windows.Visibility]::Visible })
$root.Add_MouseLeave({
    if ($script:action -notin @('waiting', 'failed', 'jumping', 'waving', 'looking', 'mischief', 'rolling', 'lying')) {
        $bubble.Visibility = [Windows.Visibility]::Collapsed
    }
})

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(33)
$timer.Add_Tick({
    $now = [DateTime]::UtcNow
    if (-not $Smoke -and ($now - $script:lastPollAt).TotalMilliseconds -ge 600) {
        Read-PetState
        $script:lastPollAt = $now
    }
    $definition = $animations[$script:action]
    $frameDuration = Get-FrameDuration -definition $definition -frame $script:frame
    if (-not $script:paused -and ($now - $script:lastFrameAt).TotalMilliseconds -ge $frameDuration) {
        $nextFrame = ($script:frame + 1) % [int]$definition.Frames
        $finishedCycle = $nextFrame -eq 0
        if ($finishedCycle) { $script:completedCycles += 1 }
        if ($finishedCycle -and $definition.ContainsKey('Cycles') -and
            $script:completedCycles -ge [int]$definition.Cycles) {
            if ($script:externalState -eq $script:action) { $script:externalState = 'idle' }
            Set-PetAction -Action 'idle'
            Schedule-NextAutoAction
        } else {
            $script:frame = $nextFrame
            $script:lastFrameAt = $now
            Show-Frame
        }
    }
    Move-Pet -Now $now
    if ($script:action -in @('running-right', 'running-left') -and
        $script:directionalActionEndsAt -ne [DateTime]::MinValue -and
        $now -ge $script:directionalActionEndsAt -and $script:frame -eq 0) {
        $script:directionalActionEndsAt = [DateTime]::MinValue
        Set-PetAction -Action 'idle'
        Schedule-NextAutoAction
    }
    if ($script:action -eq 'idle' -and $now -ge $script:nextAutoActionAt) {
        Start-AutonomousAction
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
    $initialAction = if ($Smoke) { $SmokeAction } else { 'idle' }
    Set-PetAction -Action $initialAction
    if (-not $Smoke) { Schedule-NextAutoAction -MinimumMilliseconds 800 -MaximumMilliseconds 1800 }
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
