Add-Type -AssemblyName System.Drawing

$icoPath = "D:\Ankel\ankel.ico"
$batPath = "D:\Ankel\起動.bat"
$shortcutPath = "C:\Users\coela\OneDrive\デスクトップ\Ankel.lnk"

$bitmap = New-Object System.Drawing.Bitmap(256, 256)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 13, 17, 23))

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 118, 192, 234), 20)
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter

$points = @(
    [System.Drawing.Point]::new(128, 19),
    [System.Drawing.Point]::new(173, 83),
    [System.Drawing.Point]::new(237, 128),
    [System.Drawing.Point]::new(173, 173),
    [System.Drawing.Point]::new(128, 237),
    [System.Drawing.Point]::new(83, 173),
    [System.Drawing.Point]::new(19, 128),
    [System.Drawing.Point]::new(83, 83)
)

$g.DrawPolygon($pen, $points)
$g.Dispose()
$pen.Dispose()

$bitmap.Save($icoPath, [System.Drawing.Imaging.ImageFormat]::Icon)
$bitmap.Dispose()

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $batPath
$shortcut.IconLocation = $icoPath
$shortcut.Description = "Ankel"
$shortcut.Save()

Write-Host "Done"