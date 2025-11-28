import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CartesiaClient } from '@cartesia/cartesia-js'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const cartesia = new CartesiaClient({
  apiKey: process.env.CARTESIA_KEY,
})

interface Word {
  word: string
  start: number
  end: number
}

async function getWordTimestamps(audioPath: string): Promise<Word[]> {
  const cacheFile = audioPath + '.words.json'
  
  if (fs.existsSync(cacheFile)) {
    console.log('Using cached timestamps')
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
  }

  console.log('Fetching timestamps...')
  const file = fs.createReadStream(audioPath)

  const transcription = await cartesia.stt.transcribe(file, {
    model: 'ink-whisper',
    language: 'en',
    timestampGranularities: ['word'],
  })

  const words = transcription.words ?? []
  fs.writeFileSync(cacheFile, JSON.stringify(words, null, 2))
  console.log(`Cached ${words.length} words`)

  return words
}

async function extractSegment(audioPath: string, start: number, end: number, outPath: string): Promise<void> {
  const duration = end - start
  await execAsync(
    `ffmpeg -y -i "${audioPath}" -ss ${start} -t ${duration} -ar 44100 -ac 1 -c:a pcm_s16le "${outPath}"`
  )
}

async function joinAudio(files: string[], outPath: string): Promise<void> {
  // Use acrossfade filter to blend audio segments
  const crossfadeMs = 50
  const [left, gen, right] = files
  
  // Crossfade left+gen, then result+right
  await execAsync(
    `ffmpeg -y -i "${left}" -i "${gen}" -i "${right}" -filter_complex \
    "[0][1]acrossfade=d=${crossfadeMs / 1000}:c1=tri:c2=tri[a01]; \
     [a01][2]acrossfade=d=${crossfadeMs / 1000}:c1=tri:c2=tri[out]" \
    -map "[out]" -ar 44100 -ac 1 -c:a pcm_s16le "${outPath}"`
  )
}

async function testInfill(
  audioPath: string,
  words: Word[],
  startIdx: number,
  leftCount: number,
  middleCount: number,
  rightCount: number,
  voiceId: string,
  outDir: string,
  index: number
): Promise<void> {
  const leftWords = words.slice(startIdx, startIdx + leftCount)
  const middleWords = words.slice(startIdx + leftCount, startIdx + leftCount + middleCount)
  const rightWords = words.slice(startIdx + leftCount + middleCount, startIdx + leftCount + middleCount + rightCount)

  const leftText = leftWords.map(w => w.word).join(' ')
  const middleText = middleWords.map(w => w.word).join(' ')
  const rightText = rightWords.map(w => w.word).join(' ')
  const fullText = leftText + middleText + rightText

  const toSlug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const prefix = String(index).padStart(3, '0')

  console.log(`\n[${prefix}] Infilling: "${middleText}"`)

  const leftStart = leftWords[0].start
  const leftEnd = leftWords[leftWords.length - 1].end
  const rightStart = rightWords[0].start
  const rightEnd = rightWords[rightWords.length - 1].end

  const leftPath = path.join(outDir, `${prefix}-left-${toSlug(leftText)}.wav`)
  const rightPath = path.join(outDir, `${prefix}-right-${toSlug(rightText)}.wav`)
  const genPath = path.join(outDir, `${prefix}-gen-${toSlug(middleText)}.wav`)
  const finalPath = path.join(outDir, `${prefix}-final-${toSlug(fullText)}.wav`)

  if (fs.existsSync(finalPath)) {
    console.log('Skipping (exists)')
    return
  }

  await extractSegment(audioPath, leftStart, leftEnd, leftPath)
  await extractSegment(audioPath, rightStart, rightEnd, rightPath)

  const leftStream = fs.createReadStream(leftPath)
  const rightStream = fs.createReadStream(rightPath)

  const response = await cartesia.infill.bytes(leftStream, rightStream, {
    modelId: 'sonic-2',
    language: 'en',
    transcript: middleText,
    voiceId,
    outputFormatContainer: 'wav',
    outputFormatEncoding: 'pcm_s16le',
    outputFormatSampleRate: 44100,
  })

  const genBuffer = await buffer(response)
  fs.writeFileSync(genPath, genBuffer)

  await joinAudio([leftPath, genPath, rightPath], finalPath)
  console.log(`Saved: ${finalPath}`)
}

async function main() {
  const audioPath = path.join(process.cwd(), 'scripts', 'example-recording.mp3')
  const outDir = path.join(process.cwd(), 'scripts', 'infill-test')
  fs.mkdirSync(outDir, { recursive: true })

  const words = await getWordTimestamps(audioPath)
  console.log(`Total words: ${words.length}`)

  const leftCount = 6
  const middleCount = 3
  const rightCount = 6
  const total = leftCount + middleCount + rightCount

  if (words.length < total) {
    throw new Error(`Need ${total} words, got ${words.length}`)
  }

  // Clone voice from first segment
  console.log('Cloning voice...')
  const voiceStart = words[0].start
  const voiceEnd = words[Math.min(20, words.length - 1)].end
  const voicePath = path.join(outDir, 'voice-sample.wav')
  await extractSegment(audioPath, voiceStart, voiceEnd, voicePath)

  const voiceStream = fs.createReadStream(voicePath)
  const voice = await cartesia.voices.clone(voiceStream, {
    name: `test-${Date.now()}`,
    description: 'Test voice',
    language: 'en',
    mode: 'stability',
  })
  console.log(`Voice cloned: ${voice.id}`)

  // Test infill at different positions
  const testCount = 5
  const step = Math.floor((words.length - total) / testCount)

  for (let i = 0; i < testCount; i++) {
    const startIdx = i * step
    await testInfill(audioPath, words, startIdx, leftCount, middleCount, rightCount, voice.id, outDir, i + 1)
  }

  console.log('\nDone!')
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
