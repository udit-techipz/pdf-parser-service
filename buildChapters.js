function buildChapters(text) {
  const lines = text.split(/\r?\n/);

  // More permissive chapter detection
  const chapterRegex =
    /^(chapter|chap|ch)\s+([0-9]+|[ivxlcdm]+)\b/i;

  const chapters = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue;

    // Handle cases like:
    // CHAPTER
    // I
    if (
      line.toLowerCase() === "chapter" &&
      i + 1 < lines.length &&
      /^[ivxlcdm]+$/i.test(lines[i + 1].trim())
    ) {
      if (current) {
        finalize(current);
        chapters.push(current);
      }

      current = {
        title: `Chapter ${lines[i + 1].trim()}`,
        raw_text: ""
      };

      i++; // skip numeral line
      continue;
    }

    if (chapterRegex.test(line)) {
      if (current) {
        finalize(current);
        chapters.push(current);
      }

      current = {
        title: line,
        raw_text: ""
      };
      continue;
    }

    if (current) {
      current.raw_text += line + "\n";
    }
  }

  if (current) {
    finalize(current);
    chapters.push(current);
  }

  // Fallback
  if (chapters.length <= 1) {
    const words = text.split(/\s+/).length;
    return [{
      chapter_index: 1,
      title: "Full Book",
      raw_text: text,
      word_count: words,
      estimated_minutes: Math.ceil(words / 160)
    }];
  }

  return chapters.map((c, i) => ({
    chapter_index: i + 1,
    title: c.title,
    raw_text: c.raw_text.trim(),
    word_count: c.raw_text.split(/\s+/).length,
    estimated_minutes: Math.ceil(
      c.raw_text.split(/\s+/).length / 160
    )
  }));
}

function finalize(chapter) {
  chapter.raw_text = chapter.raw_text.trim();
}

module.exports = { buildChapters };
