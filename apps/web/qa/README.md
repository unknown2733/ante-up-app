# Seeker USB QA

This is a local QA helper, not product code or a deployed service. Node 22+ is required. It uses an explicit ADB executable and dedicated localhost server port 5038. There is no system PATH change or Android app installation. No private wallet keys are read. Existing ADB host identity may be used by ADB itself; this is not the wallet identity.

## Prepared tools (2026-10-13 KST)

- Official source: https://developer.android.com/tools/releases/platform-tools
- Download: https://dl.google.com/android/repository/platform-tools-latest-windows.zip
- ZIP SHA-256 observed after HTTPS download: `45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99`.
- Executable reports Android Debug Bridge 1.0.41 / Platform Tools 37.0.1-15733141.
- Local placement: project `.codex-work/android-tools/platform-tools/adb.exe`.
- This hash records downloaded bytes. It is not a separately published vendor checksum verification.
- Official Chrome workflow: https://developer.chrome.com/docs/devtools/remote-debugging/#debug-manually-through-android-debug-bridge-adb

`seeker.mjs` finds the above path relative to the repo's `.codex-work/implementation/<clone>` location. Set `ANTE_UP_ADB` to an explicit executable path elsewhere if needed. Raw captures go to ignored `<repo>/.runtime/mobile-qa/`; do not commit screenshots containing personal data.

## User connection

1. Use a USB data cable and unlock Seeker.
2. Settings → About phone → tap Build number seven times if developer options are not enabled (enter the device PIN personally when requested).
3. Settings → System → Developer options → USB debugging on.
4. Accept this computer's USB debugging/RSA prompt personally.
5. Open Chrome at `https://ante-up.fun` when the QA operator requests it. Keep only one Ante Up tab open, or select its target ID explicitly.

At initial preparation, Windows detected a MediaTek MTP USB device but `adb devices -l` was empty. That establishes USB data connection, not ADB authorization. No browser or device screen was changed.

## Commands from repository root

```powershell
node apps/web/qa/seeker.mjs devices
node apps/web/qa/seeker.mjs inspect --serial DEVICE_SERIAL
node apps/web/qa/seeker.mjs capture --serial DEVICE_SERIAL
node apps/web/qa/seeker.mjs click --serial DEVICE_SERIAL --label '기존 요청 상태 다시 확인'
node apps/web/qa/seeker.mjs fill --serial DEVICE_SERIAL --label '0.000000' --value 1
node apps/web/qa/seeker.mjs reload --serial DEVICE_SERIAL
node --test apps/web/qa/seeker.test.mjs
```

`inspect` reads visible page text and control labels. It reports only exact `https://ante-up.fun` page targets, does not print other tab titles/URLs, does not read browser stores or wallet objects, and removes its temporary CDP forward on exit. Multiple devices or matching tabs require explicit selection. Chrome must expose its standard `chrome_devtools_remote` socket. If unavailable, report that limitation rather than enabling an unrelated app's debugging.

`click` requires a unique visible enabled button/link with an exact observed label. External links are blocked. It can open a wallet prompt via the app, but does not interact with the native wallet, protected biometric approval or PIN. The user performs those steps. Coordinate with the integration operator before clicks while the user manually tests another flow. No automatic polling, retries, signing or transfers occur in this helper.

Only the app's web page is captured; this is not whole-device screen automation. Do not use full-device logcat, package enumeration, file pulls, screenshots of wallet screens, or unrestricted browser storage/network dumps. Read actual finalized outcomes separately through the existing API/chain verification helpers.

## Actual device QA sequence

1. Read current wallet/network and operation status. Reuse a funded wallet; do not repeatedly request faucet during cooldown.
2. Check reload/return from wallet and resolve any existing pending operation before creating another.
3. Request one explicit action; user handles Seed Vault approval.
4. Inspect app status, then integration verifies actual signature/chain finality and resulting asset/record state.
5. After normal path passes, test one explicit rejection followed by user retry. An unresolved wallet promise is not proof of cancellation; do not blindly resend.
6. Paid-chip tests use Devnet tUSD only and a root-approved market/amount. Pro/LP/backend scenarios run separately with test wallets.

## Android + Phantom manual run

For Chrome + MWA coverage, open the HTTPS app in Android Chrome, then connect through the Mobile Wallet Adapter chooser and select Phantom. If using Phantom's in-app browser instead, record that as a separate environment; it does not prove Chrome/MWA coverage. The application is Solana **Devnet**, and this must also be the wallet network. Send only the public address or transaction signature if assistance is needed.

With fees available, faucet → quote → sign → finalized 1,000 tUSD, then solana market → free open → finalized → free close → finalized. If the address has already used faucet, reuse its balance. Save the displayed request ID/error on failure. Do not repeat the action while UNKNOWN; use the existing request recheck. A zero score when both actions use the same observation is expected. SAS issuance is a separate asynchronous stage.

## Validation boundary

Four local tests cover device ambiguity, unauthorized devices, exact origin checks, private tab exclusion, debugger endpoint restrictions and bounded loopback transport. The latter uses a direct HTTP Agent so host proxy environment settings cannot redirect the ADB discovery request.

On 2026-10-13 00:31–00:33 KST, authorized Seeker / Android16 was identified and actual Ante Up market page inspection/capture succeeded (CSS viewport665×1245). No device click, navigation or signing occurred. The later permitted pending-faucet recheck click was prevented by the device-disconnected check; no click occurred. Tool setup does not establish successful new wallet actions.
