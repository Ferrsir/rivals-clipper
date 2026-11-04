// Build config for ow-electron-builder. Starts from package.json "build" and turns on signing
// when the signing secrets are present (see docs/signing.md).
//
// - Azure Artifact Signing (formerly Trusted Signing) signs every .exe we ship: the app exe,
//   ffmpeg in app.asar.unpacked, and the NSIS installer/uninstaller.
// - Overwolf signing signs the app's package integrity, which the gep/recorder packages need
//   to load on other people's PCs.
// - RELEASE_BUILD=1 (tag builds) refuses to produce an unsigned installer.

const pkg = require('./package.json');

const env = process.env;
const has = (...keys) => keys.every((k) => env[k] && env[k].trim() !== '');

const azureReady = has('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_CERT_PROFILE', 'AZURE_PUBLISHER_NAME');
const overwolfReady = has('OW_CLI_EMAIL', 'OW_CLI_API_KEY', 'OW_BUILD_KEY');
const release = env.RELEASE_BUILD === '1';

if (release && (!azureReady || !overwolfReady)) {
  const missing = [!azureReady && 'Azure Artifact Signing secrets', !overwolfReady && 'Overwolf signing secrets'].filter(Boolean).join(' and ');
  throw new Error(`Release builds must be signed, but ${missing} are not set. See docs/signing.md.`);
}

const config = JSON.parse(JSON.stringify(pkg.build));

config.overwolf = { ...(config.overwolf || {}), requireSigning: overwolfReady };

if (azureReady) {
  config.forceCodeSigning = true;
  config.win = {
    ...config.win,
    azureSignOptions: {
      publisherName: env.AZURE_PUBLISHER_NAME,
      endpoint: env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: env.AZURE_CERT_PROFILE,
    },
  };
}

console.log(`[build] code signing: ${azureReady ? 'Azure Artifact Signing' : 'OFF (unsigned)'}; Overwolf signing: ${overwolfReady ? 'on' : 'off'}`);

module.exports = config;
