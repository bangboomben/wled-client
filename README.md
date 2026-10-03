<div align="center">

<img src="resources/icon.png" width="96" alt="WLED Client icon" />

# WLED Client

**A fast Windows desktop app for all your [WLED](https://kno.wled.ge) lights — in one window, with a tray quick-access.**

[![Latest release](https://img.shields.io/github/v/release/bangboomben/wled-client?label=download&color=f5a524)](https://github.com/bangboomben/wled-client/releases/latest)
[![License: EUPL-1.2](https://img.shields.io/badge/license-EUPL--1.2-blue)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4)

![WLED Client demo: effects, palettes, brightness, color wheel, sidebar quick controls, presets](docs/demo.gif)

</div>

The WLED web interface is great — for one device at a time. **WLED Client** keeps every controller on your
network in one place: switch between them with a click, dim any of them right from the sidebar, and reach
power and brightness of all lights from the Windows tray without opening anything.

> **Unofficial.** This is a community project and not affiliated with the WLED project.
> It talks to your controllers through WLED's public JSON API — nothing on the devices is modified.

## Features

- **All your devices, one window** — sidebar with power toggle and brightness slider per device, switch with a
  click or `Ctrl+1…9`
- **Tray quick-access** — click the tray icon: on/off and brightness for every light, plus *all off*
- **Groups** — put lights into groups and switch or dim them together from the sidebar, the tray quick-access and
  the tray menu; brightness scales proportionally, so dimmer lights stay dimmer. Click a group to see what each of
  its lights is doing and to set a color, effect, palette or look for all of them at once
- **Copy a look** — send the effect, palette, colors and effect sliders of one light to other lights or whole groups
  in a few clicks; brightness and on/off stay as they are, effects and palettes are matched by name
- **Everything the web UI does**
  - **Colors** — color wheel, three color slots, hex/RGB, white channel (RGBW), color temperature (CCT), quick colors
  - **Effects** — all effects with search and filters (palette, 1D, 2D, audio); sliders and options are labeled
    exactly as the firmware describes them for each effect
  - **Palettes** — every palette with a gradient preview, including custom palettes
  - **Segments** — create, delete, start/stop, grouping, spacing, offset, reverse, mirror, freeze, per-segment brightness
  - **Presets & playlists** — apply, save current state, raw API commands, quick-load labels, boot preset,
    playlists with per-entry duration and transition, repeat, end preset, shuffle
  - **Nightlight**, **UDP sync**, **live LED preview**, **device info**, reboot
- **Device settings pages** (Wi-Fi, LED setup, sync, time, usermods, OTA update …) and the device's own web UI
  open in their own window
- **Network discovery** — finds WLED devices that announce themselves (mDNS and the WLED node list), in networks
  of any size; devices on other subnets (VPN, second site) can be added by IP or found with an optional
  address-range scan
- **Instant feedback** — live state over WebSocket; dragging a slider only ever sends the latest value
- **Gentle on weak Wi-Fi** — one request per device at a time, small requests first, missing data retried later
- **Light and dark theme**, follows Windows by default
- **English and German** interface, follows your Windows language
- **Updates itself** — new versions download in the background and install on the next restart

| | |
|---|---|
| ![Effects with palette previews](docs/screenshots/effects.png) | ![Colors](docs/screenshots/colors.png) |
| ![Presets and playlists](docs/screenshots/presets.png) | ![Segments](docs/screenshots/segments.png) |
| ![Light theme](docs/screenshots/light.png) | |

<p align="center"><img src="docs/screenshots/tray.png" width="344" alt="Tray quick-access" /><br/><em>Tray quick-access: on/off and brightness for every light</em></p>

> **Languages:** English and German — picked automatically from your Windows language, switchable in the app settings.

## Download & install

1. Download **`WLED-Client-Setup-x.y.z.exe`** from the [latest release](https://github.com/bangboomben/wled-client/releases/latest).
2. Run it. It installs per user — no admin rights needed — and adds Start menu and desktop shortcuts.
3. The installer is not code-signed yet, so Windows SmartScreen may warn about an unknown publisher:
   click **More info → Run anyway**. Free code signing through the SignPath Foundation is in progress —
   see the [code signing policy](CODE_SIGNING.md).

On first start the app looks for WLED devices that announce themselves on your network (mDNS) and adds them.
Devices on other subnets: **+ Device** → enter the IP, or open *Scan an address range* (e.g. `192.168.2.0/24`).

Windows 11 puts new tray icons into the overflow menu (^) — drag the icon onto the taskbar to keep the
quick-access one click away. Closing the window keeps the app running in the tray (configurable);
quit via right-click on the tray icon.

**Updates:** from version 1.2.0 on, the app checks GitHub for new releases, downloads them in the background
and installs them when you restart (or right away via *Restart now*). Can be turned off in the app settings.
Coming from 1.0 or 1.1? Install 1.2.0 once by hand — after that it's automatic.

Settings and the device list live in `%APPDATA%\WLED Client\`.

## Requirements

- Windows 10 or 11 (x64)
- WLED controllers reachable from your PC — developed and tested against **WLED 16.0.1**. Recent 0.14/0.15
  releases speak the same JSON API and should work, but are untested so far — feedback welcome.

## Links for Stream Deck and automations

Turn on *Allow links from other programs* in the app settings. Then any program that can open a link controls your
lights with `wled-client://<target>/<action>[/<value>]`. If the app isn't running, the link starts it in the tray.

| Target | Meaning |
|---|---|
| `device/<name>` | one light, named as in the app |
| `group/<name>` | a group |
| `all` | all lights |

| Action | Meaning |
|---|---|
| `on`, `off`, `toggle` | switch (a group toggles like its switch in the app) |
| `brightness/50` | brightness in percent, 1 to 100 (`off` switches off, 0 is not accepted); groups dim proportionally |
| `brightness/+10`, `brightness/-10` | 10 points brighter or darker |
| `preset/<name or number>` | apply a preset (single lights only) |
| `color/ff8000` | solid color |
| `effect/<name>`, `palette/<name>` | effect or palette by name |
| `look-from/<light>` | copy the look of another light |

A brightness link also switches a light on; in a group, lights that are off stay off while any other one is lit.

Names are case-insensitive. Write spaces as `%20`, and `/`, `#` and `%` inside a name as `%2F`, `%23` and `%25`.
Examples: `wled-client://group/Living%20room/toggle`, `wled-client://device/Desk/brightness/+10`,
`wled-client://all/color/ffb060`.

- **Stream Deck:** action *System › Open*, paste the link.
- **AutoHotkey v2:** `Run "wled-client://all/off"`
- **Task Scheduler:** program `explorer.exe`, argument `"wled-client://all/off"`

Errors (unknown name, light not reachable) show up as a Windows notification. Links only change what you could change
in the app — never the device configuration.

## FAQ

**Does it change anything on my devices?** Only what you do in the app — the same JSON API commands the web UI
sends. It never writes device configuration on its own.

**Why doesn't it find a device?** Discovery relies on what WLED announces by itself: mDNS (`_wled._tcp`, on by
default) and the list of other WLED nodes each device keeps (`/json/nodes`). Neither crosses routers or VPNs — add
such devices by IP, or scan their address range from the *Add device* dialog. Controllers with very weak Wi-Fi may
need a second search.

**Why not just use Home Assistant?** Use both — they talk to the same API. Home Assistant's WLED integration is
the right place for automations, but it exposes only speed and intensity per effect. WLED Client shows every slider
and option the firmware defines for the selected effect, with the firmware's own labels, plus segments, playlists
and the live preview, without building a dashboard.

**Live preview stopped?** WLED streams the live preview to one client at a time — opening "Peek" in the web UI
takes it over.

**Does it need internet or a cloud account?** No. Everything is local HTTP and WebSocket to your controllers.

## Alternatives

- **The official WLED app** for [Android](https://play.google.com/store/apps/details?id=ca.cgagnier.wlednativeandroid)
  and [iOS](https://apps.apple.com/us/app/wled-official-app/id6446207239) — also runs on Apple-silicon Macs.
- **[WLED-Desktop](https://github.com/Moustachauve/WLED-Desktop)** — desktop app by the author of the official
  app, in the [Microsoft Store](https://apps.microsoft.com/detail/9ntbcf05x6pg).
- **[Home Assistant](https://www.home-assistant.io/integrations/wled/)** — WLED integration for automations and
  dashboards.
- The device's own web UI — WLED Client opens it in a window, too.

## Development

Requires Node.js ≥ 22 (Python with Pillow only to regenerate icons).

```bash
npm install
npm run dev          # Vite with hot reload + Electron (restarts on main-process changes)
npm run typecheck
npm test             # unit tests (Vitest); npm run test:watch while developing
npm run i18n         # every UI text needs an English translation (src/shared/i18n-en.ts)
npm run build        # dist-electron/ (main, preload) + dist/renderer/ (UI)
npm run dist         # build + Windows installer into release/
```

### Releases

Push a version tag (`git tag v1.3.0 && git push --tags`). The [Build & Release workflow](.github/workflows/release.yml)
builds and tests the installer on GitHub, has it signed through SignPath once that is set up (each signing request
needs a manual approval), refreshes `latest.yml` and the blockmap for the signed file
(`scripts/update-feed.mjs`) and publishes the release. Release notes come from `release-notes/<tag>.md` if it exists.
Pull requests run the same build and tests without publishing.

### Architecture

```
src/main/        main process: windows, tray, IPC, device connections, discovery
  device.ts      one connection per device (WebSocket + HTTP, command queue, retries)
  devices.ts     device list (add, remove, reorder, persist)
  discovery.ts   device search: mDNS + WLED node list; address-range scan only on request
  mdns.ts        minimal mDNS client (queries from a free port, no listening socket)
src/preload/     narrow bridge window.wled (contextIsolation, sandbox)
src/renderer/    React UI — main window and tray flyout (flyout.html)
src/shared/      types and the JSON-API patch logic (merge.ts)
```

- The main process keeps **one** WebSocket per device for live state and commands (HTTP as fallback) and
  pushes updates to both windows via IPC.
- Commands with the same key replace each other in the queue — dragging a slider only sends the latest value.
- The UI applies every change immediately using the same patch semantics as the firmware (`src/shared/merge.ts`).
- Discovery asks for `_wled._tcp` via mDNS and follows each device's node list (`/json/nodes`). It never walks
  through addresses on its own: the address-range scan runs only when you start it, uses the adapter's real
  netmask and stops at a /22.

### Testing without real lights

`scripts/mock-wled.mjs` simulates WLED devices (HTTP API, WebSocket, presets, live preview) from recorded
WLED 16.0.1 API responses in `mock/fixtures/`.

```bash
npm run mock                     # two simulated devices on 127.0.0.1:8181 and :8182
npm run build && npm run e2e     # end-to-end test (Playwright) against simulated devices
node scripts/e2e.mjs --exe "release/win-unpacked/WLED Client.exe"   # same, against the packaged app
npm run screenshots              # regenerates docs/screenshots/
npm run demo                     # records docs/demo.gif + docs/demo.mp4 (needs ffmpeg)
```

## Kurz auf Deutsch

WLED Client ist eine Windows-App für alle WLED-Controller im Netz: Geräte per Klick oder `Strg+1…9` wechseln,
Helligkeit und Ein/Aus direkt in der Seitenleiste und im Tray-Schnellzugriff, dazu alles, was die
WLED-Weboberfläche kann (Farben, Effekte, Paletten, Segmente, Presets, Playlists, Nachtlicht, Sync,
Live-Vorschau). Mehrere Lampen lassen sich zu Gruppen zusammenfassen und gemeinsam schalten
und dimmen. Ein Klick auf eine Gruppe zeigt ihre Lampen und setzt Farbe, Effekt oder Palette für alle auf einmal.
Den Look einer Lampe (Effekt, Palette, Farben) überträgt „Übertragen“ auf andere Lampen oder Gruppen.
Stream Deck und Automationen steuern die Lampen über Links wie `wled-client://group/Wohnzimmer/toggle`
(in den App-Einstellungen einschalten).
Installer unter [Releases](https://github.com/bangboomben/wled-client/releases/latest),
Installation ohne Administratorrechte. Die Oberfläche spricht Deutsch und Englisch, je nach Windows-Sprache.

## Feedback

Bug reports and ideas are welcome in the [discussions](https://github.com/bangboomben/wled-client/discussions)
and [issues](https://github.com/bangboomben/wled-client/issues).

## License & credits

Licensed under the [EUPL-1.2](LICENSE), the same license as WLED. [Privacy policy](PRIVACY.md) ·
[Code signing policy](CODE_SIGNING.md)

[WLED](https://github.com/wled/WLED) is created by Aircoookie and maintained by the WLED community — this client
just talks to it. The test fixtures in `mock/fixtures/` are recorded API responses of WLED (effect names,
palettes and effect metadata come from the WLED firmware, EUPL-1.2).
