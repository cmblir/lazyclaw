// Braille splash art — a hooded figure, 48x35 cells.
//
// Converted from operator-supplied artwork that was ALREADY a dot-matrix render:
// amber dots on a dark ground, with the FIGURE as negative space. Two things
// about that source drive the conversion, and getting either wrong destroys it.
//
// 1. Its dot pitch is ~9.5px, so at 1024x1536 it carries roughly 107x161 dots —
//    slightly MORE than this 96x140 dot grid. The detail is there to keep.
// 2. A BOX (area-average) downsample to 96x140 averages ~10.7px blocks, which
//    already spans one dot pitch. That integrates dot density into grey on its
//    own, so NO blur is wanted. A first attempt blurred at radius 16 — the pitch
//    measurement had silently failed and fallen back to a guess of 20 — and
//    smeared across several dots, flattening the hood, face and folds into one
//    amorphous mass with five blank rows at the bottom.
//
// So: no blur, BOX to 96x140, one threshold at the midpoint of the figure and
// background density (p5=37, p95=69 -> 54). Full source height, no crop; the
// composition fills all 35 rows once the fine detail survives.
//
// Chosen by distinct-glyph count, which is a usable proxy for preserved line
// work: a smear collapses to a handful of glyph types, real drawing needs many.
// Blur 0 gives 109 distinct glyphs, blur 4 gives 97, blur 16 gave a blob.
//
// Polarity matches what the terminal already did: dots ON for the dotted
// background, OFF for the figure. Inverted, the field fills with U+28FF and the
// silhouette disappears into it.
//
// The previous header called this art a "dense braille sloth". It was not — the
// committed pixels decoded to a hooded figure. Noting it because the wrong label
// survived several sessions and misled a reader of this file.
export const banner = {
  rows: [
    "⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⣽⣧⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣼⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣼⡿⣿⣿⠿⠟⠛⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋⠀⠀⠀⠀⠀⠈⠛⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣽⣿⣿⣿⣿⣿⣿⡿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠛⢛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⠾⠛⠋⠛⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⢿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⢀⣴⠟⠁⠀⠀⠀⠀⢢⡀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡯",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⣹⠟⠁⠀⠀⠀⠀⠀⠀⠈⢷⡱⡘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠜⠁⠀⠀⠀⠀⠀⠀⠀⠀⢀⠈⢻⡈⢾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⡰⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢦⠀⢳⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠞⠀⠐⠀⠀⠀⠀⠀⠀⡄⠀⠀⠀⠀⠈⢷⡄⢷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠃⠀⠀⠀⠀⠀⢀⠔⠁⠀⣴⠀⠀⠀⠀⠀⠀⠼⣷⠀⠀⠀⠀⢆⠐⠙⢾⡿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⢿⡿⣿⣿⣿⣿⢿⠿⡿⠁⠀⠀⠀⠀⠀⡠⠃⠀⠀⠀⠹⠀⠀⠀⠀⠀⢰⠗⠀⠀⠀⡄⠀⠈⢦⡀⠈⣷⢹⣿⡿⡿⢿⣿⣿⣿⡿⡿",
    "⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⢀⠜⠁⠀⠀⠀⠀⠀⠀⠀⠀⣠⣤⠏⠀⠀⠀⠀⠹⣄⢳⣄⠁⠂⡿⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⣿⣿⣻⣿⣿⡦⠀⠀⠀⢏⠀⠀⠀⠀⠀⠀⢦⠀⠀⠀⠀⠀⠀⠀⠀⠀⢢⣄⠌⢳⣌⡻⣶⠁⢨⢻⣿⣿⣿⣿⣿⣿⣿⣿",
    "⢿⡟⣿⣿⣿⣿⣻⣿⠃⠀⠀⠀⠀⠈⠓⠦⢤⣀⡀⠀⠈⠇⠀⠀⠀⠀⠀⢀⡆⡀⠀⢹⣮⡆⢢⠙⢧⡑⠺⢨⠿⣧⣿⣿⣿⣿⣻⣿",
    "⣿⣿⣿⣿⣿⡿⠛⠉⠀⠀⠀⢄⡀⠀⠀⠀⠀⠀⠉⠙⢲⣶⣦⣤⡀⠠⠔⢹⠐⣰⠃⢸⠻⣿⣼⡄⢧⠹⣆⢿⣿⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⣿⣿⠏⠀⠀⠀⠀⠀⠀⠀⠉⠲⣤⡀⠀⠀⠀⠀⠀⢀⡈⠙⠻⠳⠦⠀⡼⡱⠀⢸⠀⣿⢻⣷⣜⣇⠌⢣⡘⢿⣿⣿⣿⣿⣿⢿",
    "⣿⣿⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠷⣤⡀⠀⢀⠀⠈⠉⠁⠀⠀⢸⠃⠂⢠⠏⠀⣿⡄⢣⠻⣿⣷⣤⣈⡻⣿⣿⣿⣿⣿⣯",
    "⣿⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠛⢦⣀⠙⢷⣶⣒⠒⠀⠘⡆⣲⠃⠄⠀⣿⠻⣆⣃⠀⠈⠙⠻⣿⣿⣿⣿⣿⣿⣿",
    "⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢳⡀⠀⠀⠀⠀⠀⠀⠙⣷⣄⠉⠉⠉⠁⠀⠀⣿⠈⢠⠀⠹⣧⠘⢿⠷⣄⣀⡀⠈⢿⣿⣿⣿⣿⣿",
    "⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⡄⠀⠀⠀⠀⠀⠀⠈⢻⣧⡀⠀⠀⠀⠈⠈⡄⣼⠀⠀⢸⣇⠈⡇⢡⠀⢳⡄⠀⢻⣿⣿⣟⣟",
    "⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠻⣄⠀⠀⠀⠀⠀⠀⠀⠙⠿⣦⡀⠀⠀⠀⠈⡷⡄⠀⠜⡏⠀⢹⠀⠀⠀⠹⡄⠈⢿⣿⣿⣿",
    "⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢦⡀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣦⡀⠀⢸⠀⠹⡄⠀⠀⢀⠂⠀⢀⠀⠀⠙⠆⠈⢿⣿⣿",
    "⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⡄⠀⠀⠀⠀⠀⠀⠀⠀⠈⢷⡀⠀⠀⠀⡇⠀⠀⠎⠀⠀⠈⢦⠀⠀⠀⠀⠀⢻⣿",
    "⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⡄⠀⠀⢇⠀⠀⠃⠀⠄⠀⠀⢳⡀⠀⠀⠀⠀⢻",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢷⡄⠀⠀⠀⠀⠀⠀⠀⠀⠘⢆⠀⠀⠁⠀⠀⠀⠈⣆⠀⠀⠹⣆⠀⠀⠀⠈",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠻⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠡⡀⠀⠀⠀⠀⠀⠘⡆⠀⠀⠘⢆⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣄⠀⠀⠀⠀⠀⠀⠀⠀⠈⢄⠀⠀⠀⠀⠀⠈⡄⠀⠀⠈⣄⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠣⡀⠀⠀⠀⠀⠀⠀⠀⠀⠣⡀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢢⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢦⠀⠀⠀⠀⠀⠀⠀⠀⠐⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠱⡀⠀⠀⠀⠀⠀⠀⠀⠀⠑⡀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠱⡀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠢⡀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠑⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  ],
  width: 48,
  height: 35,
  fg: "#FFB347"
};
