# store-shots

Turns raw app screenshots into App Store marketing screenshots: a caption on top, the real screen
in the middle and, when the screen alone says little (an audio game, VoiceOver), a bubble quoting
what the app says. One JSON config per app renders every language and device size at once, in the
layout `fastlane deliver` expects: `<output_dir>/<locale>/<n>_<device>.png`.

Requirements: Google Chrome (headless rendering) and Python 3. No Python package needed.

## 1. Raw screenshots

Copy `AppStoreScreenshotsUITests.swift` into your UI test target (it uses `AITaskerCapture.swift`,
which the Runner already adds) and list your key screens. It writes `<language>_<name>.png`, plus the
VoiceOver reading order in `<language>_<name>.txt`, to `APPSTORE_SCREENSHOTS_DIR`.

Run it once per simulator, each into its own folder:

```bash
xcrun simctl status_bar <sim> override --time 9:41 --batteryState discharging --batteryLevel 100
TEST_RUNNER_APPSTORE_SCREENSHOTS_DIR=fastlane/screenshots_src/iphone xcodebuild test \
  -workspace App.xcworkspace -scheme App -destination "id=<sim>" \
  -only-testing:AppUITests/AppStoreScreenshotsUITests -collect-test-diagnostics never
```

Sizes App Store Connect asks for: iPhone 6.9" (1320 × 2868) and, if the app runs on iPad, iPad 13"
(2064 × 2752). Apple scales them down for smaller devices.

## 2. Compose

```bash
tools/store-shots/store-shots fastlane/store_shots.json
```

Config (see `example.json`, the Escape From Blindness listing):

- `output_dir`: where the composed screenshots go, relative to the JSON (`screenshots` for fastlane).
- `raw_dirs`: raw screenshot folder per size (`iphone_69`, `ipad_13`). A missing folder is skipped.
- `locales`: per App Store locale, `raw_prefix` (prefix of the raw files) and `speaker` (bubble title).
- `shots[]`: `raw` (screen name), then per locale `title` (`*word*` in the accent color, `\n` for a
  line break), `subtitle`, `bubble` (the app's exact words, starting with "…" when shortened) and
  `bubble_top` (bubble position, as a fraction of the screen height).
- `theme` (optional): `bg1`, `bg2`, `accent`, `text`, `bubble`, `bubble_text`. One Week Apps colors
  by default.

Look at every image before uploading: a typo or a layout bug on a screenshot is fixed in the app,
not in the image.

## 3. Upload

```bash
fastlane deliver --skip_binary_upload --overwrite_screenshots --skip_metadata
```

## En français

`store-shots` compose les captures App Store à partir des captures brutes de l'app : une phrase
d'accroche, le vrai écran et une bulle qui cite ce que dit l'app. Copier le modèle de test, le lancer
une fois par simulateur, puis `tools/store-shots/store-shots fastlane/store_shots.json`.
