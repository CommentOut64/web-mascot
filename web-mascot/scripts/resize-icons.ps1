Add-Type -AssemblyName System.Drawing

$srcPath = "f:\neuroings\web-mascot\extension\icons\icon-128.png"
if (-not (Test-Path $srcPath)) {
    Write-Error "Source icon not found at $srcPath"
    exit 1
}

$srcBytes = [System.IO.File]::ReadAllBytes($srcPath)
$ms = New-Object System.IO.MemoryStream(,$srcBytes)
$srcImg = [System.Drawing.Image]::FromStream($ms)

function Resize-Icon($src, $w, $h, $destPath) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $w, $h)
    $g.Dispose()
    $bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Generated $destPath ($w x $h)"
}

Resize-Icon $srcImg 16 16 "f:\neuroings\web-mascot\extension\icons\icon-16.png"
Resize-Icon $srcImg 32 32 "f:\neuroings\web-mascot\extension\icons\icon-32.png"
Resize-Icon $srcImg 48 48 "f:\neuroings\web-mascot\extension\icons\icon-48.png"

$srcImg.Dispose()
$ms.Dispose()
Write-Host "All icons resized successfully."

