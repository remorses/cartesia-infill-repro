# Cartesia Infill Repro

Reproduce Cartesia infill audio quality issues.

## Setup

```bash
# Install bun
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Add your API key
echo "CARTESIA_KEY=your-api-key" > .env

# Add an audio file
cp /path/to/audio.mp3 scripts/example-recording.mp3

# Run
bun scripts/test-infill.ts
```

## Output

Results are saved to `scripts/infill-test/` with:
- `*-left.wav` - Left context audio
- `*-right.wav` - Right context audio  
- `*-generated.wav` - Infilled audio
- `*-final.wav` - Combined result
