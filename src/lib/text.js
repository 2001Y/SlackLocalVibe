const MAX_TEXT = 3800;

function splitText(text, maxLen = MAX_TEXT) {
  if (!text) return [""];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let slice = safeSlice(remaining, maxLen);
    let cutIndex = findCutIndex(slice);
    if (cutIndex <= 0 || cutIndex > slice.length) {
      cutIndex = slice.length;
    }
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findCutIndex(slice) {
  const boundaries = ["\n\n", "\n", " "];
  for (const boundary of boundaries) {
    const idx = slice.lastIndexOf(boundary);
    if (idx > 0) {
      return idx + boundary.length;
    }
  }
  return slice.length;
}

function safeSlice(text, maxLen) {
  let slice = text.slice(0, maxLen);
  if (slice.length === 0) return slice;
  const lastChar = slice.charCodeAt(slice.length - 1);
  if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
    slice = slice.slice(0, -1);
  }
  return slice;
}

function numberedChunks(text, maxLen = MAX_TEXT) {
  const tempChunks = splitText(text, maxLen);
  if (tempChunks.length <= 1) return tempChunks;

  const total = tempChunks.length;
  const prefixLen = `(${total}/${total}) `.length;
  const chunks = splitText(text, maxLen - prefixLen);
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length}) ${chunk}`);
}

module.exports = {
  MAX_TEXT,
  splitText,
  numberedChunks,
};
