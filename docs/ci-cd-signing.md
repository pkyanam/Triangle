# CI/CD Code-Signing Setup (macOS)

This guide walks you through generating every credential the Release
workflow needs to produce a **signed + notarized** macOS `.dmg`/`.zip` of
Triangle, and adding them as GitHub Actions secrets.

Linux (`AppImage`) and Windows builds are **not** signed by this setup.
Linux has no code-signing requirement; Windows signing is deferred.

---

## How signing works in this repo

The Release workflow (`.github/workflows/release.yml`) runs only on
`vX.Y.Z` tag pushes. On the `macos-14` (arm64) job it injects five
secrets into the `electron-builder` step:

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | Base64-encoded `Developer ID Application` `.p12` certificate |
| `CSC_KEY_PASSWORD` | Password you set when exporting the `.p12` |
| `APPLE_ID` | Apple ID email used to submit the app for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for the notarization API |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID |

When **all five** are present, electron-builder:

1. Imports the `.p12` into a temporary keychain on the runner,
2. Signs `Triangle.app` with your **Developer ID Application**
   certificate (Hardened Runtime + entitlements),
3. Submits the signed app to Apple's notarytool service and waits for
   approval, then staples the notarization ticket to the bundle.

When any of the five are **absent**, signing/notarization is skipped and
`build/after-pack.cjs` falls back to an **ad-hoc** signature so the app
still launches on Apple Silicon (users see "unidentified developer" and
must right-click → Open). This keeps CI green even before you configure
secrets.

> Signing only runs on tag-triggered Release builds. PR/push CI builds
> never attempt signing.

---

## Prerequisites

- A paid **Apple Developer Program** membership ($99/yr). Confirm at
  <https://developer.apple.com/account>.
- A Mac with **Keychain Access** and **Xcode** (or the Xcode Command
  Line Tools) installed.
- Admin access to the GitHub repo's **Settings → Secrets and variables →
  Actions**.

---

## Step 1 — Create a "Developer ID Application" certificate

