import type { Word } from './editor-types'

/**
 * Merges space-only words with the following word
 */
export function mergeSpacesWithFollowingWords({ words }: { words: Word[] }): Word[] {
  const result: Word[] = []
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const isSpaceOnly = word.attrs.value.trim() === ''
    
    if (isSpaceOnly && i + 1 < words.length) {
      // Skip space-only words, the space will be prepended to the next word
      const nextWord = words[i + 1]
      words[i + 1] = {
        ...nextWord,
        attrs: {
          ...nextWord.attrs,
          value: word.attrs.value + nextWord.attrs.value,
          startInSeconds: word.attrs.startInSeconds,
          duration: nextWord.attrs.duration + word.attrs.duration,
          audioStartInSeconds: word.attrs.audioStartInSeconds,
        },
      }
    } else if (!isSpaceOnly) {
      result.push(word)
    }
  }
  
  return result
}
