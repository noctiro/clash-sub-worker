import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "html-minifier-terser";
import { parseDocument } from "yaml";
import { writeTextAtomically } from "./write-atomically.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(projectRoot, "src/clash-template.yaml");
const uiSourcePath = resolve(projectRoot, "src/ui/index.html");
const packageLockPath = resolve(projectRoot, "package-lock.json");
const providerPipelineFiles = [
  "src/config/provider-limits.ts",
  "src/lib/provider-yaml.ts",
  "src/lib/provider-yaml-output.ts",
  "src/lib/proxy.ts",
];
const providerPipelinePaths = providerPipelineFiles.map((path) =>
  resolve(projectRoot, path),
);
const outputPath = resolve(projectRoot, "src/generated/public-config.ts");

const [source, uiSource, packageLockSource, ...providerPipelineSources] =
  await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(uiSourcePath, "utf8"),
    readFile(packageLockPath, "utf8"),
    ...providerPipelinePaths.map((path) => readFile(path, "utf8")),
  ]);
const packageLock = JSON.parse(packageLockSource);
const yamlVersion = packageLock.packages?.["node_modules/yaml"]?.version;
if (typeof yamlVersion !== "string" || yamlVersion.length === 0) {
  throw new Error(
    "package-lock.json does not contain the yaml package version",
  );
}
const providerPipelineHasher = createHash("sha256");
providerPipelineHasher.update("yaml@").update(yamlVersion).update("\0");
for (const [index, pipelineSource] of providerPipelineSources.entries()) {
  providerPipelineHasher
    .update(providerPipelineFiles[index] ?? String(index))
    .update("\0")
    .update(pipelineSource)
    .update("\0");
}
const providerPipelineHash = providerPipelineHasher.digest("hex");
const tagPattern = /^[a-z][a-z0-9-]{0,31}$/u;
const discoveredTags = [];
const discoveredTagSet = new Set();

const requiredPlaceholders = ["__PROVIDER_BLOCK__", "__CONTROLLER_SECRET__"];
for (const placeholder of requiredPlaceholders) {
  const count = source.split(placeholder).length - 1;
  if (count !== 1) {
    throw new Error(
      sourcePath +
        ": expected exactly one " +
        placeholder +
        ", found " +
        String(count),
    );
  }
}

function parseCondition(raw, lineNumber) {
  const match =
    /^tag\s*(=|!=)\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)$/u.exec(
      raw,
    );
  if (!match) {
    throw new Error(
      sourcePath + ":" + String(lineNumber) + ": invalid condition: " + raw,
    );
  }

  const values = match[2].split(",").map((value) => value.trim());
  if (new Set(values).size !== values.length) {
    throw new Error(sourcePath + ":" + String(lineNumber) + ": duplicate tag");
  }
  for (const value of values) {
    if (!tagPattern.test(value)) {
      throw new Error(
        sourcePath + ":" + String(lineNumber) + ": invalid tag: " + value,
      );
    }
    if (!discoveredTagSet.has(value)) {
      discoveredTagSet.add(value);
      discoveredTags.push(value);
    }
  }

  return {
    operator: match[1] === "=" ? "any" : "none",
    tags: values,
  };
}

function compileTemplate(text) {
  const root = [];
  const stack = [];
  let target = root;

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    const branch = /^\{\{(if|elif)\s+(.+)\}\}$/u.exec(trimmed);

    if (branch) {
      const [, kind, rawCondition] = branch;
      const condition = parseCondition(rawCondition.trim(), lineNumber);

      if (kind === "if") {
        const node = { kind: "if", branches: [], fallback: [] };
        const firstBranch = { condition, children: [] };
        node.branches.push(firstBranch);
        target.push(node);
        stack.push({ node, parent: target, hasElse: false });
        target = firstBranch.children;
        continue;
      }

      const frame = stack.at(-1);
      if (!frame) {
        throw new Error(
          sourcePath + ":" + String(lineNumber) + ": elif without if",
        );
      }
      if (frame.hasElse) {
        throw new Error(
          sourcePath + ":" + String(lineNumber) + ": elif after else",
        );
      }
      const nextBranch = { condition, children: [] };
      frame.node.branches.push(nextBranch);
      target = nextBranch.children;
      continue;
    }

    if (trimmed === "{{else}}") {
      const frame = stack.at(-1);
      if (!frame) {
        throw new Error(
          sourcePath + ":" + String(lineNumber) + ": else without if",
        );
      }
      if (frame.hasElse) {
        throw new Error(
          sourcePath + ":" + String(lineNumber) + ": duplicate else",
        );
      }
      frame.hasElse = true;
      target = frame.node.fallback;
      continue;
    }

    if (trimmed === "{{/if}}") {
      const frame = stack.pop();
      if (!frame) {
        throw new Error(
          sourcePath +
            ":" +
            String(lineNumber) +
            ": closing tag without if",
        );
      }
      target = frame.parent;
      continue;
    }

    if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
      throw new Error(
        sourcePath +
          ":" +
          String(lineNumber) +
          ": unknown directive: " +
          trimmed,
      );
    }

    // 编译产物不保留整行注释、空行或行尾空白。
    if (!trimmed || trimmed.startsWith("#")) continue;
    target.push({ kind: "line", value: line.trimEnd() });
  }

  if (stack.length !== 0) {
    throw new Error(sourcePath + ": unclosed if block");
  }

  return root;
}

