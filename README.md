# WhatsApp Calendar Agent

A single-user Windows 11 desktop application that watches your own WhatsApp conversations for appointment-shaped
messages, drafts a reply and a calendar event, and **waits for you to click**. Nothing is ever sent and nothing is ever
written to your calendar without an approval record created by that click.

It is an Electron + TypeScript app that runs entirely on your PC. It talks to WhatsApp through a bundled bridge binary
(your own linked device), to Google Calendar through a bundled MCP server that uses **your** Google Cloud project, and to
a language model that is either downloaded and run locally (llama.cpp + Gemma) or, if you choose and configure it,
Anthropic Claude or Google Gemini.

> **Legal / account risk.** Using an unofficial WhatsApp client violates WhatsApp's terms of service, whatever the
> volume. Your account can be banned. This project is for personal use on your own account, with your eyes open.

---

## 1. What it does, in order

1. The bridge keeps your WhatsApp linked-device session alive and writes incoming messages to a local database.
2. The app reads that database (read-only) and applies a **deterministic filter** first: direct chats only, no groups,
   no broadcasts, no status updates, and only chats you have written to yourself.
3. What survives goes to the model, which extracts a proposed time, a proposed event and, when a reply is wanted, a
   proposed reply text.
4. Date and time arithmetic is **not** done by the model. "Thursday at 5" is resolved by plain TypeScript against your
   clock and your time zone, and anything ambiguous is shown with a badge.
5. You see a card: the original message, the draft reply, the draft event. You can edit both.
6. Only when you click Approve does the app send the reply and create the event.

## 2. Privacy: what leaves your PC

| Data | Where it goes | When |
|---|---|---|
| Your WhatsApp messages | Nowhere, unless you pick a cloud model. With the **Local** provider the text never leaves the PC. | - |
| Message text sent to a cloud model | Anthropic or Google, only if you chose Claude or Gemini, only after you accepted that provider's consent screen in the app, and only the minimised slice of the conversation the app needs. | per analysed message |
| Your calendar | The AI reads your calendar's busy/free times through the calendar connector; events are created by the app only after you click. Event titles of other events are never shown to the model - only "busy from X to Y". | per analysed message / per approval |
| Your Google credentials | They stay on this PC, in your user profile. The app uses your own Google Cloud project; no server of ours is involved. | - |
| Model downloads | An HTTPS download from Hugging Face, pinned by SHA-256. No telemetry. | when you pick a local model |
| Anything else | There is no analytics, no crash reporting, no update check and no account. | never |

Message snapshots and drafts are kept for 30 days and then deleted.

## 3. Known, accepted weaknesses

These are real and deliberate. Read them before you install.

- **Other software running as you can read everything.** The WhatsApp session database, the message database and your
  Google tokens sit in your user profile. Windows protects them from other *users*, not from a program you run yourself.
- **`runAsNode` is enabled.** The bundled calendar server needs the app's own binary to be able to run as Node. This is
  a genuine hardening concession, forced by that design.
- **Nothing is code-signed.** Three unsigned executables (the app, the bridge, the model server) mean SmartScreen and
  Defender friction on first run, and no way for you to verify the publisher.
- **No auto-update.** A new version is a manual download and install.
- **The bridge is an opaque prebuilt binary.** Its Go source is vendored for reference, but nobody on this project can
  rebuild it. When WhatsApp changes its protocol it will eventually fail with "client outdated" and stay broken until
  someone ships a new one.
- **Google setup is genuinely fiddly.** You need your own Google Cloud project and OAuth client, and the bundled server
  asks for the full calendar scope even though the app only reads busy/free and creates events.
- **Create-only calendar.** The app never edits or deletes an existing event.
- **One open item per chat.** Two parallel topics in the same conversation collapse into one card.
- **Local models are slow on a CPU-only laptop** - roughly 20-60 seconds per actionable burst of messages.
- **Capability separation is module-level, not process-level.** The rules that stop the model reaching the "send" and
  "create event" paths are enforced inside one process, by code structure and tests, not by the operating system.
- **The last line of defence is you.** Approving without reading defeats every safeguard above.

The full list of facts that have not yet been verified on real hardware, and the checks that close each one, is in
`docs/ARCHITECTURE.md` section 19.

---

## 4. Building it

Requires Node 24+ and Windows 11 x64. The project path may contain spaces - always quote it.

```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH
Set-Location -LiteralPath "C:\dev\whatsapp agent"
npm ci
```

### One-time staging of the bundled third-party pieces

The order of these four commands does not matter: each one owns the files it writes.

```powershell
node scripts/import-bridge.mjs             # copies ONE exe by exact path and verifies its SHA-256 (manual item M1)
npm run stage:mcp                          # npm ci --omit=dev --ignore-scripts for the calendar MCP server
node scripts/fetch-llama.mjs               # downloads the pinned llama.cpp zip, verifies sha256, unpacks the allow-list
node scripts/smoke-packaged.notices.mjs    # regenerates resources/licenses/THIRD_PARTY_NOTICES.txt from the repo
```

`fetch-llama.mjs` writes only `resources/licenses/llama.cpp-MIT.txt`; the notices generator reads that file and owns
`THIRD_PARTY_NOTICES.txt`. (Until the packaging repair, `fetch-llama.mjs` overwrote the notices file, so running it
after the generator truncated the release notices to two sections - the correct artefact depended on the run order.)
The generator needs no network.

To ship the Microsoft Visual C++ runtime app-locally (so the local model works on a PC without the redistributable),
point `VC_REDIST_CRT_DIR` at a `Microsoft.VC143.CRT` folder, run `node scripts/fetch-llama.mjs --pin-crt` once, review
the recorded hashes, then re-run the two commands above. Leaving it unset is supported: the app then detects the missing
runtime and shows a specific error with a link to Microsoft's download page.

