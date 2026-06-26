// Ad-hoc sign the packed .app on macOS so Apple Silicon (Big Sur+) lets
// it launch without the "damaged" error. electron-builder doesn't have a
// native ad-hoc mode (passing `-` as identity makes it look up a real
// keychain entry), so we run codesign manually here.
//
// This hook ONLY runs when no real signing certificate is configured
// (CSC_LINK env var absent). When CSC_LINK is set — i.e. CI release
// builds with a real Developer ID Application certificate — electron-
// builder signs the .app itself (with Hardened Runtime + entitlements)
// and we must NOT overwrite that signature with an ad-hoc one.
//
// Notarization is handled separately by electron-builder's built-in
// @electron/notarize integration (mac.notarize: true) when the APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID env vars are present.
//
// This hook runs after electron-builder packs the .app but BEFORE it
// creates the DMG / zip, so the distributable contains the signed bundle.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adHocSign(context) {
  // Only sign macOS builds.
  if (context.electronPlatformName !== 'darwin') return;

  // If a real signing certificate is configured, electron-builder has
  // already signed the .app — skip ad-hoc signing to avoid clobbering it.
  if (process.env.CSC_LINK) {
    console.log('[after-pack] CSC_LINK present — real signature applied by electron-builder, skipping ad-hoc sign');
    return;
  }

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
