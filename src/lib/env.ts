export const env = {
  CARTESIA_KEY: process.env.CARTESIA_KEY ?? '',
}

if (!env.CARTESIA_KEY) {
  console.warn('Warning: CARTESIA_KEY not set')
}
