throw new Error("BUILD_CHAPTERS_LOADED");

function buildChapters(text) {
  const words = text.split(/\s+/);
  const WORDS_PER_CHAPTER = 2200;
console.log("BUILD_CHAPTERS_WORD_COUNT =", words.length);


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
