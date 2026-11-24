# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

[Back to the README](README.md)

## Build and install from this repository

Build the UI from this checkout. TREK's plugin SDK is still needed to validate and pack an installable archive.

From the TREK repository root, install the workspace and SDK dependencies:

```sh
npm ci
npm ci --prefix plugin-sdk
npm run build --prefix plugin-sdk
```

Then validate and pack the plugin:

```sh
npm run validate --prefix plugins/visa-manager
npm run pack --prefix plugins/visa-manager
```

This creates `plugins/visa-manager/visa-manager.zip`. In a TREK instance with `TREK_PLUGINS_ENABLED=1`, open **Admin → Plugins → Upload plugin**, upload the archive, then enable it and accept its two permissions. Open **Passports & Visas** from the navigation.

The archive includes the built client assets and server JavaScript. The host injects the SDK at runtime; it is a development dependency and is not bundled into the plugin server.

### Testing the Hong Kong and Macao setting

In TREK, open **Admin → Plugins**, find **Passports & Visas**, and choose **⋯ → Instance settings** on its row. Enable **Enable Hong Kong & Macao permit management** and save. After the plugin restarts, reopen its page; the **HK & Macao permits** and **HK & Macao crossings** tabs should appear. Disable the setting and save to hide both tabs. Existing records are preserved and should appear again when the setting is re-enabled.

For local preview, create `dev-fixtures.json` in the plugin root and use a boolean to simulate the setting:

```json
{
  "config": {
    "hong_kong_macau_enabled": true
  }
}
```

Set the value to `false` to simulate the disabled state. Restart the preview service after editing the file, then reload the entire `/preview` page. This fixture only affects local preview; it does not change the instance setting stored by TREK.

## Local preview

```sh
npm run dev --prefix plugins/visa-manager
```

Open [http://localhost:4317/preview](http://localhost:4317/preview). The command rebuilds both the repository SDK and the plugin UI before starting the preview. Development records live in `.trek-dev/` and are excluded from the archive.

After updating SDK preview code, restart the preview service and reload the entire `/preview` page. Reloading only its iframe does not update the outer confirmation handler. The preview disables response caching and detects service restarts.

To test Simplified Chinese, open the preview page's developer console in the **top** frame and run:

```js
document.getElementById('f').contentWindow.postMessage(
  { ...ctx(), locale: 'zh-CN' },
  '*'
);
```

Use `en` to restore English. A page reload or a new host context can reset the preview to English. In a full TREK instance, select Simplified Chinese in TREK's language settings instead.

For dev-link on a development instance, set `TREK_PLUGINS_DEV_LINK=1`, unpack the built archive and link that extracted directory. The archive has already expanded the `<!-- trek:ui -->` marker; the raw source HTML has not.

## Checks

Business and ownership tests use Node's built-in SQLite. Use Node **22.22.2+**, or another Node version supported by this TREK checkout.

```sh
npm test --prefix plugins/visa-manager
```

The browser check requires the repository's Playwright dependency and an installed Chromium or Google Chrome:

```sh
npm run build --prefix plugins/visa-manager
node plugins/visa-manager/test/browser-smoke.cjs
```

It copies the plugin into a temporary directory and uses a separate database. It checks language fallback and switching, forms, archived-passport links, approval and refusal outcomes, approval-to-visa conversion, independent entry/departure locations, confirmation cancellation, persistence and mobile layout.
