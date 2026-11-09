/** Remove source ordinals only when the entire choice list is numbered in order. */
export function displayChoice(choices: readonly string[], choice: string): string {
  const prefixes = choices.map((value) => /^([0-9０-９]+)(?:\s+|[.．)）]\s*)/.exec(value));
  const numbered = prefixes.length > 0 && prefixes.every((prefix, index) => {
    const ordinal = prefix?.[1].replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    );
    return ordinal === String(index + 1);
  });
  const index = choices.indexOf(choice);
  return numbered && index >= 0
    ? choice.slice(prefixes[index]?.[0].length ?? 0)
    : choice;
}
