---
version: "alpha"
name: "macOS Vibrancy / Translucency"
description: "macOS Vibrancy / Translucency visual system, translated from the Claude Artisan catalog for use in digital products. Sidebar/toolbar materials that sample and blur the desktop; Vibrant text/icons that adapt to backdrop"
colors:
  primary: "#007aff"
  background: "#dfe6ee"
  surface: "#dfe6ee"
  text: "#1d1d1f"
  accent: "#ff9f0a"
  on-primary: "#000000"
  on-surface: "#000000"
  on-accent: "#000000"
typography:
  h1:
    fontFamily: "-apple-system, 'SF Pro Display', system-ui, sans-serif"
    fontSize: "4rem"
    fontWeight: "700"
    lineHeight: "1.05"
  body-md:
    fontFamily: "-apple-system, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: "400"
    lineHeight: "1.6"
  label-caps:
    fontFamily: "-apple-system, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: "600"
    letterSpacing: "0.06em"
rounded:
  sm: "8px"
  md: "10px"
  lg: "14px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: "16px"
  button-secondary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "16px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "24px"
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    padding: "16px"
---
## Overview

macOS Vibrancy / Translucency visual system, translated from the Claude Artisan catalog for use in digital products. Sidebar/toolbar materials that sample and blur the desktop; Vibrant text/icons that adapt to backdrop

- **Category:** glass
- **Era:** 2014–present
- **Origin:** Apple OS X Yosemite (2014).
- **Reference:** macOS Finder sidebar; Notification Center.
- **Structural base:** superfície material com conteúdo em camadas

**Defining traits:**
- Sidebar/toolbar materials that sample and blur the desktop
- Vibrant text/icons that adapt to backdrop
- Subtle luminance blending
- System-level material tiers (menu, sidebar, HUD)

## Colors

- **bg** — #dfe6ee
- **surface** — rgba(255,255,255,0.55)
- **surface-strong** — rgba(255,255,255,0.78)
- **border** — rgba(0,0,0,0.08)
- **text** — #1d1d1f
- **text-muted** — rgba(29,29,31,0.6)
- **primary** — #007aff
- **accent** — #ff9f0a
- **scrim** — rgba(255,255,255,0.4)

## Typography

- Display: -apple-system, 'SF Pro Display', system-ui, sans-serif
- Body: -apple-system, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif
- Mono: 'SF Mono', ui-monospace, monospace

## Layout

- superfície material com conteúdo em camadas
- Use a responsive grid and preserve content hierarchy.
- Collapse columns below 768px without horizontal overflow.

## Elevation & Depth

- Sidebar/toolbar materials that sample and blur the desktop; Vibrant text/icons that adapt to backdrop; Subtle luminance blending; System-level material tiers (menu, sidebar, HUD); sombras e elevação; transparência e blur

## Shapes

- Radius scale: 8px, 10px, 14px.

## Components

- Buttons keep visible focus and predictable hover/pressed states.
- Cards use the surface and radius scale from the tokens.
- Forms expose persistent labels, textual errors, and keyboard focus.

## Do's and Don'ts

- Do: follow the tokens and the structural composition.
- Do: maintain WCAG AA contrast and `prefers-reduced-motion`.
- Avoid: using the style as decoration without functional hierarchy.

<!-- Source: https://designmd.app/library/macos-vibrancy · designmd.app -->
