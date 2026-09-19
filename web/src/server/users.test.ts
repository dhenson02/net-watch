import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePasswd } from './users.ts';

test('parses passwd lines, first entry per uid wins', () => {
  const users = parsePasswd(
    ['root:x:0:0:root:/root:/bin/bash', '# comment', '', 'broken', 'alice:x:1000:1000::/home/alice:/bin/zsh', 'toor:x:0:0::/root:/bin/sh', 'bad:x:abc:1::/:/bin/false'].join('\n'),
  );
  assert.deepEqual([...users], [
    [0, 'root'],
    [1000, 'alice'],
  ]);
});
