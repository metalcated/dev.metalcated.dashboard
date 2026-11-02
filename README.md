# Web Dashboard for Homey

A Homey app that shows your native Homey dashboards inside Homey's app view or in a browser on your home network. Supported widget edits save back to the same Homey dashboards used by iOS and Android.

The desktop companion adds **Dashboards** to the main navigation of your local Homey web app and opens the dashboard in the full content area. It keeps Homey's sidebar, theme and normal navigation. The companion is a separate browser extension: Homey's published app SDK does not offer a main-sidebar registration hook. The app's **Configure** view remains available for initial authorization and screen approvals.

The app requests `homey:manager:api` access and brokers only supported dashboard operations. The built-in app credential stays on the backend. Some Homey firmware, including the tested self-hosted 13.5.3 server, does not grant native dashboard scopes to that credential. Those installations need a dedicated scoped dashboard key once; setup can create and save it directly on Homey after the owner approves the requested access. New displays still receive revocable broker connections, not that key.

The dashboard is static files in `assets/web/`, which Homey serves at `/app/dev.schweiger.dashboard/assets/web/index.html`.
`app.js` works out that address for the settings page. `lib/dashboard-access.js` provides automatic connection, constrained API access and live updates. Existing manual API keys and previously approved browsers continue to work as an advanced compatibility path.

## Using it

1. Install/update the app and approve its Homey access. If the firmware restricts native dashboards, authorize the dedicated dashboard key during setup. A key created under Homey's system API Keys also needs to be saved in this app; creating it alone does not connect the dashboard.
2. Install the desktop companion for your local Homey web address, then choose **Dashboards** in Homey's main navigation. The first browser connection shows a six-digit approval code. Approve its matching code in **Apps → Web Dashboard → Configure → Connection & screens**; the browser then keeps its own limited connection in IndexedDB.
3. Additional browsers and wall displays use that same one-time code approval. Reapproval is required after revocation or the connection's thirty-day expiration. No backend key is copied to a new display.

### Desktop companion

Build the companion for the exact local Homey origin and Homey ID:

```sh
node scripts/build-companion.cjs --origin http://YOUR_HOMEY_IP:4859 --homey-id YOUR_HOMEY_ID
```

The output is a fresh `companion/package` directory, ready for Chrome or Edge's **Load unpacked** control. The builder refuses to replace an existing output folder; use `--out FRESH_DIRECTORY` for another build. Extension installation requires the user's approval.

Firefox and Zen use the same Firefox package, built from the identical companion scripts and styles:

```sh
node scripts/build-companion.cjs --browser firefox --origin http://YOUR_HOMEY_IP:4859 --homey-id YOUR_HOMEY_ID --out companion/package-firefox
```

