# Hex for Raycast

Find a past dictation in Raycast and press **Return** to copy its final text to the clipboard. Use **⌘Return** to paste it directly into the front app. The extension uses the Hex CLI on macOS.

## Load it locally

With Hex 3.4.0, Raycast, and Node.js 24 installed, run the following.

```sh
git clone https://github.com/alvarogar4/raycast-hex.git
cd raycast-hex
npm ci
npm run dev
```

This runs `ray develop` and registers the commands under **Hex** in Raycast. You can also use Raycast’s **Import Extension** command and select this directory. The **Hex CLI Path** extension preference defaults to `/Applications/Hex.app/Contents/MacOS/hex`.

In **Raycast Settings → Extensions → Hex**, assign hotkeys to the commands you want to use globally. Suggested bindings are **⌥⇧H** for Search History, **⌃⌥D** for Toggle Dictation, and **⌃⌥V** for Paste Last. Choose bindings that are free on your Mac.

## Commands

| Command          | What it does                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search History   | Lists newest first. Typing runs Hex’s ranked fuzzy search across final and raw text. Return or ⌘C copies the final text, ⌘Return pastes it, and ⇧⌘C copies the raw transcript when available. Open in Hex shows the History pane.                                                     |
| Start Dictation  | Starts a locked dictation.                                                                                                                                                                                                                                                            |
| Stop Dictation   | Finishes a dictation and sends the recording to Hex for transcription.                                                                                                                                                                                                                |
| Toggle Dictation | Starts when idle and stops the current dictation when recording.                                                                                                                                                                                                                      |
| Cancel Dictation | Asks before discarding the active dictation.                                                                                                                                                                                                                                          |
| Paste Last       | Asks Hex to paste its last eligible dictation at the current focus.                                                                                                                                                                                                                   |
| Switch Model     | Shows the current model, installed state, download size, and languages. Select an installed model to use it. Installing asks for confirmation and also switches to the model. The list refreshes during preparation, shows failures, and offers cancellation of the active operation. |
| Language         | Shows languages for the active model. Selecting one runs `model use --language`. For a multilingual wildcard model, search by name or type a language code. Type `auto` to request automatic detection on models that support it.                                                     |
| Vocabulary       | Search terms and their sounds-like spellings. ⌘N adds a term. Return on a term adds comma-separated spellings. Removing a term and its spellings requires confirmation.                                                                                                               |
| Microphone       | Enter a device name, or use `system-default` to follow macOS. Edit the Bluetooth avoidance and release-while-idle settings independently.                                                                                                                                             |
| Status           | Shows capture state, pending jobs, selected model and language, and current meeting. ⌘R refreshes the snapshot.                                                                                                                                                                       |
| Meetings         | Search the newest 200 recorded meetings by title or app. Actions opens the Meetings pane, starts recording, or stops and transcribes a meeting. These actions are available on the empty list as well. Recording requires the Hex Meetings feature.                                   |
| Settings         | Browse every setting reported by Hex. Open an editable row to change its value. The editor supports booleans, choices, numbers, shortcuts, device names, paths, and JSON. Hex validates the value. Optional settings accept `none`.                                                   |

### History filters

Use the date dropdown for Today, Last 3 Days, Last 7 Days, or All Dates. **⇧⌘F** opens both application and date dropdowns. The application picker suggests names from the newest 200 entries and accepts a typed exact app name for older entries. Hex applies both filters before ranking and limiting. Scrolling loads another 50 matches, up to Hex’s limit of 10,000. Each row’s detail includes its application, local recording time, final text, and raw transcript.

### CLI limits and privacy

- Hex 3.4.0 has no JSON command for enumerating input microphones. Its microphone setting accepts the exact device name or the system default.
- `meetings search` returns human-readable text only. The extension searches metadata from `meetings list --json`. Full-text transcript and note search is available in the Hex CLI. The pane-opening command opens the whole pane.
- All runtime reads and controls invoke the configured executable with an argument array. History stays in memory while the view is open. The extension makes no network requests, sends no telemetry, and does not log dictation text. The two copy actions mark clipboard content as concealed. A confirmed model installation asks Hex to download the model.
- When Hex is closed, history and recorded meetings remain readable through the CLI. Controls offer **Start Hex**. After starting it, invoke the intended action again.

Checked against the installed Hex 3.4.0 CLI on November 24, 2026. [Control CLI](https://github.com/anomalyco/hex/blob/v3.4.0/docs/cli.md) · [History and meeting formats](https://github.com/anomalyco/hex/blob/v3.4.0/docs/transcript-cli.md)

## Verification

Run `npm run build`, `npm run lint`, and `npm test`. Lint runs Raycast’s ESLint rules and Prettier locally. The tests use a temporary fixture executable and synthetic text. They can run with Hex closed.

On November 24, 2026, all eight view commands rendered in Raycast through `ray develop`. Live CLI checks covered newest-first and ranked history, raw text, app and date filters, the model catalog, active language, vocabulary, all three microphone settings, status, the empty meetings list, and settings. The manifest also passed Raycast’s published JSON Schema. The separate Store author check requires a registered Raycast handle.

The write checks ran against fixtures. Coverage includes the five no-view controls, model selection and installation, a changed download during confirmation, vocabulary and settings arguments, the History and Meetings pane arguments, meeting controls, rejected commands, and starting Hex after exit 3. Populated meetings were checked with synthetic data. The interactive clipboard, live recording, model downloads, real pane navigation, and live setting changes were left out of the smoke test.

Hex accepts separate read and write commands. The editor checks the old value immediately before saving, and cancellation checks the active preparation after confirmation. The CLI provides no atomic “only if still current” option if another client acts between those commands.

## License

The extension is available under the [MIT License](LICENSE). The icon comes from Hex and carries its [upstream license](assets/LICENSE).
