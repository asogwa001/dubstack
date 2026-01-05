# DubStack

Browser-based video dubbing tool that runs entirely offline using lightweight TTS models in ONNX format via WebAssembly.

Evolved from [dubstack0](https://github.com/asogwa001/dubstack0) (client-server architecture).

**Demo**: https://dubstack.tooling.com.ng/

> **Note**: First session downloads and caches assets. Service worker enables instant, fully offline subsequent sessions.

## Features

- **Fully Browser-Based**: All processing happens locally
- **Offline Capable**: Works without internet after initial load
- **ONNX Runtime**: Efficient TTS via WebAssembly
- **Custom Video Backgrounds**: Add your own templates
- **Self-Hostable**: Complete control over models and assets

## Self-Hosting

### Environment Variables

Create `.env` in project root:

```env
VITE_PUBLIC_BASE_URL=https://your-remote-storage.com/public
```

Points to local directory (development) or remote storage (production). **All assets must be self-hosted with CORS headers** — Hugging Face doesn't include them.

### Asset Structure

```
public/
├── models/
│   ├── models.json
│   └── supertonic/
│       ├── config.json
│       ├── model.onnx
│       ├── tokenizer.json
│       └── ...
└── videos/
    ├── subway_surf_1.mp4
    ├── subway_surf_1_preview.mp4
    └── videos.json
```

### Supertonic Model Setup

1. Download from [Hugging Face](https://huggingface.co/Supertone/supertonic/tree/main)
2. Place in `public/models/supertonic/` maintaining structure
3. Ensure CORS headers enabled on your server

### videos.json

```json
{
  "videos": [
    {
      "id": "a1c2d3e4-0001-4f2e-9eee-b6e4e7dfdd2b",
      "name": "subway_surf_1.mp4",
      "preview": "subway_surf_1_preview.mp4",
      "duration": "03:13",
      "tags": ["subway", "urban"]
    }
  ]
}
```

**Requirements**: Each video needs a 3-5 second preview (no audio).

### models.json

```json
{
  "models": [
    {
      "id": "supertonic-66m",
      "name": "Supertonic 66M",
      "status": "active",
      "description": "Fast, lightweight TTS model",
      "voiceCloning": false
    }
  ]
}
```

## Development

```bash
npm install
npm run dev
npm run build
```

## Acknowledgments

[Supertonic TTS](https://huggingface.co/Supertone/supertonic/tree/main) | [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)