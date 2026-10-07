// Python numeric semantics the extractor depends on (so the JS output matches the reference build).

/** int(round(x)): round half to even */
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** round(x, nd): correctly rounded decimal, exact ties to even (CPython uses the exact binary value) */
export function pyRoundN(x, nd) {
  if (!isFinite(x)) return x;
  const exact = Math.abs(x).toFixed(100);              // exact decimal expansion of the double
  const dot = exact.indexOf("."), tail = exact.slice(dot + 1 + nd);
  let r = Number(x.toFixed(nd));
  if (/^50*$/.test(tail)) {                            // exact tie: toFixed went away from zero; Python goes to even
    const digits = exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + nd);
    const last = Number(digits[digits.length - 1]);
    if (last % 2 === 0) r = (x < 0 ? -1 : 1) * Number(exact.slice(0, dot + 1 + nd));
  }
  return r;
}

/** sum() over floats: CPython 3.12+ uses Neumaier compensated summation */
export function pySum(arr) {
  let s = 0, c = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i], t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x;
    else c += (x - t) + s;
    s = t;
  }
  return c && isFinite(c) ? s + c : s;
}

/** Python floor division for ints */
export const idiv = (a, b) => Math.floor(a / b);

/** numeric lexicographic compare for tuples (arrays) */
export function cmpTuple(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export const truthy = (d) => !!(d && d.length);
