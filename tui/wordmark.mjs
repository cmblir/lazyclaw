// "Larry 3D"-style LAZYCLAW wordmark — 13 rows × 120 cols, shared between
// chat splash and launcher. Gradient palette maps each row to one of four
// warm-orange shades; top rows = brightest, bottom rows = shadow-dark.
//
// The string-output renderer (renderSplashToString) emits the raw rows;
// the ink/launcher color path picks PALETTE[GRADIENT[row]] when ANSI is
// available.

export const PALETTE = [
  '#FFD580',  // 0  top — warm white-gold
  '#FFB347',  // 1  highlight (current single-tone reference)
  '#E08020',  // 2  midtone — amber
  '#A05010',  // 3  bottom — burnt shadow
];

// 13 rows; bias toward bottom for shadow depth.
export const GRADIENT = [0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3];

export const wordmark = {
  rows: [
    " ____               ____      _____        _____      _____       _____    ____               ____     _____            ",
    "|    |         ____|\\   \\    /    /|___   |\\    \\    /    /|  ___|\\    \\  |    |         ____|\\   \\   |\\    \\   _____   ",
    "|    |        /    /\\    \\  /    /|    |  | \\    \\  /    / | /    /\\    \\ |    |        /    /\\    \\  | |    | /    /|  ",
    "|    |       |    |  |    ||\\____\\|    |  |  \\____\\/    /  /|    |  |    ||    |       |    |  |    | \\/     / |    ||  ",
    "|    |  ____ |    |__|    || |   |/    |___\\ |    /    /  / |    |  |____||    |  ____ |    |__|    | /     /_  \\   \\/  ",
    "|    | |    ||    .--.    | \\|___/    /    |\\|___/    /  /  |    |   ____ |    | |    ||    .--.    ||     // \\  \\   \\  ",
    "|    | |    ||    |  |    |    /     /|    |    /    /  /   |    |  |    ||    | |    ||    |  |    ||    |/   \\ |    | ",
    "|____|/____/||____|  |____|   |_____|/____/|   /____/  /    |\\ ___\\/    /||____|/____/||____|  |____||\\ ___/\\   \\|   /| ",
    "|    |     |||    |  |    |   |     |    | |  |`    | /     | |   /____/ ||    |     |||    |  |    || |   | \\______/ | ",
    "|____|_____|/|____|  |____|   |_____|____|/   |_____|/       \\|___|    | /|____|_____|/|____|  |____| \\|___|/\\ |    | | ",
    "  \\(    )/     \\(      )/       \\(    )/         )/            \\( |____|/   \\(    )/     \\(      )/      \\(   \\|____|/  ",
    "   '    '       '      '         '    '          '              '   )/       '    '       '      '        '      )/     ",
    "                                                                    '                                            '      ",
  ],
  width: 120,
  height: 13,
  fg: "#FFB347",
  gradient: GRADIENT,
  palette: PALETTE,
};
