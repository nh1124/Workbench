export interface EditorTextTransformResult {
  nextText: string;
  nextSelectionStart: number;
  nextSelectionEnd: number;
}

function transformLineLevel(line: string, delta: 1 | -1): string {
  const matched = line.match(/^(\s*)(-+)\s*(.*)$/);
  if (delta === 1) {
    if (matched) {
      const level = Math.min(matched[2].length + 1, 3);
      const rest = matched[3];
      return `${matched[1]}${"-".repeat(level)}${rest ? ` ${rest}` : " "}`;
    }
    const indent = (line.match(/^(\s*)/)?.[1] ?? "");
    const rest = line.trimStart();
    return `${indent}-${rest ? ` ${rest}` : " "}`;
  }

  if (!matched) {
    return line;
  }
  const currentLevel = matched[2].length;
  const nextLevel = Math.max(0, currentLevel - 1);
  const rest = matched[3];
  if (nextLevel === 0) {
    return `${matched[1]}${rest}`;
  }
  return `${matched[1]}${"-".repeat(nextLevel)}${rest ? ` ${rest}` : " "}`;
}

export function transformSelectedLinesLevel(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  delta: 1 | -1
): EditorTextTransformResult | null {
  const lineStart = text.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const lineEndRaw = text.indexOf("\n", selectionEnd);
  const lineEnd = lineEndRaw >= 0 ? lineEndRaw : text.length;
  const currentBlock = text.slice(lineStart, lineEnd);
  const transformedBlock = currentBlock
    .split("\n")
    .map((line) => transformLineLevel(line, delta))
    .join("\n");

  if (transformedBlock === currentBlock) {
    return null;
  }

  const nextText = `${text.slice(0, lineStart)}${transformedBlock}${text.slice(lineEnd)}`;
  if (selectionStart === selectionEnd) {
    const deltaLen = transformedBlock.length - currentBlock.length;
    const nextPos = Math.max(lineStart, selectionStart + deltaLen);
    return {
      nextText,
      nextSelectionStart: nextPos,
      nextSelectionEnd: nextPos
    };
  }

  return {
    nextText,
    nextSelectionStart: lineStart,
    nextSelectionEnd: lineStart + transformedBlock.length
  };
}

export function transformBoldAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number
): EditorTextTransformResult {
  if (selectionStart === selectionEnd) {
    const nextText = `${text.slice(0, selectionStart)}****${text.slice(selectionEnd)}`;
    const nextPos = selectionStart + 2;
    return {
      nextText,
      nextSelectionStart: nextPos,
      nextSelectionEnd: nextPos
    };
  }

  const selected = text.slice(selectionStart, selectionEnd);
  if (selected.startsWith("**") && selected.endsWith("**") && selected.length >= 4) {
    const unwrapped = selected.slice(2, -2);
    const nextText = `${text.slice(0, selectionStart)}${unwrapped}${text.slice(selectionEnd)}`;
    const nextEnd = selectionStart + unwrapped.length;
    return {
      nextText,
      nextSelectionStart: selectionStart,
      nextSelectionEnd: nextEnd
    };
  }

  const hasOuterBold = selectionStart >= 2 && text.slice(selectionStart - 2, selectionStart) === "**"
    && text.slice(selectionEnd, selectionEnd + 2) === "**";
  if (hasOuterBold) {
    const nextText = `${text.slice(0, selectionStart - 2)}${selected}${text.slice(selectionEnd + 2)}`;
    return {
      nextText,
      nextSelectionStart: selectionStart - 2,
      nextSelectionEnd: selectionEnd - 2
    };
  }

  const nextText = `${text.slice(0, selectionStart)}**${selected}**${text.slice(selectionEnd)}`;
  return {
    nextText,
    nextSelectionStart: selectionStart + 2,
    nextSelectionEnd: selectionEnd + 2
  };
}

export function transformStrikeAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number
): EditorTextTransformResult {
  if (selectionStart === selectionEnd) {
    const nextText = `${text.slice(0, selectionStart)}~~~~${text.slice(selectionEnd)}`;
    const nextPos = selectionStart + 2;
    return {
      nextText,
      nextSelectionStart: nextPos,
      nextSelectionEnd: nextPos
    };
  }

  const selected = text.slice(selectionStart, selectionEnd);
  if (selected.startsWith("~~") && selected.endsWith("~~") && selected.length >= 4) {
    const unwrapped = selected.slice(2, -2);
    const nextText = `${text.slice(0, selectionStart)}${unwrapped}${text.slice(selectionEnd)}`;
    const nextEnd = selectionStart + unwrapped.length;
    return {
      nextText,
      nextSelectionStart: selectionStart,
      nextSelectionEnd: nextEnd
    };
  }

  const hasOuterStrike = selectionStart >= 2 && text.slice(selectionStart - 2, selectionStart) === "~~"
    && text.slice(selectionEnd, selectionEnd + 2) === "~~";
  if (hasOuterStrike) {
    const nextText = `${text.slice(0, selectionStart - 2)}${selected}${text.slice(selectionEnd + 2)}`;
    return {
      nextText,
      nextSelectionStart: selectionStart - 2,
      nextSelectionEnd: selectionEnd - 2
    };
  }

  const nextText = `${text.slice(0, selectionStart)}~~${selected}~~${text.slice(selectionEnd)}`;
  return {
    nextText,
    nextSelectionStart: selectionStart + 2,
    nextSelectionEnd: selectionEnd + 2
  };
}

export function transformEnterWithLevelContinuation(
  text: string,
  selectionStart: number,
  selectionEnd: number
): EditorTextTransformResult | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }
  const lineStart = text.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const currentLine = text.slice(lineStart, selectionStart);
  const matched = currentLine.match(/^(\s*-{1,3})(?:\s+.*)?$/);
  if (!matched) {
    return null;
  }
  const insert = `\n${matched[1]} `;
  const nextText = `${text.slice(0, selectionStart)}${insert}${text.slice(selectionEnd)}`;
  const nextPos = selectionStart + insert.length;
  return {
    nextText,
    nextSelectionStart: nextPos,
    nextSelectionEnd: nextPos
  };
}
