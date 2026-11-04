# Getting Rivals Clipper onto other people's PCs, for free

Windows' Smart App Control blocks unsigned apps. Normal code-signing certificates cost money ($120 a year and up, or about $10 a month for Azure Artifact Signing), so this project uses free routes instead.

| Need | Free route | Status in the build |
| --- | --- | --- |
| Test on **your own PC** now | Turn Smart App Control off (below) and install the unsigned `.exe` | Built on every push |
| Install on **other people's PCs** | Publish through the **Microsoft Store**. Individual developer accounts are free, and Microsoft signs Store packages (MSIX) for you, so Smart App Control accepts them | Built when the Store secrets exist |
| Overwolf's game events and recorder working for **anyone** | Register the app in the free **Overwolf Developer Console** so builds get Overwolf's package signing | Switches on when the Overwolf secrets exist |

Each build's summary has a **Signature report** listing every shipped `.exe`/`.dll` and whether it's signed.

## 1. Test on your own PC now

1. Open **Windows Security**, then **App & browser control**, then **Smart App Control settings**, and choose **Off**.
2. Run `RivalsClipper-Setup-x.y.z.exe` from the latest build. When SmartScreen says "Windows protected your PC", click **More info** and then **Run anyway**.

On current Windows 11 updates you can turn Smart App Control back on from the same page. Older builds only allowed re-enabling it by resetting Windows.

## 2. Microsoft Store (free signing for everyone else)

1. Sign up as an **individual developer** at [Partner Center](https://partner.microsoft.com/dashboard/registration) (free).
2. **Apps and games**, then **New product**, then **MSIX or PWA app**, then reserve the name "Rivals Clipper".
3. Open **Product management**, then **Product identity**. Copy three values: **Package/Identity/Name**, **Package/Identity/Publisher** (starts with `CN=`), and **Package/Properties/PublisherDisplayName**.
4. Add them as GitHub secrets (table below). The next build also produces `RivalsClipper-x.y.z.appx`.
5. In Partner Center, create a submission and upload that `.appx`. Microsoft certifies it (usually a few days) and signs it. People then install it from the Store.

## 3. Overwolf Developer Console (free)

1. Sign up at [console.overwolf.com](https://console.overwolf.com) and submit Rivals Clipper as a new ow-electron app. Overwolf assigns an App UID.
2. Per Overwolf, the first QA submission is unsigned. Package signing applies from your first release after you have console access.
3. Get your keys: **Profile**, then **API Keys** (`OW_CLI_API_KEY`), and **Release management**, then **App Keys** (`OW_BUILD_KEY`). `OW_CLI_EMAIL` is your console email.

Overwolf's docs also ask for your own signature on the `.exe` for direct downloads. Store distribution covers that, because Microsoft signs the package.

## GitHub secrets

In the repo: **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**.

| Secret | Value |
| --- | --- |
| `STORE_IDENTITY_NAME` | Package/Identity/Name |
| `STORE_PUBLISHER` | Package/Identity/Publisher (`CN=...`) |
| `STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName |
| `OW_CLI_EMAIL` | Overwolf console email |
| `OW_CLI_API_KEY` | Overwolf API key |
| `OW_BUILD_KEY` | Overwolf app build key |

Tag builds (`v*`) refuse to build without the Overwolf secrets.

## Other free option: SignPath Foundation

[SignPath Foundation](https://signpath.org) signs open-source projects for free. It probably won't accept this project yet. It requires an established, released project with a verifiable reputation, a review team, and no proprietary components, and Overwolf's packages are proprietary. Worth revisiting later if the Store route doesn't work out.
