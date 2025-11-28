# Cartesia Infill Repro

Reproduce Cartesia infill audio quality issues.

## Setup

```bash
npm install

echo "CARTESIA_KEY=your-api-key" > .env

cp /path/to/audio.mp3 scripts/example-recording.mp3

npm test
```

## Output

Results saved to `scripts/infill-test/`:
- `*-left.wav` - Left context
- `*-right.wav` - Right context  
- `*-gen.wav` - Generated infill
- `*-final.wav` - Combined result
