// Ad-hoc sign the packed .app on macOS so Apple Silicon (Big Sur+) lets
// it launch without the "damaged" error. electron-builder doesn't have a
// native ad-hoc mode (passing `-` as identity makes it look up a real
// keychain entry), so we run codesign manually here.
//
// Notarization still isn't done — users see "unidentified developer" on
// first run and need right-click → Open. Code signing with a real
// Developer ID + notarization is a future task.
//
// This hook runs after electron-builder packs the .app but BEFORE it
// creates the DMG / zip, so the distributable contains the signed bundle.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adHocSign(context) {
  // Only sign macOS builds.
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productName}.app`,
  );

  console.log(`[after-pack] ad-hoc signing ${appPath}`);

  // --force: overwrite any stale/partial signatures from the packager.
  // --deep:  recursively sign all embedded helpers and frameworks.
  // --sign -: ad-hoc identity (no certificate needed).
  // --timestamp=none: no timestamp server (can't reach one without a cert).
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );

  // Verify the signature is valid.
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], {
    stdio: 'inherit',
  });

  console.log('[after-pack] ad-hoc signature verified');
};
