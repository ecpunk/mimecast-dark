# Mimecast Dark

A Firefox extension that forces dark mode on the Mimecast admin console.

## What it does

Mimecast's admin console does not offer a dark theme. This extension applies
one by inverting the page colors, so white backgrounds become dark and dark
text becomes light, without touching Mimecast's own styling.

- Images, video, canvas, SVG, iframes, and background images are re-inverted
  so photos and logos still render with their normal colors instead of
  looking like photo negatives.
- Mimecast's colored top bars (brand-colored headers) are detected and
  neutralized to a plain light gray before the invert is applied, so they end
  up a normal dark gray instead of clashing with the rest of the inverted
  page.
- A toolbar button lets you turn dark mode on or off per site (per hostname),
  in case you want it on some Mimecast regions and not others. It is on by
  default the first time you visit a given hostname.

## Install

Download `dist/mimecast-dark-1.0.2-signed.xpi` and open it with Firefox
(File > Open File, or drag it into a Firefox window). It is signed through
Mozilla's AMO unlisted channel, so it installs permanently and survives
browser restarts. It is not listed in the addons.mozilla.org store.

For development, the unsigned build can be loaded temporarily instead:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click "Load Temporary Add-on...".
3. Select `manifest.json` from this repository, or download
   `dist/mimecast-dark-1.0.2.xpi` and select that instead.

Temporary add-ons unload when Firefox closes.

## How it works

The extension injects a content script into every `*.mimecast.com` page at
`document_start`. The script adds a `<style>` element with two pieces:

1. A single rule on `html` using CSS `filter: invert()` combined with a hue
   rotation, which flips the whole page to a dark theme in one step.
2. A counter-rule on media elements (images, video, canvas, SVG, iframes, and
   anything with a background image) that inverts them a second time, which
   cancels out the page-level invert and leaves them looking normal.

Because inverting a saturated color does not produce its complementary color
the way you would want for a colored header bar, the script also scans the
page for header-shaped elements with a strong background color and marks
them so they get a plain light gray background instead. Those elements come
out as a normal dark gray after the global invert, rather than an odd
inverted hue. The set of bars found on a page is cached per hostname in
`browser.storage.local`, so on repeat visits the dark styling for those bars
is applied immediately from the cached selectors instead of waiting for a
live scan, which avoids a flash of the original colors on load.

The toolbar icon toggles the dark styling on or off for the current
hostname. The setting is stored in `browser.storage.local` and applies
immediately without a page reload.

## Files

- `manifest.json` - extension manifest (Manifest V2, Firefox).
- `dark.js` - content script: builds and injects the dark stylesheet, scans
  for colored bars, and reacts to the toggle.
- `background.js` - background script: handles the toolbar click and keeps
  the toolbar badge in sync with the current tab.
- `icon.svg` - toolbar icon.
- `dist/mimecast-dark-1.0.2.xpi` - packaged build of the extension.
- `dist/mimecast-dark-1.0.2-signed.xpi` - the same build, signed by Mozilla for
  permanent install.

## License

MIT. See `LICENSE`.
