// Split a command into argv without invoking a shell or expanding anything.
export function commandArguments(input) {
  const args = [];
  let word = "",
    quote = null,
    escaped = false,
    started = false;
  for (const char of input.trim()) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (quote || escaped)
    throw new Error("Finish the quoted command or escaped character.");
  if (started) args.push(word);
  if (!args.length)
    throw new Error("Enter a command, such as python -m pytest.");
  return args;
}
