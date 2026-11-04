// Build config for ow-electron-builder. Starts from package.json "build" and adds the free
// signing/distribution routes when their secrets are present (see docs/signing.md).
//
// - Overwolf package signing (free Overwolf Developer Console): the gep/recorder packages need it
//   to load on other people's PCs.
// - Microsoft Store package (MSIX, free individual developer account): Microsoft signs it on
//   publish, which is what lets it pass Smart App Control on other people's PCs at no cost.
// - The NSIS .exe is always built too, unsigned, for testing on your own PC.
// - RELEASE_BUILD=1 (tag builds) refuses to build without Overwolf signing.

const pkg = require('./package.json');

const env = process.env;
const has = (...keys) => keys.every((k) => env[k] && env[k].trim() !== '');

const overwolfReady = has('OW_CLI_EMAIL', 'OW_CLI_API_KEY', 'OW_BUILD_KEY');
const storeReady = has('STORE_IDENTITY_NAME', 'STORE_PUBLISHER', 'STORE_PUBLISHER_DISPLAY_NAME');
const release = env.RELEASE_BUILD === '1';

if (release && !overwolfReady) {
  throw new Error('Release builds need Overwolf signing (OW_CLI_EMAIL, OW_CLI_API_KEY, OW_BUILD_KEY). See docs/signing.md.');
}

const config = JSON.parse(JSON.stringify(pkg.build));

config.overwolf = { ...(config.overwolf || {}), requireSigning: overwolfReady };

if (storeReady) {
  config.win = { ...config.win, target: ['nsis', 'appx'] };
  config.appx = {
    // These three come from Partner Center > your app > Product identity.
    identityName: env.STORE_IDENTITY_NAME,
    publisher: env.STORE_PUBLISHER,
    publisherDisplayName: env.STORE_PUBLISHER_DISPLAY_NAME,
    displayName: 'Rivals Clipper',
    applicationId: 'RivalsClipper',
    artifactName: 'RivalsClipper-${version}.${ext}',
  };
}

console.log(`[build] Overwolf signing: ${overwolfReady ? 'on' : 'off'}; Microsoft Store package: ${storeReady ? 'on' : 'off'}; .exe installer: unsigned`);

module.exports = config;
