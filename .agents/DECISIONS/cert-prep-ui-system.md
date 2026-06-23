# Cert Prep UI System Decisions

## PrimeNG Version

Use PrimeNG 21 because the workspace is already on Angular 21 and the current PrimeNG package advertises Angular 21 peer dependencies.

## Tailwind Version

Use Tailwind CSS 4 with `@tailwindcss/postcss`; Angular's official Tailwind guide documents the PostCSS plugin path and CSS import setup.

## PrimeNG and Tailwind Integration

Use `tailwindcss-primeui` through CSS imports. PrimeNG documents the CSS package as the Tailwind v4 integration path and recommends PrimeNG's CSS layer before Tailwind utilities.

## Component Shape

Keep the existing standalone components and signal stores. Use PrimeNG imports per component instead of centralizing everything in the root app.
