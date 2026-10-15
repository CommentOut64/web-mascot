Add-Type -AssemblyName System.Drawing

$projectRoot = "f:\neuroings\web-mascot"
$srcPath = Join-Path $projectRoot "extension\icons\icon-128.png"
$storeAssetsDir = Join-Path $projectRoot "store-assets"

if (-not (Test-Path $storeAssetsDir)) {
    New-Item -ItemType Directory -Path $storeAssetsDir | Out-Null
}

$srcBytes = [System.IO.File]::ReadAllBytes($srcPath)
$ms = New-Object System.IO.MemoryStream(,$srcBytes)
$srcImg = [System.Drawing.Image]::FromStream($ms)

# 1. 300x300 标准透明背景 Logo (Edge 商店官方推荐最佳尺寸)
$bmp300 = New-Object System.Drawing.Bitmap 300, 300
$g300 = [System.Drawing.Graphics]::FromImage($bmp300)
$g300.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g300.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g300.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g300.Clear([System.Drawing.Color]::Transparent)

# 适度留白 (padding 约 15px)，避免商店裁切边缘，保持角色居中
$destW = 270
$destH = 270
$offsetX = 15
$offsetY = 15
$g300.DrawImage($srcImg, $offsetX, $offsetY, $destW, $destH)
$g300.Dispose()

$logo300Path = Join-Path $storeAssetsDir "edge-store-logo-300x300.png"
$bmp300.Save($logo300Path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp300.Dispose()
Write-Host "Created: $logo300Path"

# 2. 128x128 标准 Logo (Edge 商店允许的最小规格，也是 Chrome 商店规格)
$logo128Path = Join-Path $storeAssetsDir "store-logo-128x128.png"
Copy-Item $srcPath $logo128Path -Force
Write-Host "Created: $logo128Path"

# 3. 300x300 徽章样式 Logo (浅色渐变圆角底板，适合商店深浅主题适配)
$bmpBadge = New-Object System.Drawing.Bitmap 300, 300
$gBadge = [System.Drawing.Graphics]::FromImage($bmpBadge)
$gBadge.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gBadge.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gBadge.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$gBadge.Clear([System.Drawing.Color]::Transparent)

# 绘制圆角柔和渐变底板
$rect = New-Object System.Drawing.Rectangle 10, 10, 280, 280
$radius = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(245, 247, 252), [System.Drawing.Color]::FromArgb(228, 235, 248), 45.0)
$gBadge.FillPath($brush, $path)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 100, 140, 200), 2)
$gBadge.DrawPath($pen, $path)

# 居中绘制立绘 (240x240)
$gBadge.DrawImage($srcImg, 30, 30, 240, 240)

$brush.Dispose()
$pen.Dispose()
$path.Dispose()
$gBadge.Dispose()

$logoBadgePath = Join-Path $storeAssetsDir "edge-store-logo-badge-300x300.png"
$bmpBadge.Save($logoBadgePath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmpBadge.Dispose()
Write-Host "Created: $logoBadgePath"

# 4. 440x280 商店小宣传瓷贴 (Small Promotional Tile)
$bmpPromo = New-Object System.Drawing.Bitmap 440, 280
$gPromo = [System.Drawing.Graphics]::FromImage($bmpPromo)
$gPromo.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gPromo.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gPromo.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$gPromo.Clear([System.Drawing.Color]::FromArgb(24, 28, 38))

# 绘制背景装饰点阵/渐变层
$promoRect = New-Object System.Drawing.Rectangle 0, 0, 440, 280
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($promoRect, [System.Drawing.Color]::FromArgb(26, 32, 44), [System.Drawing.Color]::FromArgb(15, 18, 25), 45.0)
$gPromo.FillRectangle($bgBrush, $promoRect)
$bgBrush.Dispose()

# 左侧放置桌宠主立绘 (高度 240)
$gPromo.DrawImage($srcImg, 20, 20, 240, 240)

# 右侧排版文字
$fontTitle = New-Object System.Drawing.Font("Segoe UI", 26, [System.Drawing.FontStyle]::Bold)
$fontSub = New-Object System.Drawing.Font("Microsoft YaHei", 12, [System.Drawing.FontStyle]::Regular)
$fontTag = New-Object System.Drawing.Font("Microsoft YaHei", 10, [System.Drawing.FontStyle]::Regular)

$textBrushTitle = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$textBrushSub = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 195, 220))
$textBrushTag = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, 140, 170))

$gPromo.DrawString("Web Mascot", $fontTitle, $textBrushTitle, 260, 70)
$gPromo.DrawString("网页桌面萌宠扩展", $fontSub, $textBrushSub, 264, 125)
$gPromo.DrawString("Shimeji · 互动 · 离线安全", $fontTag, $textBrushTag, 264, 160)

$fontTitle.Dispose()
$fontSub.Dispose()
$fontTag.Dispose()
$textBrushTitle.Dispose()
$textBrushSub.Dispose()
$textBrushTag.Dispose()
$gPromo.Dispose()

$promoPath = Join-Path $storeAssetsDir "store-promo-tile-440x280.png"
$bmpPromo.Save($promoPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmpPromo.Dispose()
Write-Host "Created: $promoPath"

$srcImg.Dispose()
$ms.Dispose()
Write-Host "All store assets prepared successfully!"

