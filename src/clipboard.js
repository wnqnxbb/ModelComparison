export async function copyResultContent(
  result,
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document
) {
  const text = String(result?.content ?? "");
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  if (!documentRef?.body || !documentRef.createElement || !documentRef.execCommand) {
    throw new Error("当前环境不支持剪贴板复制");
  }

  const textarea = documentRef.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  documentRef.body.appendChild(textarea);
  textarea.select();

  try {
    documentRef.execCommand("copy");
  } finally {
    textarea.remove();
  }
}
