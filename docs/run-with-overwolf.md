# Getting Overwolf's game events and recorder to load

Rivals Clipper uses two Overwolf packages: **gep** (kill and match events) and **recorder** (the replay buffer).
Overwolf only loads them for an app it trusts. An installer built without Overwolf's keys installs and opens fine,
but Overwolf's package manager refuses to start the packages. Its log (`owpm.log`) then says
"application is not signed", "missing asar-integrity token" and "initialize() aborted".

The asar-integrity token can't be made locally. Overwolf's signing server issues it at build time, using your
Overwolf keys. So there are two ways to get a working app, and both are free.

## 1. Your own PC: dev mode (do this first)

Dev mode skips the signature check, but only when the app runs from source. It never applies to an installed build.

1. Sign up at [dev.overwolf.com](https://dev.overwolf.com) and apply for developer status. Wait until it shows **Approved**.
2. Copy your dev key from your profile there.
3. Install [Node.js LTS](https://nodejs.org) and download this repo (Code, then Download ZIP, or `git clone`).
4. In PowerShell, from the repo folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1
   ```
   The script asks for the key once, can save it, installs dependencies and starts the app.

If the packages still don't load, the app shows a red notice explaining why, so you won't just see "Waiting for Marvel Rivals".

## 2. Installers for other people: Overwolf signing

A distributed build has to be signed. You need an app registered in the Overwolf Developer Console, with these keys:

| Secret | Where |
| --- | --- |
| `OW_CLI_EMAIL` | your Developer Console email |
| `OW_CLI_API_KEY` | Console, Profile, API Keys |
| `OW_BUILD_KEY` | Console, Release management, App Keys |

Add them as repository secrets and the GitHub Actions build signs the installer. Overwolf's
[app signing guide](https://dev.overwolf.com/ow-electron/guides/dev-tools/app-signing) has the full rules. Two of them
matter here:

- Console access comes after Overwolf's QA review.
- The guide says that from November 1, 2026, Overwolf only approves apps that use Overwolf monetization. That makes public
  distribution a separate decision from getting the app working on your own PC.
