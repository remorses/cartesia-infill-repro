import * as fs from 'node:fs'
import * as path from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { CartesiaClient } from '@cartesia/cartesia-js'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { env } from '../src/lib/env'
import type { Word } from '../src/lib/editor-types'
import { mergeSpacesWithFollowingWords } from '../src/lib/retext'
import { moveToSilence } from '../src/lib/web-audio-api'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const storage = createStorage({
  driver: fsDriver({
    base: path.join(process.cwd(), 'scripts', 'cache'),
  }),
})

const cartesia = new CartesiaClient({
  apiKey: env.CARTESIA_KEY,
})

async function getWordTimestamps({ audioPath }: { audioPath: string }): Promise<Word[]> {
  const cacheKey = `timestamps:${path.basename(audioPath)}`

  const cached = await storage.getItem<Word[]>(cacheKey)
  if (cached) {
    console.log(`Using cached timestamps for ${audioPath}`)
    return cached
  }

  console.log(`Fetching timestamps for ${audioPath}...`)
  const file = Bun.file(audioPath)

  const transcription = await cartesia.stt.transcribe(file, {
    model: 'ink-whisper',
    language: 'en',
    timestampGranularities: ['word'],
  })

  const chunks: Word[] = transcription.words?.map((w) => {
    return {
      type: 'word',
      attrs: {
        value: w.word,
        startInSeconds: w.start,
        duration: w.end - w.start,
        videoSource: `video-${path.basename(audioPath)}` as const,
        audioSource: `video-${path.basename(audioPath)}` as const,
        audioStartInSeconds: w.start,
      },
    }
  }) ?? []

  const mergedChunks = mergeSpacesWithFollowingWords({ words: chunks })

  await storage.setItem(cacheKey, mergedChunks)
  console.log(`Cached ${mergedChunks.length} words`)

  return mergedChunks
}

async function extractAudioSegment({
  audioPath,
  startInSeconds,
  endInSeconds,
  format = 'mp3',
  channels = 1,
}: {
  audioPath: string
  startInSeconds: number
  endInSeconds: number
  format?: 'mp3' | 'wav'
  channels?: 1 | 2
}): Promise<Buffer> {
  const outputPath = path.join(
    process.cwd(),
    'scripts',
    'temp',
    `segment-${Date.now()}-${Math.random()}.${format}`
  )

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const duration = endInSeconds - startInSeconds
  const codec = format === 'wav'
    ? '-c:a pcm_s16le'
    : '-c:a libmp3lame -b:a 128k'

  await execAsync(
    `ffmpeg -y -i "${audioPath}" -ss ${startInSeconds} -t ${duration} -ar 44100 -ac ${channels} ${codec} "${outputPath}"`
  )

  const audioBuffer = fs.readFileSync(outputPath)
  fs.unlinkSync(outputPath)

  return audioBuffer
}

