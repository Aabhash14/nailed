/**
 * Width / height ratio from the first aspect class ("aspect-square", "aspect-[4/3] md:aspect-[16/9]" -> 1, 4/3).
 * Design review T-048 fix 32: the intrinsic size used to be 4:3 for every slot. Unknown -> 4:3.
 */
export function ratioFromClass(ratio: string): number {
  if (/(^|\s)aspect-square(\s|$)/.test(ratio)) return 1;
  const m = /(?:^|\s)aspect-\[(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\]/.exec(ratio);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return w / h;
  }
  return 4 / 3;
}
