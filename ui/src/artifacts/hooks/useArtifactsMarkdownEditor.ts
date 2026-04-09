import { useEffect, useRef, type ClipboardEvent, type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import { artifactsApi } from "../../lib/api";
import type { ArtifactItem } from "../../types/models";
import type { ArtifactEditorDraft } from "../types";
import { transformBoldAtSelection, transformEnterWithLevelContinuation, transformSelectedLinesLevel, transformStrikeAtSelection, type EditorTextTransformResult } from "../utils/editorTransforms";
import {
  createNotionBlock,
  findNotionBlock,
  hasMeaningfulBlockContent,
  markdownToNotionHtml,
  normalizeNotionBlockElement,
  notionEditorToMarkdown,
  placeCaretAtBlockStart
} from "../utils/notionMarkdown";
import { isExternalUrl, normalizePath, parentPath, relativeArtifactPath, resolveMarkdownRef } from "../utils/path";

type PreviewMode = "edit" | "live";

type UseArtifactsMarkdownEditorParams = {
  draft: ArtifactEditorDraft;
  setDraft: Dispatch<SetStateAction<ArtifactEditorDraft>>;
  notePreviewMode: PreviewMode;
  items: ArtifactItem[];
  /** Called after an image is uploaded via paste so the items list can be refreshed. */
  onImageUploaded: () => Promise<void>;
};

export function useArtifactsMarkdownEditor({
  draft,
  setDraft,
  notePreviewMode,
  items,
  onImageUploaded,
}: UseArtifactsMarkdownEditorParams) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const notionEditorRef = useRef<HTMLDivElement | null>(null);
  const notionSyncRef = useRef<{ itemId?: string; markdown: string }>({ itemId: undefined, markdown: "" });
  const editSelectionRef = useRef<{ start: number; end: number; text: string } | null>(null);
  const liveSelectionRef = useRef<Range | null>(null);
  const inlineImageBlobUrlCacheRef = useRef<Map<string, string>>(new Map());

  const applyEditorTransform = (transform: EditorTextTransformResult) => {
    setDraft((prev) => ({
      ...prev,
      contentMarkdown: transform.nextText
    }));
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(transform.nextSelectionStart, transform.nextSelectionEnd);
    });
  };

  const rememberEditSelection = (textarea: HTMLTextAreaElement) => {
    const text = textarea.value;
    const start = textarea.selectionStart ?? text.length;
    const end = textarea.selectionEnd ?? text.length;
    editSelectionRef.current = {
      start,
      end,
      text: text.slice(start, end)
    };
  };

  const rememberLiveSelection = () => {
    const editor = notionEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      liveSelectionRef.current = null;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      liveSelectionRef.current = null;
      return;
    }
    liveSelectionRef.current = range.cloneRange();
  };

  const applyDraftInsertion = (insertedText: string) => {
    const text = draft.contentMarkdown;
    const snapshot = editSelectionRef.current;
    const fallbackPos = editorRef.current?.selectionStart ?? text.length;
    const start = snapshot?.start ?? fallbackPos;
    const end = snapshot?.end ?? fallbackPos;
    const nextText = `${text.slice(0, start)}${insertedText}${text.slice(end)}`;
    const cursor = start + insertedText.length;
    applyEditorTransform({
      nextText,
      nextSelectionStart: cursor,
      nextSelectionEnd: cursor
    });
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const text = draft.contentMarkdown;
    const selectionStart = event.currentTarget.selectionStart ?? text.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? text.length;
    const withCtrl = event.ctrlKey || event.metaKey;

    if (!withCtrl && !event.altKey && !event.shiftKey && event.key === "Enter") {
      const continued = transformEnterWithLevelContinuation(text, selectionStart, selectionEnd);
      if (continued) {
        event.preventDefault();
        applyEditorTransform(continued);
      }
      return;
    }

    if (!withCtrl) {
      return;
    }

    const lowerKey = event.key.toLowerCase();
    if (lowerKey === "b") {
      event.preventDefault();
      applyEditorTransform(transformBoldAtSelection(text, selectionStart, selectionEnd));
      return;
    }

    const isStrikeToggle = event.key === "-" || event.code === "Minus" || event.code === "NumpadSubtract";
    if (isStrikeToggle) {
      event.preventDefault();
      applyEditorTransform(transformStrikeAtSelection(text, selectionStart, selectionEnd));
      return;
    }

    const isIncrease = event.key === ">" || (event.shiftKey && event.key === ".");
    if (isIncrease) {
      const transformed = transformSelectedLinesLevel(text, selectionStart, selectionEnd, 1);
      if (transformed) {
        event.preventDefault();
        applyEditorTransform(transformed);
      }
      return;
    }

    const isDecrease = event.key === "<" || (event.shiftKey && event.key === ",");
    if (isDecrease) {
      const transformed = transformSelectedLinesLevel(text, selectionStart, selectionEnd, -1);
      if (transformed) {
        event.preventDefault();
        applyEditorTransform(transformed);
      }
    }
  };

  const syncDraftFromNotionEditor = () => {
    const editor = notionEditorRef.current;
    if (!editor) return;
    const children = Array.from(editor.children) as HTMLElement[];
    if (children.length === 0) {
      editor.appendChild(createNotionBlock("paragraph"));
    } else {
      for (const child of children) {
        normalizeNotionBlockElement(child);
      }
    }

    const markdown = notionEditorToMarkdown(editor);
    notionSyncRef.current = { itemId: draft.id, markdown };
    setDraft((prev) => (prev.contentMarkdown === markdown ? prev : { ...prev, contentMarkdown: markdown }));
  };

  const handleNotionEditorInput = () => {
    syncDraftFromNotionEditor();
  };

  const handleNotionEditorPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // Try to get image files from clipboard synchronously first.
    let imageFiles: File[] = Array.from(event.clipboardData.files).filter((f) => /^image\//i.test(f.type));
    if (imageFiles.length === 0) {
      imageFiles = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file" && /^image\//i.test(item.type))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
    }

    if (imageFiles.length > 0) {
      // Synchronous path: images found in DataTransfer (standard browsers).
      event.preventDefault();
      void uploadAndInsertImages(imageFiles);
      return;
    }

    // Text paste (also covers the case where Clipboard API must be tried asynchronously).
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      document.execCommand("insertText", false, text);
      syncDraftFromNotionEditor();
      return;
    }

    // Fallback: Clipboard API (needed in WebView2 where DataTransfer images are absent).
    if (typeof navigator.clipboard?.read === "function") {
      void (async () => {
        try {
          const clipItems = await navigator.clipboard.read();
          const asyncFiles: File[] = [];
          for (const clipItem of clipItems) {
            for (const type of clipItem.types) {
              if (/^image\//i.test(type)) {
                const blob = await clipItem.getType(type);
                const ext = type.split("/")[1] ?? "png";
                asyncFiles.push(new File([blob], `paste-${Date.now()}.${ext}`, { type }));
              }
            }
          }
          if (asyncFiles.length > 0) {
            await uploadAndInsertImages(asyncFiles);
          }
        } catch {
          // Permission denied or Clipboard API unavailable.
        }
      })();
    }
  };

  const uploadAndInsertImages = async (files: File[]) => {
    const uploadDir = parentPath(draft.path) || undefined;
    let insertedText = "";
    try {
      for (const file of files) {
        const name = file.name && file.name !== "image.png"
          ? file.name
          : `paste-${Date.now()}.${file.type.split("/")[1] ?? "png"}`;
        const namedFile = new File([file], name, { type: file.type });
        const uploaded = await artifactsApi.uploadFile({
          projectId: draft.projectId,
          projectName: draft.projectName || undefined,
          directoryPath: uploadDir,
          file: namedFile,
        });
        const rel = relativeArtifactPath(draft.path, uploaded.path);
        insertedText += `![${name}](${rel})\n`;
      }
    } catch {
      return;
    }
    await onImageUploaded();
    setDraft((prev) => ({ ...prev, contentMarkdown: prev.contentMarkdown + insertedText }));
  };

  // Drop handler for the Notion (Live) editor.
  // The contentEditable div has no native upload support, so we intercept the drop,
  // upload the files, and append markdown links to the draft — same as handleEditorDrop
  // does for the textarea, but without a cursor-position offset.
  const handleNotionEditorDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    event.preventDefault();

    const uploadDir = parentPath(draft.path) || undefined;

    void (async () => {
      let insertedText = "";
      try {
        for (const file of Array.from(files)) {
          const uploaded = await artifactsApi.uploadFile({
            projectId: draft.projectId,
            projectName: draft.projectName || undefined,
            directoryPath: uploadDir,
            file,
          });
          const rel = relativeArtifactPath(draft.path, uploaded.path);
          const isImg = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
          insertedText += isImg ? `![${file.name}](${rel})\n` : `[${file.name}](${rel})\n`;
        }
      } catch {
        return;
      }
      await onImageUploaded();
      setDraft((prev) => ({ ...prev, contentMarkdown: prev.contentMarkdown + insertedText }));
    })();
  };

  const getSelectedNotionBlocks = (editor: HTMLDivElement, range: Range): HTMLElement[] => {
    if (range.collapsed) {
      const single = findNotionBlock(editor, range.startContainer);
      return single ? [single] : [];
    }
    const blocks = Array.from(editor.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && Boolean(node.dataset.mdKind)
    );
    return blocks.filter((block) => {
      try {
        return range.intersectsNode(block);
      } catch {
        return false;
      }
    });
  };

  const createRangeFromBlockTextOffsets = (block: HTMLElement, startOffset: number, endOffset: number): Range | null => {
    if (startOffset < 0 || endOffset < startOffset) {
      return null;
    }

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let traversed = 0;
    let startNode: Text | null = null;
    let startNodeOffset = 0;
    let endNode: Text | null = null;
    let endNodeOffset = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const textLength = node.nodeValue?.length ?? 0;
      const nextTraversed = traversed + textLength;

      if (!startNode && startOffset <= nextTraversed) {
        startNode = node;
        startNodeOffset = Math.max(0, Math.min(textLength, startOffset - traversed));
      }

      if (!endNode && endOffset <= nextTraversed) {
        endNode = node;
        endNodeOffset = Math.max(0, Math.min(textLength, endOffset - traversed));
        break;
      }

      traversed = nextTraversed;
    }

    if (!startNode || !endNode) {
      return null;
    }

    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  };

  const adjustParagraphIndentForTab = (block: HTMLElement, decrease = false): void => {
    const firstTextNode = (() => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      return node instanceof Text ? node : null;
    })();

    if (firstTextNode) {
      const value = firstTextNode.nodeValue ?? "";
      if (decrease) {
        if (value.startsWith("\t")) {
          firstTextNode.nodeValue = value.slice(1);
        } else if (value.startsWith("    ")) {
          firstTextNode.nodeValue = value.slice(4);
        }
        return;
      }
      firstTextNode.nodeValue = `\t${value}`;
      return;
    }

    if (!decrease) {
      block.insertBefore(document.createTextNode("\t"), block.firstChild);
    }
  };

  const handleNotionEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const editor = notionEditorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const currentBlock = findNotionBlock(editor, range.startContainer);
    if (!currentBlock) return;
    const selectedBlocks = getSelectedNotionBlocks(editor, range);

    const withCtrl = event.ctrlKey || event.metaKey;
    const isInsideTableCell =
      currentBlock.dataset.mdKind === "table" &&
      event.target instanceof HTMLElement &&
      event.target.closest("th,td") instanceof HTMLTableCellElement;

    if (withCtrl && event.key.toLowerCase() === "b") {
      event.preventDefault();
      document.execCommand("bold");
      syncDraftFromNotionEditor();
      return;
    }

    const isStrikeToggle = event.key === "-" || event.code === "Minus" || event.code === "NumpadSubtract";
    if (withCtrl && isStrikeToggle) {
      event.preventDefault();
      document.execCommand("strikeThrough");
      syncDraftFromNotionEditor();
      return;
    }

    if (withCtrl && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      document.execCommand("removeFormat");
      for (const block of selectedBlocks) {
        if (block.dataset.mdKind === "bullet" || block.dataset.mdKind === "heading") {
          block.dataset.mdKind = "paragraph";
          delete block.dataset.mdLevel;
          normalizeNotionBlockElement(block);
        }
      }
      syncDraftFromNotionEditor();
      return;
    }

    if (isInsideTableCell) {
      return;
    }

    if (!withCtrl && !event.altKey && event.key === "Tab" && !range.collapsed && selectedBlocks.length > 1) {
      event.preventDefault();
      for (const block of selectedBlocks) {
        if (block.dataset.mdKind === "table") {
          continue;
        }
        if (block.dataset.mdKind === "bullet") {
          const currentLevel = Number(block.dataset.mdLevel || "1");
          if (event.shiftKey) {
            if (currentLevel <= 1) {
              block.dataset.mdKind = "paragraph";
              delete block.dataset.mdLevel;
            } else {
              block.dataset.mdLevel = String(currentLevel - 1);
            }
          } else {
            block.dataset.mdLevel = String(Math.min(3, currentLevel + 1));
          }
          normalizeNotionBlockElement(block);
          continue;
        }

        adjustParagraphIndentForTab(block, event.shiftKey);
        normalizeNotionBlockElement(block);
      }
      syncDraftFromNotionEditor();
      return;
    }

    if (!withCtrl && !event.altKey && event.key === "Tab" && range.collapsed && currentBlock.dataset.mdKind === "bullet") {
      const beforeRange = document.createRange();
      beforeRange.setStart(currentBlock, 0);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const atBlockStart = beforeRange.toString().length === 0;
      if (!atBlockStart) {
        return;
      }

      event.preventDefault();
      const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
      if (event.shiftKey) {
        if (currentLevel <= 1) {
          currentBlock.dataset.mdKind = "paragraph";
          delete currentBlock.dataset.mdLevel;
        } else {
          currentBlock.dataset.mdLevel = String(currentLevel - 1);
        }
      } else {
        currentBlock.dataset.mdLevel = String(Math.min(3, currentLevel + 1));
      }
      normalizeNotionBlockElement(currentBlock);
      syncDraftFromNotionEditor();
      return;
    }

    if (!withCtrl && !event.altKey && event.key === "Backspace" && range.collapsed && currentBlock.dataset.mdKind === "bullet") {
      const beforeRange = document.createRange();
      beforeRange.setStart(currentBlock, 0);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const atBlockStart = beforeRange.toString().length === 0;
      if (atBlockStart) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "paragraph";
        delete currentBlock.dataset.mdLevel;
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }
    }

    if (withCtrl && (event.key === ">" || (event.shiftKey && event.key === "."))) {
      if (currentBlock.dataset.mdKind === "bullet" || currentBlock.dataset.mdKind === "heading") {
        event.preventDefault();
        const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
        currentBlock.dataset.mdLevel = String(Math.min(3, currentLevel + 1));
        normalizeNotionBlockElement(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (withCtrl && (event.key === "<" || (event.shiftKey && event.key === ","))) {
      if (currentBlock.dataset.mdKind === "bullet" || currentBlock.dataset.mdKind === "heading") {
        event.preventDefault();
        const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
        if (currentLevel <= 1) {
          currentBlock.dataset.mdKind = "paragraph";
          delete currentBlock.dataset.mdLevel;
        } else {
          currentBlock.dataset.mdLevel = String(currentLevel - 1);
        }
        normalizeNotionBlockElement(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (event.key === " " && range.collapsed) {
      const beforeRange = document.createRange();
      beforeRange.setStart(currentBlock, 0);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const prefix = beforeRange.toString().trim();
      const wholeText = (currentBlock.textContent ?? "").trim();
      if (/^-{1,3}$/.test(prefix) && prefix === wholeText) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "bullet";
        currentBlock.dataset.mdLevel = String(Math.min(3, prefix.length));
        currentBlock.innerHTML = "<br>";
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }
      if (/^#{1,3}$/.test(prefix) && prefix === wholeText) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "heading";
        currentBlock.dataset.mdLevel = String(Math.min(3, prefix.length));
        currentBlock.innerHTML = "<br>";
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
      }

      const beforeText = beforeRange.toString();
      const urlMatch = beforeText.match(/(?:^|\s)(https?:\/\/[^\s]+)$/i);
      if (urlMatch) {
        const url = urlMatch[1];
        const urlStart = beforeText.length - url.length;
        const urlEnd = beforeText.length;
        const urlRange = createRangeFromBlockTextOffsets(currentBlock, urlStart, urlEnd);
        if (urlRange) {
          const startElement = urlRange.startContainer instanceof Element
            ? urlRange.startContainer
            : urlRange.startContainer.parentElement;
          const endElement = urlRange.endContainer instanceof Element
            ? urlRange.endContainer
            : urlRange.endContainer.parentElement;
          const startAnchor = startElement?.closest("a") ?? null;
          const endAnchor = endElement?.closest("a") ?? null;
          if (!(startAnchor && endAnchor && startAnchor === endAnchor)) {
            event.preventDefault();
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.textContent = url;
            urlRange.deleteContents();
            urlRange.insertNode(anchor);
            const spacer = document.createTextNode(" ");
            if (anchor.parentNode) {
              anchor.parentNode.insertBefore(spacer, anchor.nextSibling);
            }
            const caret = document.createRange();
            caret.setStartAfter(spacer);
            caret.collapse(true);
            selection.removeAllRanges();
            selection.addRange(caret);
            syncDraftFromNotionEditor();
            return;
          }
        }
      }
      return;
    }

    if (event.key === "Enter" && range.collapsed) {
      event.preventDefault();
      const kind = currentBlock.dataset.mdKind === "bullet"
        ? "bullet"
        : currentBlock.dataset.mdKind === "heading"
          ? "heading"
          : "paragraph";
      const level = Number(currentBlock.dataset.mdLevel || "1");
      const blockText = (currentBlock.textContent ?? "").trim();

      if (kind === "bullet" && blockText.length === 0) {
        currentBlock.dataset.mdKind = "paragraph";
        delete currentBlock.dataset.mdLevel;
        normalizeNotionBlockElement(currentBlock);
        currentBlock.innerHTML = "<br>";
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }

      const nextKind = kind === "bullet" ? "bullet" : "paragraph";
      const trailingRange = range.cloneRange();
      trailingRange.setEnd(currentBlock, currentBlock.childNodes.length);
      const trailingContent = trailingRange.extractContents();

      if (!hasMeaningfulBlockContent(currentBlock)) {
        currentBlock.innerHTML = "<br>";
      }

      const nextBlock = createNotionBlock(nextKind, level);
      nextBlock.innerHTML = "";
      if (trailingContent.childNodes.length > 0) {
        nextBlock.appendChild(trailingContent);
      }
      if (!hasMeaningfulBlockContent(nextBlock)) {
        nextBlock.innerHTML = "<br>";
      }

      if (currentBlock.nextSibling) {
        editor.insertBefore(nextBlock, currentBlock.nextSibling);
      } else {
        editor.appendChild(nextBlock);
      }
      placeCaretAtBlockStart(nextBlock);
      syncDraftFromNotionEditor();
    }
  };

  useEffect(() => {
    if (notePreviewMode !== "live") {
      return;
    }
    const editor = notionEditorRef.current;
    if (!editor) return;

    const hasItemChanged = notionSyncRef.current.itemId !== draft.id;
    const hasMarkdownChanged = notionSyncRef.current.markdown !== draft.contentMarkdown;
    const isFocused = document.activeElement === editor;
    if (!hasItemChanged && !hasMarkdownChanged && isFocused) {
      return;
    }

    editor.innerHTML = markdownToNotionHtml(draft.contentMarkdown || "");
    if (editor.children.length === 0) {
      editor.appendChild(createNotionBlock("paragraph"));
    }
    notionSyncRef.current = { itemId: draft.id, markdown: draft.contentMarkdown };
  }, [draft.contentMarkdown, draft.id, notePreviewMode]);

  useEffect(() => {
    return () => {
      for (const blobUrl of inlineImageBlobUrlCacheRef.current.values()) {
        URL.revokeObjectURL(blobUrl);
      }
      inlineImageBlobUrlCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (notePreviewMode !== "live") {
      return;
    }
    const editor = notionEditorRef.current;
    if (!editor) {
      return;
    }

    const imageNodes = Array.from(editor.querySelectorAll("img.va-md-img[data-md-src]")) as HTMLImageElement[];
    if (imageNodes.length === 0) {
      return;
    }

    const itemByPath = new Map(
      items
        .filter((item) => item.kind !== "folder")
        .map((item) => [normalizePath(item.path), item] as const)
    );

    let cancelled = false;
    const inflightByItemId = new Map<string, Promise<string | null>>();

    const ensureItemImageBlobUrl = (item: ArtifactItem): Promise<string | null> => {
      const cached = inlineImageBlobUrlCacheRef.current.get(item.id);
      if (cached) {
        return Promise.resolve(cached);
      }
      const inflight = inflightByItemId.get(item.id);
      if (inflight) {
        return inflight;
      }
      const loader = artifactsApi
        .downloadFile(item.id, false)
        .then((blob) => {
          if (cancelled) {
            return null;
          }
          const nextBlobUrl = URL.createObjectURL(blob);
          inlineImageBlobUrlCacheRef.current.set(item.id, nextBlobUrl);
          return nextBlobUrl;
        })
        .catch(() => null);
      inflightByItemId.set(item.id, loader);
      return loader;
    };

    void (async () => {
      for (const imageNode of imageNodes) {
        const rawSource = imageNode.dataset.mdSrc?.trim() ?? "";
        if (!rawSource) {
          continue;
        }

        if (isExternalUrl(rawSource)) {
          imageNode.src = rawSource;
          imageNode.classList.remove("va-md-img-loading");
          continue;
        }

        const refSource = rawSource.split("#")[0].trim();
        if (!refSource) {
          imageNode.classList.remove("va-md-img-loading");
          continue;
        }

        const resolvedPath = normalizePath(resolveMarkdownRef(draft.path, refSource));
        const target = itemByPath.get(resolvedPath);
        if (!target) {
          imageNode.classList.remove("va-md-img-loading");
          continue;
        }

        const isImageTarget =
          (target.mimeType ?? "").toLowerCase().startsWith("image/") ||
          /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(target.path);
        if (!isImageTarget) {
          imageNode.classList.remove("va-md-img-loading");
          continue;
        }

        const blobUrl = await ensureItemImageBlobUrl(target);
        if (cancelled || !blobUrl) {
          continue;
        }
        if (!editor.contains(imageNode)) {
          continue;
        }
        imageNode.src = blobUrl;
        imageNode.classList.remove("va-md-img-loading");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draft.contentMarkdown, draft.path, items, notePreviewMode]);

  return {
    editorRef,
    notionEditorRef,
    editSelectionRef,
    liveSelectionRef,
    rememberEditSelection,
    rememberLiveSelection,
    applyDraftInsertion,
    handleEditorKeyDown,
    syncDraftFromNotionEditor,
    handleNotionEditorInput,
    handleNotionEditorPaste,
    handleNotionEditorDrop,
    handleNotionEditorKeyDown
  };
}

