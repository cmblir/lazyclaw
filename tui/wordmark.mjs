// POMPOS wordmark — 11 rows x 84 cols, shared between chat splash and launcher.
// Gradient palette maps each row to one of four warm-gold shades; top rows are
// brightest, bottom rows shadow-dark.
//
// Generated with `figlet -f isometric1 POMPOS` rather than transcribed. The
// pre-rename POMPOS wordmark was operator-supplied with no generator recorded,
// and no figlet font installed here reproduced its first row — so its lettering
// could not be carried over to a new name. isometric1 is the closest installed
// match to that 3D block look.
//
// The string-output renderer (renderSplashToString) emits the raw rows; the
// ink/launcher colour path picks PALETTE[GRADIENT[row]] when ANSI is available.

export const PALETTE = [
  '#FFD580',  // 0  top — warm white-gold
  '#FFB347',  // 1  highlight
  '#E08020',  // 2  midtone — amber
  '#A05010',  // 3  bottom — burnt shadow
];

// One entry per row; splash.mjs indexes this by row, so it must match height.
export const GRADIENT = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3];

export const wordmark = {
  rows: [
    "      ___           ___           ___           ___           ___           ___     ",
    "     /\\  \\         /\\  \\         /\\__\\         /\\  \\         /\\  \\         /\\  \\    ",
    "    /::\\  \\       /::\\  \\       /::|  |       /::\\  \\       /::\\  \\       /::\\  \\   ",
    "   /:/\\:\\  \\     /:/\\:\\  \\     /:|:|  |      /:/\\:\\  \\     /:/\\:\\  \\     /:/\\ \\  \\  ",
    "  /::\\~\\:\\  \\   /:/  \\:\\  \\   /:/|:|__|__   /::\\~\\:\\  \\   /:/  \\:\\  \\   _\\:\\~\\ \\  \\ ",
    " /:/\\:\\ \\:\\__\\ /:/__/ \\:\\__\\ /:/ |::::\\__\\ /:/\\:\\ \\:\\__\\ /:/__/ \\:\\__\\ /\\ \\:\\ \\ \\__\\",
    " \\/__\\:\\/:/  / \\:\\  \\ /:/  / \\/__/~~/:/  / \\/__\\:\\/:/  / \\:\\  \\ /:/  / \\:\\ \\:\\ \\/__/",
    "      \\::/  /   \\:\\  /:/  /        /:/  /       \\::/  /   \\:\\  /:/  /   \\:\\ \\:\\__\\  ",
    "       \\/__/     \\:\\/:/  /        /:/  /         \\/__/     \\:\\/:/  /     \\:\\/:/  /  ",
    "                  \\::/  /        /:/  /                     \\::/  /       \\::/  /   ",
    "                   \\/__/         \\/__/                       \\/__/         \\/__/    ",
  ],
  width: 84,
  height: 11,
  // Kept on the object as well as exported standalone: consumers read
  // wordmark.gradient / .palette / .fg directly, and dropping them turned into a
  // TypeError on undefined[0] three modules away.
  fg: "#FFB347",
  gradient: GRADIENT,
  palette: PALETTE,
};
