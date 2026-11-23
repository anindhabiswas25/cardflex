// Player avatar: one of the six Card Flex characters (public/avatars/1-6.webp),
// picked by `index` (a hash of the wallet), so each player keeps the same
// character every time they sit down.
export const AVATAR_COUNT = 6;

export function Avatar({ name, index, size = 64 }: { name: string; index: number; size?: number }) {
  const n = (Math.abs(index) % AVATAR_COUNT) + 1;
  return (
    <img
      src={`/avatars/${n}.webp`}
      alt={name}
      width={size}
      height={size}
      className="block rounded-full object-cover"
      style={{ width: size, height: size, boxShadow: "inset 0 0 0 2px rgba(255,214,102,.35)" }}
      draggable={false}
    />
  );
}

/**
 * Characters for everyone at one table. Each wallet prefers its own character
 * (hash of the address); if someone earlier in seat order already has it, it
 * takes the next free one, so no two players at a table look the same.
 */
export function avatarIndexes(wallets: (string | null | undefined)[], hash: (w: string) => number): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const w of wallets) {
    if (!w || out.has(w)) continue;
    let n = Math.abs(hash(w)) % AVATAR_COUNT;
    for (let k = 0; k < AVATAR_COUNT && used.has(n); k++) n = (n + 1) % AVATAR_COUNT;
    used.add(n);
    out.set(w, n);
  }
  return out;
}
