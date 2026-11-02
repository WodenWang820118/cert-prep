import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Rejects equality with the parent, `..` traversal and absolute escapes. */
export function requireStrictDescendant(
  candidatePath: string,
  parentPath: string,
  label: string,
): void {
  const child = resolve(candidatePath);
  const parent = resolve(parentPath);
  const childRelative = relative(parent, child);
  if (
    !childRelative ||
    childRelative === '..' ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} must stay under ${parent}.`);
  }
}
