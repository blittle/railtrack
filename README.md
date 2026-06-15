# RailTrack

Turn a folder of large still photos into a **4K (or vertical) timelapse**, windowing a crop
into each frame for a smooth pan — with optional **star-trail stacking**, denoise, and fast
low-res previews. Built with [Tauri 2](https://tauri.app) + React.

RailTrack is a thin, visual front end over [ffmpeg](https://ffmpeg.org): it builds the
filtergraph for you and runs it, streaming progress.

## Features

- **Windowed pan** — crop a 16:9 (or portrait) window out of much larger frames and slide it
  across the sequence; sub-pixel-smooth panning on previews (and optionally on export).
- **Star trails** — lighten/`lagfun` stacking with adjustable persistence (permanent or comet),
  plus a configurable **start** (trails begin partway through) and **end** (trails retract or
  dissolve back to a normal timelapse).
- **Vertical / portrait output** — one checkbox swaps the resolution and flips the preview.
- **Denoise** — `hqdn3d` or `fftdnoiz`, applied before stacking so noise isn't baked into trails.
- **Fast previews** — a one-time low-res proxy cache makes whole-timelapse previews render in
  seconds; a live scrubber shows the windowed framing at any point.
- **Output** — H.264 / H.265 / ProRes, configurable resolution, fps, and quality.

## Installing

Download the installer for your platform from the [Releases](../../releases) page.
macOS and Windows builds include ffmpeg — nothing else to install.

The builds are **not code-signed**, so the OS will warn the first time you open them:

**macOS** (`.dmg`): drag RailTrack to Applications, then:
- Right-click the app → **Open** → **Open** in the dialog, **or**
- If that's blocked, open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
- Still stuck? In Terminal: `xattr -dr com.apple.quarantine /Applications/RailTrack.app`
- Apple's guide: <https://support.apple.com/guide/mac-help/mh40616>

**Windows** (`.exe`/`.msi`): if SmartScreen appears, click **More info → Run anyway**.

## Requirements

- **ffmpeg** (with `libx264`/`libx265`). RailTrack auto-detects ffmpeg/ffprobe on your `PATH`
  (and common install locations); you can also set explicit paths in **Settings**.
  - **macOS & Windows release builds bundle ffmpeg** — nothing to install.
  - **Linux** is build-your-own: install ffmpeg from your package manager (e.g. `apt install ffmpeg`).
  - For development on any platform: `brew install ffmpeg` (macOS) or your package manager.

## Development

```sh
npm install
npm run tauri dev      # launch the app (requires the Rust toolchain)
npm test               # run the engine unit tests (vitest)
npm run tauri build    # produce a production bundle/installer
```

The pure, framework-free engine lives in `src/engine/` (project model → ffmpeg args) and is
unit-tested independently of the UI.

## License

[GPL-3.0-or-later](./LICENSE). Released binaries bundle an ffmpeg build (also GPL).