This is the certificate used to sign apps distributed **outside** the
Mac App Store. (Do **not** create "Developer ID Installer" or "Mac App
Distribution" — those are for the App Store / installer packages.)

1. On your Mac, open **Keychain Access → Certificate Assistant →
   Request a Certificate from a Certificate Authority…**
2. Fill in your Apple ID email, a common name (e.g. `Triangle`), leave
   CA Email blank, choose **Saved to disk**, and save the `.certSigningRequest`
   file.
3. In a browser, sign in to
   <https://developer.apple.com/account/resources/certificates/list>.
4. Click **+** → under **Software**, choose **Developer ID Application**
   → Continue → upload the `.certSigningRequest` from step 2 → Continue.
5. Download the generated `developerID_application.cer` file.
6. Double-click the `.cer` file to add it to your login keychain. It
   should appear as `Developer ID Application: <Your Name> (<TEAMID>)`.

> You can only have **one** Developer ID Application certificate per
> team. If one already exists, reuse it (download it to the Mac where
> you'll export the `.p12`).

---

## Step 2 — Export the certificate as a `.p12`

1. Open **Keychain Access** → **My Certificates** (or **login**
   keychain → **Certificates**).
2. Find `Developer ID Application: <Your Name> (<TEAMID>)` and expand
   the disclosure triangle so both the certificate **and** its private
   key are visible.
3. Right-click the certificate (not the key) → **Export…**.
4. Save as `Triangle.p12` to a known location (e.g. `~/Downloads`).
5. Set a strong password — this becomes **`CSC_KEY_PASSWORD`**. Remember
   it; you'll need it in the next step.
6. Click **Save**. Enter your Mac login password if Keychain asks.

---

## Step 3 — Base64-encode the `.p12` (for `CSC_LINK`)

electron-builder accepts `CSC_LINK` as a base64 string. On your Mac:

```sh
base64 -i ~/Downloads/Triangle.p12 | pbcopy
```

The base64 content is now on your clipboard. (If `pbcopy` isn't
available, run `base64 -i ~/Downloads/Triangle.p12` and copy the output
manually — it must be one continuous string with no line breaks; if your
`base64` wraps lines, pipe through `tr -d '\n'`.)

---

## Step 4 — Create an App-Specific Password (for notarization)

Notarization authenticates with your Apple ID, but Apple requires an
**app-specific password** rather than your account password.

1. Go to <https://account.apple.com/account/manage> (sign in with the
   Apple ID you'll use for notarization — this should be the same Apple
   Developer account that owns the certificate).
2. Under **Sign-In and Security**, click **App-Specific Passwords** →
   **Generate an app-specific password** (or follow the "Generate
   password" link).
3. Label it e.g. `Triangle Notarization`.
4. Copy the generated 16-character password (`xxxx-xxxx-xxxx-xxxx`).
   This becomes **`APPLE_APP_SPECIFIC_PASSWORD`**.

> You must have two-factor authentication enabled on the Apple ID to
> generate app-specific passwords.

---

## Step 5 — Find your Team ID

1. Go to <https://developer.apple.com/account#MembershipDetailsCard> (or
   **Account → Membership** in the developer portal).
2. Look for **Team ID** — a 10-character alphanumeric string (e.g.
   `A1B2C3D4E5`).
3. This becomes **`APPLE_TEAM_ID`**.

> You can also see the Team ID in parentheses in the certificate name in
> Keychain Access: `Developer ID Application: Your Name (A1B2C3D4E5)`.

---

## Step 6 — Add all five secrets to GitHub

1. Go to your repo on GitHub → **Settings → Secrets and variables →
   Actions → New repository secret**.
2. Add each of the five secrets below. Use **exactly** these names
   (case-sensitive):

   | Name | Value |
   | --- | --- |
   | `CSC_LINK` | The base64 string from Step 3 (clipboard contents) |
   | `CSC_KEY_PASSWORD` | The `.p12` password from Step 2 |
   | `APPLE_ID` | The Apple ID email (e.g. `you@example.com`) |
   | `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from Step 4 |
   | `APPLE_TEAM_ID` | The 10-char Team ID from Step 5 |

3. After saving all five, the Release workflow will sign + notarize on
   the next `vX.Y.Z` tag push.

> **Tip:** GitHub secrets are encrypted at rest and masked in logs. Never
> commit these values to the repo or paste them into a file under
> version control.

---

## Step 7 — Trigger a signed release

```sh
git tag v0.2.0
git push origin v0.2.0
```

Watch the **Release** workflow under the **Actions** tab. The
`macos-arm64` job will:

- build → sign with Developer ID → notarize via `notarytool` → staple →
  produce `Triangle-0.2.0-arm64.dmg` and `Triangle-0.2.0-arm64-mac.zip`.

Notarization typically takes 2–10 minutes. If it fails, the job log will
show the Apple notarytool error (common causes: missing entitlements,
unsigned embedded helper, wrong Team ID).

---

## Verifying a signed build locally

After downloading the published `.dmg`:

```sh
# Should print "Developer ID Application: <Your Name> (<TEAMID>)"
codesign -dv --verbose=4 /Applications/Triangle.app

# Should print "notarized" with no errors
spctl -a -vvv -t exec /Applications/Triangle.app
xcrun stapler validate /Applications/Triangle.app
```

A properly signed + notarized app opens with **no** Gatekeeper prompt.

---

## Troubleshooting

### `notarization failed: The Apple ID is invalid`
Double-check `APPLE_ID` matches the account that owns the Developer ID
certificate, and that `APPLE_APP_SPECIFIC_PASSWORD` is correct (regenerate
if needed — old ones may have been revoked).

### `no identity found` / electron-builder doesn't sign
`CSC_LINK` is empty or not base64-encoded correctly. Re-run the base64
command and ensure the secret has no leading/trailing whitespace or
newlines.

### `You have not agreed to the Apple Developer Program License Agreement`
Sign in to <https://developer.apple.com/account> and accept the pending
license agreement. Notarization is blocked until you do.

### Notarization succeeds but `spctl` still rejects
Ensure `hardenedRuntime: true` and the entitlements files exist (they're
committed under `apps/desktop/build/`). The `after-pack.cjs` hook must
**not** be re-signing after electron-builder — it skips itself when
`CSC_LINK` is set.

### Ad-hoc builds still show "damaged"
This is expected for unsigned/tagless builds. Only tag releases with all
five secrets configured produce a notarized app.

---

## What about Windows / Linux?

- **Linux**: `AppImage` has no code-signing requirement; users run it
  directly. Skipped by design.
- **Windows**: Not configured in this pass. To add later, obtain an OV/EV
  code-signing certificate, export it as a `.p12`, and set `CSC_LINK` +
  `CSC_KEY_PASSWORD` for the Windows job (the same secret names work —
  they're scoped per-job in the workflow). Consider Azure Trusted Signing
  for hardware-key-backed EV certs.
