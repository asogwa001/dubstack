# DubStack

DubStack is a browser-based video dubbing tool that runs entirely offline. It uses lightweight TTS models in ONNX format executed on WebAssembly backends, enabling fast, privacy-focused video dubbing without server dependencies.

This project evolved from [dubstack0](https://github.com/asogwa001/dubstack0), which used a traditional client-server architecture.

## Demo

A live version is hosted at https://dubstack.tooling.com.ng/

> **Note**: The first dubbing session may be slow as it downloads and caches assets. After initial load, a service worker caches all assets indefinitely, making subsequent sessions instant and fully offline-capable

## Features

- **Fully Browser-Based**: No server required - all processing happens locally
- **Offline Capable**: Works without internet once assets are loaded
- **ONNX Runtime**: Lightweight TTS models run efficiently via WebAssembly
- **Custom Video Backgrounds**: Add your own video templates for dubbing
- **Self-Hostable**: Complete control over models and assets

## Self-Hosting

DubStack runs entirely in the browser, but requires hosting for static assets. Models are loaded from Hugging Face, while video assets and model configurations can be hosted on your own storage.

### Environment Variables

Create a `.env` file in the project root with a single variable:

```env
VITE_PUBLIC_BASE_URL=https://your-remote-storage.com/public
```

> **Note**: This URL can point to a local directory during development or a remote storage bucket for production. All assets (models, videos, and TTS model files) must be self-hosted as Hugging Face does not include CORS headers required for browser-based loading.

### Public Assets Structure

The `VITE_PUBLIC_BASE_URL` should point to a directory with the following layout:

```
public/
├── models/
│   ├── models.json
│   └── supertonic/
│       ├── config.json
│       ├── model.onnx
│       ├── tokenizer.json
│       └── (other model files...)
└── videos/
    ├── subway_surf_1.mp4
    ├── subway_surf_1_preview.mp4
    ├── another_video.mp4
    ├── another_video_preview.mp4
    └── videos.json
```

> **Example**: The `public/` directory in this repository demonstrates this exact layout.

**Important**: All assets must be self-hosted with proper CORS headers enabled. The Supertonic model files must be downloaded from [Hugging Face](https://huggingface.co/Supertone/supertonic/tree/main) and placed in the `public/models/supertonic/` directory, maintaining the original file structure.

### Video Assets Structure

Inside the `videos/` subdirectory, organize your files as follows:

```
videos/
├── subway_surf_1.mp4
├── subway_surf_1_preview.mp4
├── another_video.mp4
├── another_video_preview.mp4
└── videos.json
```

**Requirements**:
- Each video should have a corresponding preview file (3-5 seconds, no audio)
- Preview files help users quickly browse available templates
- All videos must be documented in `videos.json`

#### videos.json Format

```json
{
  "videos": [
    {
      "id": "a1c2d3e4-0001-4f2e-9eee-b6e4e7dfdd2b",
      "name": "subway_surf_1.mp4",
      "preview": "subway_surf_1_preview.mp4",
      "duration": "03:13",
      "tags": ["subway", "urban"]
    },
    {
      "id": "b2c3d4e5-0002-4f2e-9eee-c7f5f8efe3c",
      "name": "another_video.mp4",
      "preview": "another_video_preview.mp4",
      "duration": "02:45",
      "tags": ["nature", "landscape"]
    }
  ]
}
```

The app uses `videos.json` to discover and display available videos in the gallery.

### Supertonic Model Setup

The Supertonic TTS model must be self-hosted within your `public/models/supertonic/` directory. 

**Setup Steps**:

1. Download the Supertonic model files from [Hugging Face](https://huggingface.co/Supertone/supertonic/tree/main)
2. Place all model files in `public/models/supertonic/`, maintaining the original directory structure
3. Ensure your hosting server includes proper CORS headers to allow browser access

The app automatically locates the Supertonic model at `{VITE_PUBLIC_BASE_URL}/models/supertonic/`.

> **Why self-hosting is required**: Hugging Face does not include CORS headers on their model files, which prevents direct browser-based loading. All assets must be served from a CORS-enabled server.

### TTS Models Configuration

The `models.json` file (located in `public/models/`) lists all available TTS models.

#### models.json Format

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

**Field Descriptions**:
- `id`: Unique identifier for the model
- `name`: Display name shown in the UI
- `status`: Model availability (`active`, `experimental`, etc.)
- `description`: Brief description of model capabilities
- `voiceCloning`: Whether the model supports voice cloning features

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```


## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- Uses [Supertonic TTS](https://huggingface.co/Supertone/supertonic/tree/main) model and [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)