function matches(condition, selected) {
  const any = condition.tags.some((tag) => selected.has(tag));
  return condition.operator === "any" ? any : !any;
}

function render(nodes, selected, output = []) {
  for (const node of nodes) {
    if (node.kind === "line") {
      output.push(node.value);
      continue;
    }
    const branch = node.branches.find(({ condition }) =>
      matches(condition, selected),
    );
    render(branch?.children ?? node.fallback, selected, output);
  }
  return output;
}

// Runtime program: adjacent YAML lines become one string; conditional nodes use
// tuples instead of repeating object property names for every branch and line.
function compactTemplate(nodes) {
  const output = [];
  let lines = [];

  const flushLines = () => {
    if (lines.length === 0) return;
    output.push(lines.join("\n") + "\n");
    lines = [];
  };

  for (const node of nodes) {
    if (node.kind === "line") {
      lines.push(node.value);
      continue;
    }

    flushLines();
    output.push([
      node.branches.map(({ condition, children }) => [
        condition.operator === "any" ? 1 : 0,
        condition.tags,
        compactTemplate(children),
      ]),
      compactTemplate(node.fallback),
    ]);
  }

  flushLines();
  return output;
}

function renderCompactTemplate(nodes, selected, output = []) {
  for (const node of nodes) {
    if (typeof node === "string") {
      output.push(node);
      continue;
    }

    const [branches, fallback] = node;
    const branch = branches.find(([matchWhenPresent, tags]) => {
      const present = tags.some((tag) => selected.has(tag));
      return matchWhenPresent === 1 ? present : !present;
    });
    renderCompactTemplate(branch?.[2] ?? fallback, selected, output);
  }
  return output;
}

function discoverExclusiveGroups(nodes, candidates = []) {
  for (const node of nodes) {
    if (node.kind !== "if") continue;
    if (
      node.branches.length > 1 &&
      node.branches.every(
        ({ condition }) =>
          condition.operator === "any" && condition.tags.length === 1,
      )
    ) {
      candidates.push(node.branches.map(({ condition }) => condition.tags[0]));
    }
    for (const branch of node.branches) {
      discoverExclusiveGroups(branch.children, candidates);
    }
    discoverExclusiveGroups(node.fallback, candidates);
  }
  return candidates;
}

function normalizeExclusiveGroups(candidates) {
  const groups = [];
  const groupKeys = new Set();
  const owners = new Map();

  for (const candidate of candidates) {
    const group = candidate.filter((tag) => tag !== undefined);
    const key = [...group].sort().join("\0");
    if (groupKeys.has(key)) continue;
    for (const tag of group) {
      const owner = owners.get(tag);
      if (owner !== undefined) {
        throw new Error(
          "Tag " + tag + " appears in overlapping exclusive groups",
        );
      }
      owners.set(tag, groups.length);
    }
    groupKeys.add(key);
    groups.push(group);
  }

  return groups;
}

