// Reading and writing text files without losing their line endings. A workspace collects files
// from everywhere — another editor, a script, a checkout that converts endings — so text that
// mixes Windows and Unix endings has to read as the lines it plainly is, and come back the way
// it arrived.

/** Whether these bytes start with a UTF-8 byte order mark. */
export function hasBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * Text with every kind of line ending turned into a plain newline, and the ending the file mostly
 * used so it can be written back the same way. A single Windows ending in an otherwise Unix file
 * must not turn the whole file into one line.
 */
export function readText(raw: string): { text: string; eol: string } {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const breaks = (raw.match(/\r\n?|\n/g) ?? []).length;
  return { text: raw.replace(/\r\n?/g, '\n'), eol: crlf > 0 && crlf * 2 >= breaks ? '\r\n' : '\n' };
}

/** Text written back the way the file had it. */
export function withEol(text: string, eol: string): string {
  return eol === '\r\n' ? text.replace(/\r\n?|\n/g, '\r\n') : text;
}