None of these scripts ever executes a downloaded binary.

### Checks

```powershell
npm run verify     # lint, format, typecheck, unit + integration + security tests, E2E, packaging smoke, npm audit
```

`npm run test:smoke` alone builds an unpacked package and runs the six packaging checks. It exits `0` on success and
`3` ("SMOKE INCOMPLETE") when it was run with `--allow-missing-bridge`, which is not a release result.

### Producing the installer

```powershell
npx electron-builder --win --x64
```

This is a **manual step, performed by you** - see M9 below. It writes
`dist\WhatsAppCalendarAgent-Setup-<version>.exe`, a one-click per-user NSIS installer of roughly 200-240 MB.

---

## 5. Manual checklist (M1-M16)

Everything below needs a real WhatsApp account, a real Google account, real model weights or a real installation.
**No automated agent may perform any of these steps.** They are for you, at your keyboard. Record each outcome in
`ops/PROGRESS.md` - never with a phone number, a token or real message text.

| # | What you do | Pass criteria |
|---|---|---|
| **M1** | Run `node scripts/import-bridge.mjs` (copies the one bridge exe and verifies its SHA-256). | Hash OK; nothing else was copied. |
| **M2** | First supervised launch of the dev app with the real bridge. | Health reaches `NEEDS_PAIRING`; no extra DLL prompt; a bridge of your own already running on port 8080 is undisturbed and still healthy. |
| **M3** | Pair a real WhatsApp account by scanning the QR code (needs one free linked-device slot). | Shows `Connected`; the dashboard does **not** flood with history. Inspect the app-owned `messages.db` timestamp format once and compare it with `parseBridgeTs`. |
| **M4** | From a second phone, send "coffee Thursday at 5?" in Hebrew and in English. Approve a reply to that test contact; answer another one from the phone instead. | Card appears in under 60 s; exactly one message is delivered; the "answered elsewhere" path works; an `@lid` chat, if you have one, is copy-only. |
| **M5** | Run the Google wizard with your own Cloud project, real OAuth consent, and pick a calendar. **Expect a Windows Defender Firewall dialog** for the app on first sign-in - the bundled server's OAuth callback listens on all interfaces. | Tokens are written under `userData\google`; both **Cancel** and **Allow** on the firewall dialog leave the app usable; a free/busy read succeeds. |
| **M6** | Approve one real event. Then kill the app between approve and done, restart, and click it again. | Exactly one event exists; no invitation e-mails were sent; the event carries the app's tag; the duplicate is impossible. Capture the real response texts (scrubbed) to correct the test fake. |
| **M7** | Download a real model (automatic tier). Pause and resume it; kill the app mid-download and resume. | SHA-256 verified; completed bytes are not downloaded again; note which CDN host you were redirected to. |
| **M8** | Real `llama-server.exe` smoke: self-test on GPU / iGPU / CPU, with a Hebrew path in `userData`. Capture `--list-devices` output as a fixture, then run `npm run test:golden:live -- --provider local` for each shipped tier. | Golden-set thresholds met; tokens/second recorded. |
| **M9** | Build the NSIS installer **from the path that contains a space**, install it, and start the **packaged** app's GUI for the first time. Note SmartScreen / Defender behaviour. Then install an upgrade while the app and its children are running. | The app starts; the upgrade kills only our own process tree; the bridge and model server of *other* software are untouched. |
| **M10** | Log off or shut down Windows with the window hidden, then log back in. | No orphaned `whatsapp-bridge.exe` or `llama-server.exe` of ours survives; a reaper line appears in the log; a bridge of your own is untouched. |
| **M11** | Enter a real Claude key and a real Gemini key **in the app** (never in a file or an environment variable). Read the consent texts. Run `test:golden:live` for each. Try a zero-credit key if you have one. | Fixtures re-captured and scrubbed; error mapping is correct. |
| **M12** | Hebrew review: read `he.json` in context using the RTL screenshots, plus the tray menu, tooltip, toast and native dialogs in Hebrew on Windows 11. Check phone numbers and Latin names inside Hebrew text. | Your sign-off. |
| **M13** | Clean-machine run (Windows Sandbox or a second PC with no Node and no VC++ runtime): install and go through onboarding to Ready with the `tiny` tier. Then remove the CRT DLLs from `resources\llama` and start the local model. | No missing-DLL errors in the normal case; in the stripped case **exactly** `LLM_VCREDIST_MISSING` with the "Install Microsoft runtime" action - never a generic local-model failure. |
| **M14** | The "client outdated" rehearsal is deliberately **not** performed against real WhatsApp. It is covered only by the test fake. | Nothing to do. |
| **M15** | Send `llama-server.exe` a `/v1/chat/completions` request with `response_format: {type:'json_schema'}` and **no** `json_schema.schema`, and record that the output is unconstrained (a 400 or free text). Then send the correct form. | Both results recorded in `ops/PROGRESS.md` - this proves the wire-shape fix matters. |
| **M16** | Send an approved reply to an `@lid` test contact (release gate). Record the share of `@lid` chats you see in the app-owned `messages.db`. | Result and share recorded. If delivery works, open the ticket to make those chats sendable. |

---

## 6. Third-party components

The installer ships a WhatsApp bridge (MIT), llama.cpp `b10964` for Windows/Vulkan (MIT), the LLVM OpenMP runtime
(Apache-2.0 with LLVM exception), the Google Calendar MCP server (MIT), Electron, and about 142 pure-JavaScript npm
packages. There is no native addon anywhere in the shipped tree. The complete notices, including every licence text
that must travel with the software, are in `resources/licenses/THIRD_PARTY_NOTICES.txt` and are installed alongside the
application. Model weights are **not** shipped; they are downloaded by you, on request, under their own terms.
