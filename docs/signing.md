# Signing Rivals Clipper

Other people's PCs need two separate signatures before Rivals Clipper works for them:

| Signature | Why | Who provides it | Cost |
| --- | --- | --- | --- |
| **Windows code signing** on every `.exe` (app, bundled ffmpeg, installer) | Smart App Control and SmartScreen block unsigned apps | Azure Artifact Signing (Microsoft) | about $9.99/month |
| **Overwolf package signing** | Overwolf's `gep` and `recorder` packages refuse to load in an app that isn't registered and signed with Overwolf | Overwolf Developer Console | free |

The build already handles both. When the GitHub secrets below exist, every build is signed automatically. Tag builds (`v*`) refuse to publish an unsigned installer. Each build's summary lists every shipped `.exe`/`.dll` and whether it's validly signed.

## 1. Azure Artifact Signing (Windows code signing)

Individual developers are eligible in the USA and Canada. Identity checks take a few business days.

1. Create an Azure account at [portal.azure.com](https://portal.azure.com) (needs a card).
2. Search for **Artifact Signing** (formerly Trusted Signing) and create an **Artifact Signing account** on the Basic plan. Pick a region; note the account name and the region's endpoint (for example `https://eus.codesigning.azure.net` for East US).
3. In the account, open **Identity validations**, then **New identity**, then **Public** and **Individual**. Complete the Microsoft identity check with your government ID. Wait for status **Completed**.
4. Open **Certificate profiles**, then **Create**, then **Public Trust**, and select the completed identity. Note the profile name.
5. Create a service principal for GitHub Actions: **Microsoft Entra ID**, then **App registrations**, then **New registration** (name it `rivals-clipper-ci`). On it, create a **client secret**. Note the tenant ID, client (application) ID and the secret value.
6. Back on the Artifact Signing account, go to **Access control (IAM)** and add the role **Artifact Signing Certificate Profile Signer** (older name: Trusted Signing Certificate Profile Signer) for `rivals-clipper-ci`.

## 2. Overwolf Developer Console (package signing)

1. Sign up at [console.overwolf.com](https://console.overwolf.com) and submit Rivals Clipper as a new ow-electron app. Overwolf assigns it an App UID.
2. Per Overwolf: the first QA submission is unsigned. Signing applies from the first release after you have Developer Console access.
3. Get the keys: **Profile**, then **API Keys** (`OW_CLI_API_KEY`), and **Release management**, then **App Keys** (`OW_BUILD_KEY`). `OW_CLI_EMAIL` is your console email.

## 3. Add the GitHub secrets

In the repo: **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**.

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Tenant ID from step 1.5 |
| `AZURE_CLIENT_ID` | Client ID from step 1.5 |
| `AZURE_CLIENT_SECRET` | Client secret value from step 1.5 |
| `AZURE_SIGNING_ENDPOINT` | Region endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | Artifact Signing account name |
| `AZURE_CERT_PROFILE` | Certificate profile name |
| `AZURE_PUBLISHER_NAME` | Exactly the name on the certificate (your validated legal name) |
| `OW_CLI_EMAIL` | Overwolf console email |
| `OW_CLI_API_KEY` | Overwolf API key |
| `OW_BUILD_KEY` | Overwolf app build key |

Then re-run the "Build Windows installer" workflow, or push to `main`. The run summary's **Signature report** shows what got signed.

## Notes

- A newly signed app can still show a SmartScreen "unrecognized app" notice for a while until the certificate builds reputation. Smart App Control accepts validly signed apps.
- The `gep` and `recorder` packages are downloaded and signed by Overwolf at runtime, so they don't need our certificate.
- Electron's own DLLs come from Electron's build and aren't re-signed by us. The signature report shows their status; if Smart App Control objects to one, add `"signExts": [".dll"]` under `build.win`.
