# Your Next Thing BIMI logo

Asset: `public/bimi/ynt.svg`

Proposed public URL: `https://mail.yournextthing.org.uk/bimi/ynt.svg`

## Conversion

Converted the supplied `ynt-logo-mark.svg` to SVG Tiny Portable/Secure:

- Declares `version="1.2"` and `baseProfile="tiny-ps"`.
- Uses a 320 × 320 square canvas and the title `Your Next Thing`.
- Preserves the source SVG's #1f3901 green, rounded square, and -3° rotation.
- Converts YNT to fixed vector paths using Barlow Condensed ExtraBold (weight
  800), the first font specified by the original SVG, at its original text size
  and spacing. This fixes the intended font instead of relying on a viewer's
  fallback fonts; the supplied PNG may show a different fallback rendering.
- Adds an opaque white background for consistent display.
- Contains no live text, embedded raster, external references, scripts, CSS,
  animation, or font dependency. The original files were not modified.

Font source: [Google Fonts Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlowcondensed)
(SIL Open Font License). The font file is not distributed with the asset.

## Validation (2026-09-15)

- Passed the BIMI Group's [current SVG Tiny-PS RNC schema](https://bimigroup.org/resources/SVG_PS-latest.rnc.txt)
  using lxml Relax NG validation after RNC conversion.
- 2,187 bytes, below the BIMI Group's recommended 32 KB maximum.
- SHA-256: `9c804787ac4bc074255be66e6d392922b42263a5a6c3c4b1019275c3a00580b8`.
- Rendered to PNG and visually checked.
- Anonymous GET to the real local Next.js route returned 200,
  `Content-Type: image/svg+xml`, and the exact validated file bytes. No cookies,
  Authorization header, redirect, or authentication challenge was used/returned.

`public/_headers` specifies the SVG MIME type, `nosniff`, and one-hour public
caching for the Cloudflare static asset route. No application auth or routing
code changes are required.

## Pre-deployment check

At preparation time, the existing production HTTPS URL was checked with TLS
verification and returned 404, HTML, and no redirect.
The new asset's live HTTPS response can only be verified after deployment.

After deployment, verify an anonymous HTTPS GET returns 200 with
`image/svg+xml`, no redirect, and the SHA-256 above before using the URL in a BIMI
DNS record. DNS and certificate configuration are outside this asset change.