function allTagCombinations(tags, exclusiveGroups) {
  const exclusiveTags = new Set(exclusiveGroups.flat());
  const independentTags = tags.filter((tag) => !exclusiveTags.has(tag));
  let combinations = [new Set()];

  for (const tag of independentTags) {
    combinations = combinations.flatMap((selected) => {
      const withTag = new Set(selected);
      withTag.add(tag);
      return [selected, withTag];
    });
  }
  for (const group of exclusiveGroups) {
    combinations = combinations.flatMap((selected) => [
      selected,
      ...group.map((tag) => new Set([...selected, tag])),
    ]);
  }
  if (combinations.length > 4096) {
    throw new Error(
      "Template expands to " +
        String(combinations.length) +
        " tag variants; split or simplify its conditions",
    );
  }
  return combinations;
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function compileUi(html, tags, exclusiveGroups) {
  if (countOccurrences(html, "<!--TAG_OPTIONS-->") !== 1) {
    throw new Error("UI must contain exactly one tag options placeholder");
  }
  for (const placeholder of ["__CSP_NONCE__", "__PROFILE_NAME__"]) {
    if (countOccurrences(html, placeholder) === 0) {
      throw new Error("UI is missing placeholder: " + placeholder);
    }
  }

  const seen = new Set();
  const renderTag = (tag, type, inputName) => {
    if (!tagPattern.test(tag)) {
      throw new Error("Invalid tag value: " + tag);
    }
    if (seen.has(tag)) {
      throw new Error("Duplicate tag value: " + tag);
    }
    seen.add(tag);

    return (
      '<label class="option">' +
      '<input class="tag-control" type="' +
      type +
      '" name="' +
      inputName +
      '" value="' +
      escapeHtml(tag) +
      '"><span>' +
      escapeHtml(tag) +
      "</span></label>"
    );
  };

  const exclusiveTags = new Set(exclusiveGroups.flat());
  const independentTags = tags.filter((tag) => !exclusiveTags.has(tag));
  const sections = [];

  if (independentTags.length > 0) {
    sections.push(
      '<div class="tag-group"><div class="group-heading"><h2>功能标签</h2><span>可多选</span></div><div class="options" role="group" aria-label="功能标签">' +
        independentTags
          .map((tag) => renderTag(tag, "checkbox", "independent-tags"))
          .join("") +
        "</div></div>",
    );
  }
  exclusiveGroups.forEach((group, index) => {
    const label =
      exclusiveGroups.length === 1
        ? "单选标签"
        : "单选标签 " + String(index + 1);
    const inputName = "exclusive-tags-" + String(index);
    sections.push(
      '<div class="tag-group"><div class="group-heading"><h2>' +
        label +
        '</h2><span>选择一项</span></div><div class="options" role="radiogroup" aria-label="' +
        label +
        '"><label class="option"><input class="tag-control" type="radio" name="' +
        inputName +
        '" value="" checked><span>自动</span></label>' +
        group.map((tag) => renderTag(tag, "radio", inputName)).join("") +
        "</div></div>",
    );
  });
  if (seen.size !== tags.length) {
    throw new Error("Compiled tag manifest contains unrendered tags");
  }

  const hydrated = html.replace("<!--TAG_OPTIONS-->", sections.join(""));
  const minified = await minify(hydrated, {
    collapseBooleanAttributes: true,
    collapseWhitespace: true,
    decodeEntities: true,
    minifyCSS: true,
    minifyJS: true,
    removeAttributeQuotes: false,
    removeComments: true,
    removeEmptyAttributes: true,
    removeRedundantAttributes: true,
    sortAttributes: true,
    useShortDoctype: true,
  });
  if (minified.length === 0) throw new Error("Compiled UI is empty");
  for (const placeholder of ["__CSP_NONCE__", "__PROFILE_NAME__"]) {
    if (countOccurrences(minified, placeholder) === 0) {
      throw new Error("Minified UI lost placeholder: " + placeholder);
    }
  }
  return minified;
}

function compileProviderPolicy(config) {
  const defaults = config.p;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error("Template p anchor must be a mapping");
  }

  const rawTypes = defaults["exclude-type"];
  const nameFilter = defaults.filter;
  if (typeof rawTypes !== "string" || typeof nameFilter !== "string") {
    throw new Error("Template p anchor must define exclude-type and filter");
  }

  const excludedTypes = [...new Set(
    rawTypes
      .split("|")
      .map((type) => type.trim().toLowerCase())
      .filter(Boolean),
  )];
  if (
    excludedTypes.length === 0 ||
    excludedTypes.some((type) => !/^[a-z0-9-]{1,32}$/u.test(type))
  ) {
    throw new Error("Template p.exclude-type is invalid");
  }
  try {
    new RegExp(nameFilter, "u");
  } catch {
    throw new Error(
      "Template p.filter is not compatible with JavaScript RegExp",
    );
  }

  const signature = JSON.stringify({
    excludedTypes,
    nameFilter,
    providerPipelineHash,
  });
  return {
    excludedTypes,
    nameFilter,
    cacheRevision: createHash("sha256")
      .update(signature)
      .digest("hex")
      .slice(0, 16),
  };
}

