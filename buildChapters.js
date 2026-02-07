function buildChapters(text) {
  const lines = text.split(/\r?\n/);

  const chapterRegex =
    /^(chapter\s+\d+|chapter\s+[ivxlcdm]+|foreword|introduction|preface|prologue|epilogue)$/i;

  const chapters = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    if (chapterRegex.test(line)) {
      if (current) {
        finalize(current);
        chapters.push(current);
      }

      current = {
        title: line,
        raw_text: "",
      };
    } else if (current) {
      current.raw_text += rawLine + "\n";
    }
  }

  if (current) {
    finalize(current);
    chapters.push(current);
  }

  // Fallback: no chapters detected
  if (chapters.length === 0) {
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
