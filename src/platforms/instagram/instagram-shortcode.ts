const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Convert Instagram's URL shortcode to the stable numeric media primary key. */
export function shortcodeToMediaId(shortcode: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) {
    throw new Error('Instagram shortcode contains unsupported characters');
  }

  let value = 0n;
  for (const character of shortcode) {
    const digit = SHORTCODE_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Instagram shortcode contains unsupported characters');
    value = value * 64n + BigInt(digit);
  }
  return value.toString();
}
