// Line-based diff with bounded memory for large source files.
export function lineDiff(before, after) {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) || [],
    b = after.match(/[^\n]*\n|[^\n]+$/g) || [];
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const rows = [];
  let oldLine = 1,
    newLine = 1;
  const add = (type, text) =>
    rows.push({
      type,
      text,
      oldLine: type === "added" ? null : oldLine++,
      newLine: type === "removed" ? null : newLine++,
    });
  for (let i = 0; i < prefix; i++) add("same", a[i]);
  const x = a.slice(prefix, a.length - suffix),
    y = b.slice(prefix, b.length - suffix);
  if ((x.length + 1) * (y.length + 1) > 1000000) {
    x.forEach((t) => add("removed", t));
    y.forEach((t) => add("added", t));
  } else {
    const width = y.length + 1,
      table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        table[i * width + j] =
          x[i] === y[j]
            ? 1 + table[(i + 1) * width + j + 1]
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        add("same", x[i++]);
        j++;
      } else if (
        i < x.length &&
        (j === y.length ||
          table[(i + 1) * width + j] >= table[i * width + j + 1])
      )
        add("removed", x[i++]);
      else add("added", y[j++]);
    }
  }
  for (let i = a.length - suffix; i < a.length; i++) add("same", a[i]);
  return rows;
}
