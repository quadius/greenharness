/**
 * Terminal control sequences: CSI (colors, cursor moves), OSC (titles, hyperlinks) and
 * single-character escapes. Removing them makes line counts and fingerprints reflect
 * visible text only.
 */
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/**
 * Remove terminal control sequences from text.
 * @param {string} text - raw terminal output.
 * @returns {string} the same text without control sequences.
 */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, '')
}
