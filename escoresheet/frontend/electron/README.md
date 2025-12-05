# Electron Icons

Place your app icons in this directory:

- **icon.ico** - Windows icon (256x256, .ico format)
- **icon.icns** - macOS icon (512x512, .icns format)  
- **icon.png** - Linux icon (512x512, .png format)

## Creating Icons

### Windows (.ico)
- Use a tool like [IcoFX](https://icofx.ro/) or online converters
- Size: 256x256 pixels
- Multiple sizes (16, 32, 48, 64, 128, 256) recommended

### macOS (.icns)
- Use `iconutil` on macOS:
  ```bash
  # Create iconset directory with sizes: 16, 32, 64, 128, 256, 512, 1024
  iconutil -c icns icon.iconset
  ```
- Or use online converters
- Size: 512x512 pixels minimum

### Linux (.png)
- Size: 512x512 pixels
- PNG format with transparency

## Temporary Solution

If you don't have icons yet, you can:
1. Use the favicon.png from `public/` folder
2. Convert it to the required formats
3. Or the build will use default Electron icons (not recommended for production)
