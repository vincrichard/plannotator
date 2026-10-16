import { describe, expect, test } from 'bun:test';
import { methodRanges } from './methodRanges';

describe('method ranges from snapshot syntax', () => {
  test('Python names, decorators, multiline signatures and nested functions retain exact lines', () => {
    const source = 'class C:\n    @cache\n    async def outer(\n        self, x\n    ):\n        """def fake():\n            pass\n        """\n        def inner():\n            return x\n        return inner()\n\noutside = 1\n';
    expect(methodRanges('c.py', source)).toEqual([
      { name: 'C.outer', start: 2, end: 11 }, { name: 'C.outer.inner', start: 9, end: 10 },
    ]);
    expect(methodRanges('c.py', source.replaceAll('\n', '\r\n'))).toEqual(methodRanges('c.py', source));
  });
  test('TypeScript methods and named arrow functions ignore braces in strings and comments', () => {
    const source = 'class C {\n  async run(x: number) {\n    return "}"; // }\n  }\n}\nconst next = x => {\n  return x;\n};\nconst obj = { go() { return 1; } };\n';
    expect(methodRanges('c.ts', source)).toEqual([
      { name: 'C.run', start: 2, end: 4 }, { name: 'next', start: 6, end: 8 }, { name: 'go', start: 9, end: 9 },
    ]);
  });
  test('TSX components include their full JSX body', () => {
    expect(methodRanges('c.tsx', 'const View = () => (\n  <div>{"}"}</div>\n);\n')).toEqual([{ name: 'View', start: 1, end: 3 }]);
  });
  test('unsupported files and malformed methods do not invent boundaries', () => {
    expect(methodRanges('c.txt', 'def x():\n    pass\n')).toEqual([]);
    expect(methodRanges('c.ts', 'function broken() {\n  return "x";\n')).toEqual([]);
  });
});
