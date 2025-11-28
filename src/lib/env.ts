export const env = {
  ELEVENLABS_KEY: process.env.ELEVENLABS_KEY ?? '',
  CARTESIA_KEY: process.env.CARTESIA_KEY ?? '',
}

if (!env.ELEVENLABS_KEY) {
  console.warn('Warning: ELEVENLABS_KEY not set')
}

if (!env.CARTESIA_KEY) {
  console.warn('Warning: CARTESIA_KEY not set')
}
