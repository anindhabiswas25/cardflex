// cf-admin argument parsing (pure, tested in test/args.test.ts).

/** Flags that take no value; every other `--name` takes the next word. */
export const BOOL_FLAGS = ["pause", "unpause", "strict", "dry-run", "once"];

export function parseArgs(raw: string[]) {
  // `pnpm admin -- table open X` passes a bare "--" through; it isn't an
  // option, and it must not swallow the command word after it (CF-067).
  const argv = raw.filter((a) => a !== "--");
  const takesValue = (a: string) => a.startsWith("--") && !BOOL_FLAGS.includes(a.slice(2));
  return {
    flag: (n: string) => argv.includes(`--${n}`),
    opt: (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; },
    pos: argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && takesValue(argv[i - 1]))),
  };
}