The Firefox build requires Firefox/Gecko 140 or newer and adds its stable add-on ID and declaration that the companion itself collects no data. It does not request additional permissions or include a Homey API key. Zen supports Firefox extensions; see [Zen's extension documentation](https://docs.zen-browser.app/user-manual/extensions). The builder also accepts `zen`, `chrome`, and `edge` as browser names; Chrome and Edge produce the same Chromium build. Omitting `--browser` preserves the Chromium default.

For a temporary Firefox/Zen test, open `about:debugging`, choose **This Firefox** (or its Zen equivalent), then **Load Temporary Add-on** and select the generated `manifest.json`. This installation lasts until the browser restarts. Permanent Firefox Release/Beta installation requires a Mozilla-signed package; [unlisted signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) allows private self-distribution without a public store listing. The builder creates unsigned files only. Creating a ZIP or changing its extension to `.xpi` does not sign it, and the build does not change browser security settings or submit anything to Mozilla.

Each browser profile or Firefox/Zen container uses its own Homey dashboard connection. On the first visit, approve that browser's six-digit code in the existing app connection screen. The backend dashboard key stays on Homey and does not need to be created or pasted again. Opening a dashboard loads the normal Homey renderer and its network requests; the companion itself reads no authentication or household data.

The content script runs only on the configured local Homey's web route and checks the exact origin, port and Homey ID again before adding UI. It reads no Homey login tokens, cookies, storage, private application state or intercepted requests. It has no background service, network interception or unrestricted site permissions. The existing renderer performs its own normal pairing and keeps its limited connection in IndexedDB.

The **Dashboards** navigation item opens the full-width workspace; **Connection** returns to the app's setup page, and **Open separately** opens the normal standalone view. Native navigation and browser history changes close the workspace. Hidden workspaces pause event polling and live camera streams while preserving an in-progress browser approval. The companion targets the local Homey web app; Homey's cloud web app and the native iOS/Android apps are separate interfaces. Shared layouts remain the same native Homey dashboards used on mobile.

Companion 1.0.2 fixes Homey's greeting, cards and header drawing over the workspace, including the narrow strip of the secondary sidebar beside the Homey logo. The covered native content is temporarily inactive and the secondary sidebar is hidden without changing its layout while Dashboards is open; the main navigation remains available. Closing the workspace restores the native controls and sidebar. After updating an unpacked companion's files, reload that extension in the browser's extensions manager and refresh the Homey tab. This companion update does not require reinstalling the Homey app or approving the browser again.

The embedded connection stays in memory. A separate approved screen stores an opaque, revocable dashboard connection in IndexedDB; the owner's Homey credential is never sent to that screen. Native screen identities are also stored in IndexedDB, separately for each Homey. Layouts remain stored in Homey, so mobile and web edits use the same dashboard objects.

Homey's web app restricts its settings frames to an opaque origin. The workspace supports this through a private message channel tied to the exact dashboard frame and a fresh per-visit challenge. Only its two constrained dashboard broker routes pass through Homey's signed-in app SDK. The broker credential stays in the settings view; the rendered dashboard receives a connection marker and no API credential. Reloading closes the old channel and ignores its late replies.

`scripts/authorize-dashboard.cjs` prepares the one-time owner-authorized key setup through an already authenticated Homey API client. It requires explicit approval, the intended Homey identity and app version, refuses to replace an existing configuration, and requests only the widget and dashboard scopes. It does not request the unrestricted `homey` scope. The key is validated through the app's protected connection endpoint and saved in Homey's settings database without printing it. This helper does not sign in, grant itself access, or run during normal app startup.

When Homey's app settings are opened from a local Homey address, the workspace reuses that working address, including its protocol and port. This also supports self-hosted servers on networks where Homey's generated secure hostname cannot be resolved.

**Reload** reconnects the embedded view, **Expand** fills the screen when supported, and **Open separately** opens the standalone view. Hidden embedded views pause their update polling and live camera streams. The advanced manual-key form remains under **Connection & screens → Advanced connection settings**.

**Use an API key** on the pairing screen is the optional legacy path for a deliberately supplied personal key. New connections are stored in IndexedDB; existing saved configurations are read and migrated without deleting their original record.

Pick the dashboard by tapping its name at the top (as in the app), with a dashboard shortcut widget, or with `?dashboard=<name or id>` in the address. Each browser remembers its choice.


**Create a dashboard**: choose **+** beside the desktop **Dashboards** heading, or **New dashboard** in a narrow view. Enter its name and start blank or copy an existing layout. The dashboard is saved to Homey, appears in the sidebar, and opens in Edit mode. **Add column** creates another native column; each column has **Add widget**. The searchable picker includes the built-in widgets this renderer supports and non-deprecated widgets from installed apps. Configure the draft, then choose **Add widget** to save it. Closing or cancelling before saving adds nothing. Shared native layouts are the same ones used by the Homey iOS and Android apps; no extension update or second API key is needed when the existing connection has dashboard editing permission.

Copying reads the latest layout, preserves widget settings, and assigns independent column and widget IDs. Dashboard shortcuts keep their existing targets. Note text, app-widget saved content, and web-only size overrides live separately from the native layout and start fresh; the creation modal explains this before copying. Native Compact/Large choices and web-frame height fields remain part of the copied widget settings. New notes can have their color set here, while note text is still written in the Homey mobile app.

Creation failures retain the draft. If Homey's response is lost, the app checks the new layout's unique identity before showing success. An unconfirmed result offers **Check creation**, with its name and source fixed until resolved, rather than automatically posting a duplicate. Widget and column additions use the existing queued read/modify/write path so unrelated edits made on mobile are retained. New cameras start with autoplay off; selecting a camera and its registered source, plus **Auto start stream**, uses the existing native fields.

**Arrange and lock the layout**: in **Edit**, drag a widget's move handle to another position or column. A blue insertion line shows the snapped destination, including empty columns. Touch and pen use the same handle. For a keyboard, focus a move handle, press **Space** or **Enter**, use the arrow keys, then press **Space/Enter** to save or **Escape** to cancel. The existing arrow-menu moves remain available. **Done** hides the edit controls and locks movement and resizing. Positions remain native ordered columns, shared with iOS and Android; this is not a separate free-position canvas.

**Resize**: drag the lower-right corner in Edit mode. Width stays within its column and dimensions snap to the size grid, so cards do not overlap. A resize handle also supports **Space/Enter**, arrow keys, and **Escape**. Corner sizes are web display preferences saved in Homey's settings database and shared across browsers; native mobile apps keep their normal sizes. **Edit Widget → Web size → Reset web size → Save** restores the automatic size. Speaker and Timeline **Widget size** (Compact/Large), and a web frame's **Height in Homey**, use the existing native widget fields and are shared with the mobile apps. Native size choices and web display overrides can both be used; resetting a web override reveals the native size again.

**Remove columns**: each column has **Remove** in Edit mode. The modal reads the current layout before confirmation. Empty columns can be removed; populated columns require a destination for their widgets and **Move widgets and remove column**. Widget IDs, settings and stored content are retained. At least one column stays in the dashboard. If another client adds or removes widgets while confirmation is open, the save stops and asks for a fresh confirmation. No column operation silently deletes its widgets.

Layout moves and column changes preserve unchanged widget sections instead of remounting them. Size changes apply styles in place, including realtime updates from another browser. The web size map is separate from native layouts, accepts only bounded numeric dimensions for widgets currently on a dashboard, and checks the backend credential's actual effective dashboard-edit permission before each save. Revoked connections and app shutdown cancel late writes. Save failures never automatically replay a native move or settings write.


Live camera widgets respect each native widget's Autoplay setting. Otherwise, **Play live video** starts its stream. The preview comes from the camera integration's saved image; Eufy can supply a placeholder until it has a real snapshot. Opening live video does not itself replace that saved preview. A connection that sends no video for one minute stops and offers a manual retry. Duplicate visibility notifications keep the current connection, and hiding or removing a widget cancels its pending connection work. Returning after an event-subscription gap reloads the current Homey dashboard definitions.

Camera offers alone have a 45-second backend startup window, with matching 50-second parent and 55-second child bridge deadlines. Other backend requests retain their 15-second limit and the bridge retains its normal limits. These deadlines do not override camera-side availability, privacy settings, source limits, or failures to deliver media; the one-minute first-video deadline remains the final bound.

**Kiosk mode** (for a wall tablet): in the dashboard's **Settings**, choose a dashboard and turn on *Always show this dashboard*. That browser then shows only that dashboard: tapping its name no longer switches, and the Settings button is gone. It keeps the screen on, and after two minutes without a touch it closes open controls and returns to that dashboard. To change it, press and hold the dashboard name: the tablet shows a code, and approving it in the app's settings in the Homey app opens Settings on the tablet. That approval hands out nothing, and after two minutes without a touch the tablet locks again. `?kiosk&dashboard=<name>` does the same for one address without storing it.

**Fit to screen width**: by default the columns keep their width and scroll sideways. Turn on *Fit to screen width* in the dashboard's **Settings** and that browser shrinks the whole dashboard until every column fits instead (it never enlarges it). `?fit` does the same for one address without storing it.

**Screens**: every browser showing the dashboard is a screen with a name, so flow cards can aim at one ("Hallway tablet"). You name a browser when you approve it (the field starts as e.g. *Safari on iPad*). The app's settings in the Homey app list all screens to rename or forget them, and the dashboard's **Settings** shows its own name. Automatic connections retain their approved screen id in IndexedDB, and **Forget** revokes their connection until another approval. Older manual-key connections retain the upstream screen-id behavior. Browsers paired before screens existed, or set up with a typed key, show up under their browser name.

**Flow cards**: put one widget or dashboard in front of everyone, or of one screen, e.g. the front-door camera on the hallway tablet when the doorbell rings. Each card's first choice is the screen: *All screens* or a named one.

- *Highlight a widget* (action): pick the screen, a dashboard, then one of its widgets, *large* or *full screen*, and optionally the seconds after which it closes. That screen (or every open one) shows it over whatever it is showing; large zooms the widget up on a card, full screen fills the window (a camera or web frame edge to edge, other widgets zoomed to fit). A screen showing that dashboard lifts its own widget, so it keeps what it was doing (a page opened in a web frame, an app widget's state); other screens show a copy. A new highlight replaces what those screens showed.
- *Close the widget highlight on …* (action), *A widget highlight is open on …* (condition; *Any screen* or one), and *The widget highlight was closed* (trigger, with the widget, its dashboard, the screen it was aimed at and who closed it: `screen`, `flow` or `timer`; not when a new highlight replaces it).
- *Show a dashboard* (action): switches that screen (or every open one) to that dashboard; behind a highlight, it shows once the highlight closes. A kiosk tablet counts it as a touch and goes back to its own dashboard after two minutes alone.

Closing a highlight on one screen (✕, Esc or a tap beside it) closes it on every screen showing it. Kiosk tablets keep it open when left alone. It is kept in memory, so an app restart closes it. Only dashboards served by the app show highlights.

**Edit mode**: **Edit** (next to Settings; not in kiosk mode) puts the dashboard in edit mode, as in the Homey app. Each widget gets a menu (•••) to move it up, down or to the next column, edit it or remove it (a second tap confirms). Moves show straight away and are saved one after the other; a failed save puts back what Homey has. Only the widgets that changed are drawn again, and moved ones keep their state where the browser can move them as they are (`moveBefore`). *Edit Widget* opens its settings, laid out like the app's: Show Title and the title, and for app widgets their devices, the settings their app declares (text, textarea, number, dropdown, checkbox, autocomplete) and how the widget runs here (see Security). Built-in widgets that show a chosen set pick it the same way (`BUILT_IN` in `js/sheets/widget-settings.js`): Devices, Batteries, Light, Lights, Speaker, Thermostat and Energy pick devices; Flows, Moods, Variables and Dashboards their own. A note picks its colour, and a line chart its Insights log (by zone, device or Homey's own sources), its time span (stored as `scale` and `resolution`) and Force Dark Mode (`darkMode`). A Timeline picks its categories under *Show only…* (Homey's notification owners; those switched off are stored as `excluded`), and the board leaves them out. A live camera also exposes **Auto start stream** in Settings, using the same saved playback choice as the mobile app. The Homey app defines the built-in widgets' settings itself, and these follow what it stores; camera source selection, zones, sensors, zone controls, and web frames are also available here. A note's text and a light's custom name are still changed in the mobile app. New widgets are added from each column in Edit mode. Editing needs a key with `homey.dashboard` (not `homey.dashboard.readonly`); without it, Edit says so.

On an iPad, *Share → Add to Home Screen* opens the dashboard without Safari's address bar. The home-screen app has its own storage, so it pairs once more.

## Developing

Plain ES modules, no build step, no dependencies. Serve the dashboard folder over HTTP (browsers don't load modules from `file://`):

```sh
npm run serve          # python3 -m http.server 8766 --directory assets/web
```

Served from anywhere but the Homey, the page asks for the Homey address too (`https://<ip-with-dashes>.homey.homeylocal.com`), or reads it from a `config.json` next to `index.html`: `{ "homeyUrl": "…", "token": "…" }`. Served by the app, it uses its own origin and ignores `config.json`.

```sh
homey app validate --level publish
homey app install      # or `homey app run` while developing
homey app publish
```

## Pairing

Routes in `api.js` (`/api/app/dev.schweiger.dashboard/…`):

| Route | Who | |
| --- | --- | --- |
| `POST /pairing` | public | a browser asks for a code (`purpose`: `pair`, or `unlock` for a kiosk tablet's settings); returns `{ id, code, expiresAt }` |
| `GET /pairing/:id` | public | the browser polls with its secret `id`: `waiting`, `declined`, `expired`, or once `{ status: 'approved', token }` (no token for `unlock`) |
| `GET /pairings`, `POST /pairings/:id/approve`, `POST /pairings/:id/decline` | settings page | waiting browsers; changes are also sent as the realtime event `pairings` |
| `GET /api-key`, `PUT /api-key` | settings page | key status; `PUT` validates and stores the key (an empty key removes it) |
| `POST /screen-hello` | public | a dashboard says which screen it is: `{ token, id, name }`; acts only if Homey accepts the token, adds an unknown screen under `name`, returns `{ name }` |
| `GET /screens`, `PUT /screens/:id`, `DELETE /screens/:id` | settings page | list, rename (`{ name }`) and forget screens; changes are also sent as the realtime event `screens`. Approving a pairing takes `{ name }` too |
| `GET /highlight?screen=<id>` | public | that screen's highlight `{ highlight: { id, target, dashboardId, widgetId, name, dashboardName, size } }` or `{ highlight: null }` (the all-screens one without a known id); changes are sent as the realtime event `highlight` with every screen's |
| `POST /highlight/close` | public | a dashboard closed a highlight: `{ token, id }`; acts only if Homey accepts the token, on every screen showing that `id` |
| `GET /widget-sizes` | authenticated app API / broker | web dimensions for existing native widgets |
| `PUT /widget-sizes/:id` | validated dashboard editor | `{ token, size: { width, height } }`, or `size: null` to reset; effective dashboard-write permission and native widget membership are rechecked |
| `GET /widget-modes` | public | how app widgets run, by widget id: `storage` or `trusted` (missing: `sandboxed`); changes are sent as the realtime event `widget-modes` |
| `PUT /widget-modes/:id` | public | `{ token, mode }`; acts only if the token has `homey.dashboard`; drops widgets no longer on a dashboard |

Waiting browsers are kept in memory for 10 minutes, at most 10 at a time; an app restart drops them and the browsers ask for a new code. New pairings require no saved API key. A new approval returns an opaque connection with `transport: "broker"`; legacy responses without that field remain supported. A rejected connection (401) returns a separate screen to pairing, while the embedded view offers reconnection through Homey's signed-in app session.

## Layout

```
app.js                  dashboard address, API key, pairing, widget highlight flow cards, widget modes
api.js                  app API routes for pairing, the key, the highlight and widget modes
.homeycompose/flow/     flow cards (app.json is generated from .homeycompose/)
settings/index.html     settings page: address, waiting browsers, screens, API key
assets/web/
  index.html            markup only
  css/                  tokens (light/dark), base layout, widgets, popups
  js/main.js            entry: connect, pick the dashboard, live updates, setup form
  js/dashboard-editor.js new-dashboard modal and blank/copy workflow
  js/column-editor.js    reviewed column removal with widget transfer
  js/layout-drag.js      pointer and keyboard native widget movement
  js/layout-resize.js    pointer and keyboard web-size preview and save
  js/widget-sizes.js     shared web size cache and style-only updates
  js/widget-catalog.js  native widget drafts for the searchable add picker
  js/pairing.js         asks the app for a code and waits for approval
  js/screen.js          this browser's lasting screen id and the name the app gives it
  js/kiosk.js           kiosk mode: fixed dashboard, screen on, idle reset, hold the name for Settings
  js/fit.js             fit to screen width: zooms the board out so all columns fit
  js/highlight.js       shows the widget a flow highlighted, large or full screen
  js/mood-orb.js        mood icons: a gradient of the colours a mood sets (the Homey web app's method)
  manifest.json, img/   Add to Home Screen
  js/render.js          renders a dashboard's columns of widgets; updates them in place after a change
  js/edit-mode.js       Edit: each widget's menu (move, edit, remove)
  js/dashboard-save.js  saves changes to a dashboard (queued, optionally shown before they're saved)
  js/widget-modes.js    how each app widget runs: sandboxed, with storage or trusted
  js/widget-storage.js  localStorage for sandboxed app widgets (loaded as srcdoc with a script in front)
  js/widgets/index.js   registry of widget types → title, data needed, mount function
  js/widgets/*.js       one module per widget type
  js/sheets/            device controls; lights / speakers / batteries / climate zone sheets; widget settings
  js/crossframe-host.js parent side of Homey's widget protocol (app widgets run in sandboxed iframes)
  js/realtime.js        socket.io live updates
  js/icons.js, js/icons/  icons (see below)
  js/…                  api client, config, data loading, devices, zones, colours, charts, DOM helpers
```

## Adding a widget type

1. Look at how the mobile app stores it: `GET /api/manager/dashboards/dashboard`.
2. Add `assets/web/js/widgets/<name>.js` exporting `mount<Name>({ widget, section, body, setTitle })`. Return a cleanup function if it subscribes to anything.
3. Register it in `assets/web/js/widgets/index.js` with the Homey collections it needs (see `DATA_SOURCES` in `data.js`). Mark it `fill: true` if it is a picture or page that should fill the screen when highlighted full screen.
4. Give it a readable name for the highlight card in `WIDGET_TYPES` in `app.js`.

## Icons and licensing

- **Device and zone icons** are loaded at runtime from the Homey's own web app (`/web/img/devices/`, `/web/img/zones/`), so the app doesn't ship them.
- **Control and sensor icons** (`assets/web/js/icons/`) are our own drawings standing in for the Homey apps' icons, which are Athom artwork not licensed for redistribution. Every stand-in is marked with a `LICENSING:` comment naming the original; search for it to see what should eventually be there. Missing icons can be requested at https://github.com/athombv/homey-vectors-public (GPL-3.0).
- Colour presets, the colour-temperature formula and the zone icon name mapping follow the Homey web app's behaviour; they're data, not artwork.

## Security

### Automatic connections in this fork

Homey's owner token stays in backend memory. The protected `/workspace/connect` route is called through Homey's signed-in settings bridge. It returns an opaque dashboard session, not the owner token. Public `/workspace/request` and `/workspace/events` routes require that session and reject APIs outside the dashboard allowlist. Session hashes, screen associations and expiration times are stored in Homey's settings database. Native sessions last one day, approved separate screens thirty days, with at most 64 retained sessions. **Forget** revokes broker connections for that screen. Multiple native tabs may share a screen identity without signing each other out.

The broker permits a narrowly validated native dashboard creation request and blocks app administration, arbitrary API endpoints, dashboard deletion and changes to another user's presence. Widget API calls are limited to registered widget instances present on native dashboards. Native dashboard changes retain the existing queued read/modify/write path. A refused owner credential can be refreshed once; timeouts and other ambiguous failures never automatically repeat a control command.

Embedded authentication accepts only the immediate parent frame and its exact referrer origin; the parent sends a restricted connection only to the expected dashboard frame. Credentials are kept out of URLs. Live relay subscriptions and buffered events are bounded; reconnects and app restarts resynchronize from Homey.

### Legacy manual-key connections

The following upstream notes describe existing manual-key connections and app-widget compatibility modes. They do not describe the automatic broker connection above.

Served by the app, the dashboard shares Homey's origin with Homey's own web app and every app's widgets and settings pages. App widgets therefore run in iframes sandboxed without `allow-same-origin`, so they can't read the stored API key. Use a key with only the permissions listed in the settings page.

Every Homey address serves every app's files, so an app's own page opened on the dashboard's address would run with its storage. That's why popups a widget opens stay sandboxed (no `allow-popups-to-escape-sandbox`), and `Homey.popup()` only opens `http(s)` pages away from Homey's addresses: `homeylocal.com` isn't a public suffix, so browsers treat all its addresses as one site. For the same reason widgets can't get a real origin of their own: with `allow-same-origin`, a widget could load its app's page from the dashboard's address in a nested frame.

A sandboxed widget has no storage, which breaks widgets that cache or remember things in `localStorage`. In a widget's settings, *Runs* offers two other ways, chosen per widget and kept by the app for every browser:

- **Sandboxed with storage**: the page fetches the widget's HTML and loads it as `srcdoc`, still sandboxed, with a `<base>` for its folder and a script in front that gives it a `localStorage` this page keeps per app (256 KB each; an app's widgets share it, changes reach its other open frames) and a `sessionStorage` for the frame's lifetime. URLs built from `location.href` resolve against the widget's real address, so `Homey.getWidgetInstanceId()` works, but code that reads `location.search` or `location.pathname` itself sees `about:srcdoc`.
- **Trusted**: no sandbox, as in the Homey app. The widget can access the page's stored connection. For a legacy manual-key connection, this includes the personal key; a new broker connection contains a revocable dashboard session instead. Only use this mode for widgets you trust.

Legacy manual-key connections can store the same personal key on several displays. Clearing one display's storage removes its local copy; revoking that personal key invalidates every display using it. Never give a legacy display key `homey.app.control`: it could change this app's settings and approve other displays. New pairing approvals instead return a separate opaque broker connection for each approved screen. **Forget** in the app's screen list revokes that screen's broker connections, and the dedicated backend key remains on Homey. A pairing code can only be collected by the browser holding its random polling ID after approval.

## Licence

GPL-3.0, see `LICENSE`.
