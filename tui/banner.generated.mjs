// Hand-crafted 24x12 sleepy sloth icon — replaces the chafa-generated
// placeholder. Source image (docs/assets/sleepy-sloth-source.png) is a
// circle silhouette with no internal detail, so chafa --symbols=braille
// renders an oval-of-dots at this resolution. A hand drawing reads as
// a creature; the rasterised conversion did not.
//
// All rows are exactly 24 East-Asian-Width cells. Render width matches
// the splash gutter (GUTTER_WIDTH = 24 in tui/splash.mjs). Don't change
// row widths without updating tests/phaseC-build-splash.test.mjs (width
// strict-equals 24, height <= 12).
export const banner = {
  rows: [
    "      ╭──╮    ╭──╮      ",
    "     ╭╯  ╰────╯  ╰╮     ",
    "    │   ─    ─   │      ",
    "    │             │     ",
    "    │     ‿‿‿     │     ",
    "     ╰╮         ╭╯      ",
    "      ╰─┬─────┬─╯       ",
    "        │     │         ",
    "       ╱│  z  │╲        ",
    "      ╱ │   z │ ╲       ",
    "     ✦  ╰─────╯  ✦      ",
    "       lazyclaw         "
  ],
  width: 24,
  height: 12,
  fg: "#FFB347"
};
