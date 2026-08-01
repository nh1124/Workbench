export function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function parentPath(itemPath: string): string {
  const normalized = normalizePath(itemPath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

export function leafPath(itemPath: string): string {
  const normalized = normalizePath(itemPath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function joinPath(basePath: string, leaf: string): string {
  const base = normalizePath(basePath);
  const cleanLeaf = normalizePath(leaf);
  if (!base) return cleanLeaf;
  if (!cleanLeaf) return base;
  return `${base}/${cleanLeaf}`;
}

export function isExternalUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function resolveMarkdownRef(markdownFilePath: string, href: string): string {
  if (!href) return href;
  if (href.startsWith("/")) return normalizePath(href.slice(1));
  const dir = parentPath(markdownFilePath);
  return normalizePath(joinPath(dir, href));
}

export function relativeArtifactPath(fromFilePath: string, toFilePath: string): string {
  const fromDir = normalizePath(parentPath(fromFilePath));
  const to = normalizePath(toFilePath);
  if (fromDir && to.startsWith(fromDir + "/")) return to.slice(fromDir.length + 1);
  return to;
}

export function isMarkdownFilePath(itemPath: string): boolean {
  return /\.(md|markdown)$/i.test(itemPath.trim());
}
