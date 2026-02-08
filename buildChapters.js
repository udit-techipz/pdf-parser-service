function buildChapters(text) {
  const normalized = text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = normalized.split(" ");
  const WORDS_PER_CHAPTER = 500;

  const chapters = [];
  let start = 0;
  let index = 1;

  while (start < words.length) {
    const chunk = words.slice(start, start + WORDS_PER_CHAPTER);
    const raw_text = chunk.join(" ");
    const word_count = chunk.length;

    chapters.push({
      chapter_index: index,
      title: `Chapter ${index}`,
      raw_text,
      word_count,
      estimated_minutes: Math.ceil(word_count / 160)
    });

    start += WORDS_PER_CHAPTER;
    index++;
  }

  return chapters;
}

module.exports = { buildChapters };
