---
name: CamSync Manual Attachment
colors:
  surface: "#ffffff"
  context: "#eff6ff"
  text: "#102343"
  muted: "#52647a"
  primary: "#087f8c"
  border: "#d6dee8"
  warning: "#b45309"
  success: "#087443"
typography:
  heading:
    fontFamily: "Segoe UI, sans-serif"
    fontSize: 18px
    fontWeight: 700
  body:
    fontFamily: "Segoe UI, sans-serif"
    fontSize: 14px
    lineHeight: 1.5
spacing:
  sm: 8px
  md: 16px
  lg: 24px
rounded:
  sm: 6px
  md: 12px
components:
  pairing-dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
---
## Overview
A compact clinical pairing dialog following the approved white, navy and teal demo. Preserve the existing capture/editor/preview layout. This release transfers files for manual HIS Upload.
## Colors
Teal identifies pairing actions. Amber means waiting; green means connected. Every state has readable text.
## Typography
Use the host platform sans-serif. Patient names wrap; time values use tabular numerals.
## Layout
Header, filename context, static QR, connection state, guidance, then expiry and refresh action. Preserve existing image review controls.
## Elevation & Depth
Restrained shadow; no glowing frame or backdrop blur.
## Shapes
Moderate corner radii. QR modules remain square with a generous white quiet zone.
## Components
QR has no decorative overlay or animation. Countdown uses actual session expiry. Refresh tears down the old session and keeps the exact selected file input; disable refresh while a transfer is running.
## Do's and Don'ts
Keep PHI out of screenshots and design examples. FILE_READY means file attached; show “Đã chuyển file tới máy tính” and tell users to press Upload manually. Respect reduced motion. Retain explicit close and Escape controls.
