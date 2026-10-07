Add-Type -AssemblyName System.Drawing

$desktopRoot = Split-Path -Parent $PSScriptRoot
$assetDirectory = Join-Path $desktopRoot "assets"
$buildDirectory = Join-Path $desktopRoot "build"
$previewPath = Join-Path $assetDirectory "threadpath-icon.png"
$icoPath = Join-Path $buildDirectory "icon.ico"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "threadpath-icon"

New-Item -ItemType Directory -Force -Path $assetDirectory, $buildDirectory, $temporaryDirectory | Out-Null

function New-RoundedRectangle([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-ThreadPathImage([int]$size, [string]$path) {
  $scale = $size / 256.0
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $background = New-RoundedRectangle 0 0 $size $size (56 * $scale)
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#111827")), $background)

  $weavePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#d7e7ff"), 16 * $scale)
  $weavePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $weavePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $weavePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $weavePath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $weavePath.AddLines([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(0, -80 * $scale),
    [System.Drawing.PointF]::new(43 * $scale, -55 * $scale),
    [System.Drawing.PointF]::new(43 * $scale, -18 * $scale),
    [System.Drawing.PointF]::new(0, 7 * $scale)
  ))
  foreach ($angle in @(0, 60, 120, 180, 240, 300)) {
    $state = $graphics.Save()
    $graphics.TranslateTransform(128 * $scale, 128 * $scale)
    $graphics.RotateTransform($angle)
    $graphics.DrawPath($weavePen, $weavePath)
    $graphics.Restore($state)
  }

  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $weavePath.Dispose()
  $weavePen.Dispose()
  $background.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

function New-Ico([string[]]$imagePaths, [string]$path) {
  $payloads = [System.Collections.Generic.List[byte[]]]::new()
  foreach ($imagePath in $imagePaths) { [void]$payloads.Add([System.IO.File]::ReadAllBytes($imagePath)) }
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$payloads.Count)
    $offset = 6 + (16 * $payloads.Count)
    for ($index = 0; $index -lt $payloads.Count; $index++) {
      $image = [System.Drawing.Image]::FromFile($imagePaths[$index])
      $dimension = $image.Width
      $image.Dispose()
      $writer.Write([byte]$(if ($dimension -ge 256) { 0 } else { $dimension }))
      $writer.Write([byte]$(if ($dimension -ge 256) { 0 } else { $dimension }))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$payloads[$index].Length)
      $writer.Write([UInt32]$offset)
      $offset += $payloads[$index].Length
    }
    foreach ($payload in $payloads) { $writer.Write($payload) }
  }
  finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$iconImages = [System.Collections.Generic.List[string]]::new()
foreach ($size in $sizes) {
  $imagePath = Join-Path $temporaryDirectory "threadpath-$size.png"
  [void](New-ThreadPathImage $size $imagePath)
  [void]$iconImages.Add($imagePath)
}
New-ThreadPathImage 512 $previewPath
New-Ico $iconImages.ToArray() $icoPath
Remove-Item -Recurse -Force $temporaryDirectory
