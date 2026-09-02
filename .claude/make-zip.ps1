Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = 'C:\Users\tavis\Desktop\CommerceOS'
$dst = 'C:\Users\tavis\Desktop\CommerceOS-source.zip'
if (Test-Path $dst) { Remove-Item $dst -Force }
$excludeDirs = @('node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'reference', '.pnpm-store', '.turbo', '.claude', '.vscode')
$excludeFiles = @('*.log')

$files = Get-ChildItem -Path $src -Recurse -File -Force |
    Where-Object {
        $rel = $_.FullName.Substring($src.Length).TrimStart('\','/')
        $parts = $rel -split '[\\/]'
        $hit = $false
        foreach ($d in $excludeDirs) { if ($parts -contains $d) { $hit = $true; break } }
        if (-not $hit) {
            foreach ($f in $excludeFiles) { if ($_.Name -like $f) { $hit = $true; break } }
        }
        -not $hit
    }

$archive = [System.IO.Compression.ZipFile]::Open($dst, 'Create')
try {
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($src.Length).TrimStart('\','/').Replace('\','/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $rel, 'Optimal') | Out-Null
    }
} finally {
    $archive.Dispose()
}

$count = (Get-ChildItem -Path $src -Recurse -File -Force |
    Where-Object { $rel = $_.FullName.Substring($src.Length).TrimStart('\','/'); $parts = $rel -split '[\\/]'; -not ($excludeDirs | Where-Object { $parts -contains $_ }) } ).Count
$size = (Get-Item $dst).Length
Write-Output ("Files: {0}  Size: {1:N0} bytes  Path: {2}" -f $count, $size, $dst)