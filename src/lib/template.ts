type CompiledTemplateBranch = readonly [
  matchWhenPresent: 0 | 1,
  tags: readonly string[],
  children: readonly CompiledTemplateNode[],
];

export type CompiledTemplateNode =
  | string
  | readonly [
      branches: readonly CompiledTemplateBranch[],
      fallback: readonly CompiledTemplateNode[],
    ];

function renderNodes(
  nodes: readonly CompiledTemplateNode[],
  selectedTags: ReadonlySet<string>,
  output: string[],
): void {
  for (const node of nodes) {
    if (typeof node === "string") {
      output.push(node);
      continue;
    }

    const [branches, fallback] = node;
    const branch = branches.find(([matchWhenPresent, tags]) => {
      const present = tags.some((tag) => selectedTags.has(tag));
      return matchWhenPresent === 1 ? present : !present;
    });
    renderNodes(branch?.[2] ?? fallback, selectedTags, output);
  }
}

export function renderCompiledTemplate(
  nodes: readonly CompiledTemplateNode[],
  selectedTags: ReadonlySet<string>,
): string {
  const output: string[] = [];
  renderNodes(nodes, selectedTags, output);
  return output.join("");
}
