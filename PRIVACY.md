# Privacy Policy

WLED Client has no telemetry, no analytics, no accounts and no server of its own. It never sends data to the
developer.

## Network connections

The app connects only to:

- **Your WLED devices** — the devices you add or that it finds on your network, over HTTP and WebSocket, to read
  and change their state. Device settings pages open the device's own web pages.
- **Your local network, to find devices** — the app sends a multicast DNS (mDNS) query for `_wled._tcp.local` and
  asks devices it already knows for their list of other WLED nodes (`/json/nodes`). Each device that answers gets
  one request to `/json/info`. This happens on first start and when you open *Add device*.
- **Addresses you scan** — only when you start *Scan an address range*: a request to `/json/info` on each address of
  the networks you enter.
- **GitHub** — with *Check for updates automatically* turned on (the default), the app asks
  [github.com](https://github.com/bangboomben/wled-client/releases) about new releases shortly after start and every
  six hours, and downloads a new version from there. Like any web request, this reveals your IP address to GitHub
  ([GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
  You can turn this off in *App settings*.

Links to other websites (for example from a device's settings pages) open in your default browser.

## Data on your computer

Your device list and settings are stored locally in `%APPDATA%\WLED Client\` and stay there. Uninstalling the app
does not delete them; you can remove the folder by hand.
