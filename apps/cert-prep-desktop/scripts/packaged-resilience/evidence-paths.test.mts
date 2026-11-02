import assert from 'node:assert/strict';
import { join, parse, resolve } from 'node:path';
import { test } from 'node:test';

import { requireStrictDescendant } from './evidence-paths.mts';

const parent = resolve('evidence-parent');

test('strict descendant accepts nested paths', () => {
  requireStrictDescendant(join(parent, 'run'), parent, 'ROOT');
  requireStrictDescendant(join(parent, 'a', 'b'), parent, 'ROOT');
  requireStrictDescendant(join(parent, '..name'), parent, 'ROOT');
});

test('strict descendant rejects equality, traversal and escapes with the exact message', () => {
  const message = `ROOT must stay under ${parent}.`;
  const rejected = [
    parent,
    join(parent, 'run', '..'),
    resolve(parent, '..'),
    resolve(parent, '..', 'sibling'),
    join(parent, 'run', '..', '..', 'x'),
    resolve(parse(parent).root, 'elsewhere'),
  ];
  for (const candidate of rejected) {
    assert.throws(
      () => requireStrictDescendant(candidate, parent, 'ROOT'),
      (error: Error) => error.message === message,
      candidate,
    );
  }
});

test(
  'strict descendant rejects an absolute escape on another drive',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const otherDrive = parse(parent).root.toUpperCase().startsWith('C:')
      ? 'D:\\evidence'
      : 'C:\\evidence';
    assert.throws(
      () => requireStrictDescendant(otherDrive, parent, 'ROOT'),
      /^Error: ROOT must stay under /,
    );
  },
);
