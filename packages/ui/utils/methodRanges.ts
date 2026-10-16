import { pythonLanguage } from '@codemirror/lang-python';
import { javascriptLanguage, jsxLanguage, typescriptLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export interface MethodRange {
  name: string;
  start: number;
  end: number;
}

const functions = new Set(['FunctionDefinition', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration']);

/** Snapshot coordinates, including decorators; unsupported or malformed methods are omitted. */
export function methodRanges(path: string, content: string): MethodRange[] {
  const extension = path.split('.').pop()?.toLowerCase();
  const language = extension === 'py' || extension === 'pyi' ? pythonLanguage
    : extension === 'tsx' ? tsxLanguage : extension === 'jsx' ? jsxLanguage
    : ['ts', 'mts', 'cts'].includes(extension ?? '') ? typescriptLanguage
    : ['js', 'mjs', 'cjs'].includes(extension ?? '') ? javascriptLanguage : null;
  // shortcut: use the existing Python and JS/TS parsers; add others when their method context is needed.
  if (!language) return [];
  const tree = language.parser.parse(content);
  const document = Text.of(content.split('\n'));
  const named = (node: SyntaxNode): string | undefined => {
    let name = node.name === 'ArrowFunction' ? null : node.getChild('VariableName') ?? node.getChild('VariableDefinition')
      ?? node.getChild('PropertyDefinition') ?? node.getChild('PrivatePropertyDefinition');
    if (!name && ['ArrowFunction', 'FunctionExpression'].includes(node.name)) {
      const parent = node.parent;
      if (parent?.name === 'VariableDeclaration') {
        // A declaration can bind several variables; use the one immediately before this function.
        for (let child = parent.firstChild; child && child.from < node.from; child = child.nextSibling) {
          if (child.name === 'VariableDefinition') name = child;
        }
      } else if (parent?.name === 'Property') name = parent.getChild('PropertyDefinition');
    }
    return name ? content.slice(name.from, name.to) : undefined;
  };
  const methods: Array<MethodRange & { from: number; to: number }> = [];
  const errors: number[] = [];
  tree.iterate({ enter(cursor) {
    if (cursor.type.isError) errors.push(cursor.from);
    const node = cursor.node;
    if (!functions.has(node.name) && !(node.name === 'Property' && node.getChild('ParamList') && node.getChild('Block'))) return;
    const name = named(node);
    if (!name) return;
    const owners: string[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (functions.has(parent.name) || ['ClassDefinition', 'ClassDeclaration'].includes(parent.name)) {
        const owner = named(parent);
        if (owner) owners.unshift(owner);
      }
    }
    const from = node.parent?.name === 'DecoratedStatement' ? node.parent.from
      : ['ArrowFunction', 'FunctionExpression'].includes(node.name) && node.parent?.name === 'VariableDeclaration'
        ? node.parent.from : node.from;
    const to = node.from + content.slice(node.from, node.to).trimEnd().length;
    methods.push({ name: [...owners, name].join('.'), start: document.lineAt(from).number,
      end: document.lineAt(Math.max(from, to - 1)).number, from, to: node.to });
  } });
  return methods.filter(method => !errors.some(offset => offset >= method.from && offset <= method.to))
    .map(({ name, start, end }) => ({ name, start, end }));
}