async function joinAudioFiles({
  files,
  outputPath,
}: {
  files: string[]
  outputPath: string
}): Promise<void> {
  const listPath = path.join(path.dirname(outputPath), `list-${Date.now()}.txt`)
  const listContent = files.map((f) => {
    return `file '${f}'`
  }).join('\n')

  fs.writeFileSync(listPath, listContent)

  await execAsync(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -ar 44100 -ac 1 -c:a pcm_s16le "${outputPath}"`
  )

  fs.unlinkSync(listPath)
}



function sanitizeFolderName({ text }: { text: string }): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
}

async function evaluateInfill({
  audioPath,
  words,
  startIndex,
  leftWordCount,
  middleWordCount,
  rightWordCount,
  voiceId,
}: {
  audioPath: string
  words: Word[]
  startIndex: number
  leftWordCount: number
  middleWordCount: number
  rightWordCount: number
  voiceId: string
}): Promise<void> {
  const leftWords = words.slice(startIndex, startIndex + leftWordCount)
  const middleWords = words.slice(startIndex + leftWordCount, startIndex + leftWordCount + middleWordCount)
  const rightWords = words.slice(startIndex + leftWordCount + middleWordCount, startIndex + leftWordCount + middleWordCount + rightWordCount)

  const middleText = middleWords.map((w) => { return w.attrs.value }).join('')

  console.log('\n---')
  console.log('Middle words (to infill):', middleText)

  const audioBasename = path.basename(audioPath, path.extname(audioPath))
  const prefix = '_' + sanitizeFolderName({ text: middleText })
  const outputDir = path.join(process.cwd(), 'scripts', 'infill-test', audioBasename)

  const finalPath = path.join(outputDir, `${prefix}-final.wav`)
  if (fs.existsSync(finalPath)) {
    console.log(`Skipping (already exists): ${prefix}`)
    return
  }

  fs.mkdirSync(outputDir, { recursive: true })

  let leftStart = leftWords[0].attrs.startInSeconds
  const lastLeftWord = leftWords[leftWords.length - 1]
  let leftEnd = lastLeftWord.attrs.startInSeconds + lastLeftWord.attrs.duration
  let rightStart = rightWords[0].attrs.startInSeconds
  const lastRightWord = rightWords[rightWords.length - 1]
  let rightEnd = lastRightWord.attrs.startInSeconds + lastRightWord.attrs.duration

  const audioFileBuffer = fs.readFileSync(audioPath)
  const audioArrayBuffer = audioFileBuffer.buffer.slice(
    audioFileBuffer.byteOffset,
    audioFileBuffer.byteOffset + audioFileBuffer.byteLength
  )

  const adjustedLeftEnd = await moveToSilence({
    buffer: audioArrayBuffer,
    timestamp: leftEnd,
  })

  const adjustedRightStart = await moveToSilence({
    buffer: audioArrayBuffer,
    timestamp: rightStart,
  })

  if (adjustedLeftEnd !== leftEnd) {
    console.log(`Adjusted left end: ${leftEnd.toFixed(3)}s -> ${adjustedLeftEnd.toFixed(3)}s`)
    leftEnd = adjustedLeftEnd
  }

  if (adjustedRightStart !== rightStart) {
    console.log(`Adjusted right start: ${rightStart.toFixed(3)}s -> ${adjustedRightStart.toFixed(3)}s`)
    rightStart = adjustedRightStart
  }

  const leftBuffer = await extractAudioSegment({
    audioPath,
    startInSeconds: leftStart,
    endInSeconds: leftEnd,
    format: 'wav',
    channels: 1,
  })

  const rightBuffer = await extractAudioSegment({
    audioPath,
    startInSeconds: rightStart,
    endInSeconds: rightEnd,
    format: 'wav',
    channels: 1,
  })

  const leftPath = path.join(outputDir, `${prefix}-left.wav`)
  const rightPath = path.join(outputDir, `${prefix}-right.wav`)
  const generatedPath = path.join(outputDir, `${prefix}-generated.wav`)

  fs.writeFileSync(leftPath, leftBuffer)
  fs.writeFileSync(rightPath, rightBuffer)

  const leftStream = Readable.from(leftBuffer) as fs.ReadStream
  const rightStream = Readable.from(rightBuffer) as fs.ReadStream

  const response = await cartesia.infill.bytes(
    leftStream,
    rightStream,
    {
      modelId: 'sonic-2',
      language: 'en',
      transcript: middleText,
      voiceId,
      outputFormatContainer: 'wav',
      outputFormatEncoding: "pcm_s16le",
      outputFormatSampleRate: 44100,
    }
  )

  const generatedBuffer = await buffer(response)

  fs.writeFileSync(generatedPath, generatedBuffer)

  await joinAudioFiles({
    files: [leftPath, generatedPath, rightPath],
    outputPath: finalPath,
  })

  console.log(`Saved: ${prefix}`)
}

async function extractWordsToFolder({
  audioPath,
  words,
}: {
  audioPath: string
  words: Word[]
}): Promise<void> {
  const audioBasename = path.basename(audioPath, path.extname(audioPath))
  const wordsDir = path.join(process.cwd(), 'scripts', 'infill-test', audioBasename, 'words')

  if (fs.existsSync(wordsDir)) {
    console.log(`Words folder already exists: ${wordsDir}`)
    return
  }

  fs.mkdirSync(wordsDir, { recursive: true })

  console.log(`Extracting ${words.length} words to ${wordsDir}...`)

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const wordBuffer = await extractAudioSegment({
      audioPath,
      startInSeconds: word.attrs.startInSeconds,
      endInSeconds: word.attrs.startInSeconds + word.attrs.duration,
    })

    const wordPath = path.join(wordsDir, `${i}.mp3`)
    fs.writeFileSync(wordPath, wordBuffer)
  }

  console.log(`Extracted ${words.length} words`)
}

async function main() {
  const audioPath = path.join(process.cwd(), 'scripts', 'example-recording.mp3')

  const words = await getWordTimestamps({ audioPath })

  console.log(`Total words: ${words.length}`)

  await extractWordsToFolder({ audioPath, words })

  const leftWordCount = 6
  const middleWordCount = 3
  const rightWordCount = 6

  const totalNeeded = leftWordCount + middleWordCount + rightWordCount

  if (words.length < totalNeeded) {
    throw new Error(`Not enough words. Need ${totalNeeded}, got ${words.length}`)
  }

  console.log('Cloning voice...')

  const firstLeftWords = words.slice(0, leftWordCount)
  const firstLeftStart = firstLeftWords[0].attrs.startInSeconds
  const lastFirstLeftWord = firstLeftWords[firstLeftWords.length - 1]
  const firstLeftEnd = lastFirstLeftWord.attrs.startInSeconds + lastFirstLeftWord.attrs.duration

  const voiceBuffer = await extractAudioSegment({
    audioPath,
    startInSeconds: firstLeftStart,
    endInSeconds: firstLeftEnd,
  })

  const audioStream = Readable.from(voiceBuffer) as fs.ReadStream

  const clonedVoice = await cartesia.voices.clone(
    audioStream,
    {
      name: `test-voice-${Date.now()}`,
      description: 'Test voice for infill evaluation',
      language: 'en',
      mode: 'stability',
    }
  )

  console.log(`Voice cloned: ${clonedVoice.id}`)

  const evaluationCount = 10
  const step = Math.floor((words.length - totalNeeded) / evaluationCount)

  console.log(`Generating ${evaluationCount} evaluations...`)

  for (let i = 0; i < evaluationCount; i++) {
    const startIndex = i * step
    if (startIndex + totalNeeded > words.length) break

    await evaluateInfill({
      audioPath,
      words,
      startIndex,
      leftWordCount,
      middleWordCount,
      rightWordCount,
      voiceId: clonedVoice.id,
    })
  }

  console.log('\nEvaluation complete!')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