const compiled = compileTemplate(source);
const compiledProgram = compactTemplate(compiled);
const exclusiveGroups = normalizeExclusiveGroups(
  discoverExclusiveGroups(compiled),
);
const dummyProvider = [
  "  compile-check:",
  "    <<: *p",
  '    url: "https://example.com/subscription"',
  "    override:",
  '      additional-prefix: "[CHECK]"',
].join("\n");
const combinations = allTagCombinations(discoveredTags, exclusiveGroups);
let providerPolicy;

for (const selected of combinations) {
  const reference = render(compiled, selected).join("\n") + "\n";
  const rendered = renderCompactTemplate(compiledProgram, selected).join("");
  if (rendered !== reference) {
    throw new Error("Compact template renderer changed the YAML output");
  }
  const yaml = rendered
    .replace("__PROVIDER_BLOCK__", dummyProvider)
    .replace("__CONTROLLER_SECRET__", '"compile-check-secret"');
  const document = parseDocument(yaml, {
    merge: true,
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    const labels = [...selected].join(",") || "(no tags)";
    throw new Error(
      "Generated YAML is invalid for tags [" +
        labels +
        "]:\n" +
        document.errors.join("\n"),
    );
  }

  const value = document.toJS();
  if (!value || typeof value !== "object") {
    throw new Error("Generated YAML root must be a mapping");
  }
  const currentProviderPolicy = compileProviderPolicy(value);
  if (!providerPolicy) {
    providerPolicy = currentProviderPolicy;
  } else if (
    currentProviderPolicy.cacheRevision !== providerPolicy.cacheRevision
  ) {
    throw new Error("Provider filtering policy must not depend on tags");
  }
  for (const requiredKey of [
    "proxy-providers",
    "proxy-groups",
    "rule-providers",
    "rules",
  ]) {
    if (!(requiredKey in value)) {
      throw new Error("Generated YAML is missing required key: " + requiredKey);
    }
  }
}

if (!providerPolicy) {
  throw new Error("Provider filtering policy was not generated");
}

const tagManifest = {
  tags: discoveredTags,
  exclusiveGroups,
};
const templateRevision = createHash("sha256")
  .update(JSON.stringify({ compiledProgram, tagManifest }))
  .digest("hex")
  .slice(0, 8);
const minifiedUi = await compileUi(uiSource, discoveredTags, exclusiveGroups);
const generated = [
  "// This file is generated by scripts/build-config.mjs. Do not edit.",
  'import type { CompiledTemplateNode } from "../lib/template";',
  "",
  "export const COMPILED_CLASH_TEMPLATE = " +
    JSON.stringify(compiledProgram) +
    " as const satisfies readonly CompiledTemplateNode[];",
  "export const TEMPLATE_REVISION = " +
    JSON.stringify(templateRevision) +
    ";",
  "export const TAGS = " + JSON.stringify(discoveredTags) + " as const;",
  "export const EXCLUSIVE_TAG_GROUPS = " +
    JSON.stringify(exclusiveGroups) +
    " as const;",
  "export const PROVIDER_POLICY = " +
    JSON.stringify(providerPolicy) +
    " as const;",
  "export const MINIFIED_UI = " + JSON.stringify(minifiedUi) + ";",
  "",
].join("\n");

await writeTextAtomically(outputPath, generated);
console.log(
  "Compiled public artifacts: " +
    String(compiled.length) +
    " root nodes, " +
    String(compiledProgram.length) +
    " compact nodes, " +
    String(discoveredTags.length) +
    " tags, " +
    String(exclusiveGroups.length) +
    " exclusive groups, " +
    String(combinations.length) +
    " tag variants validated, UI " +
    String(Buffer.byteLength(uiSource)) +
    " -> " +
    String(Buffer.byteLength(minifiedUi)) +
    " bytes",
);
