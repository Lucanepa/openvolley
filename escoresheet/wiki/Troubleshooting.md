# Troubleshooting

## Common Issues

### Build Failures

**"Error: self-signed certificate"**
If you encounter certificate errors during local development, try regenerating the certificates:
```bash
npm run generate-certs
```

**"Electron failed to install"**
Sometimes Electron binaries are not downloaded correctly. Try clearing the cache and reinstalling:
```bash
rm -rf node_modules
npm install
```

### Runtime Issues

**"App is not syncing"**
-   Verify your internet connection.
-   Check the browser console (F12) for any errors related to Supabase or WebSocket connections.

**"PDF Generation fails"**
-   Ensure you have filled in all required fields in the match configuration.
-   Check if a popup blocker is preventing the PDF from opening.

## Getting Help

If you encounter a bug that isn't listed here, please open an issue on the [GitHub repository](https://github.com/lucacanepa/openvolley/issues).
