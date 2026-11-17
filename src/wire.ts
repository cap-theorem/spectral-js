const DURATION_UNITS_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  "μs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

const DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/y;

export function formatDuration(ms: number): string {
  if (Number.isInteger(ms) && ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${Math.round(ms)}ms`;
}

export function parseDuration(text: string): number {
  let rest = text.trim();
  let sign = 1;
  if (rest.startsWith("+") || rest.startsWith("-")) {
    if (rest.startsWith("-")) {
      sign = -1;
    }
    rest = rest.slice(1);
  }

  if (rest === "0") {
    return 0;
  }
  if (rest === "") {
    throw new RangeError(`invalid duration "${text}"`);
  }

  let total = 0;
  DURATION_PART.lastIndex = 0;
  while (DURATION_PART.lastIndex < rest.length) {
    const match = DURATION_PART.exec(rest);
    if (match === null) {
      throw new RangeError(`invalid duration "${text}"`);
    }
    const [, amount, unit] = match;
    total += Number(amount) * (DURATION_UNITS_MS[unit ?? ""] ?? Number.NaN);
  }

  return sign * total;
}
