# DubStack

DubStack is a browser-based video dubbing tool that runs entirely offline. It uses lightweight TTS models in ONNX format executed on WebAssembly backends, enabling fast, privacy-focused video dubbing without server dependencies.

This project evolved from [dubstack0](https://github.com/asogwa001/dubstack0), which used a traditional client-server architecture.

## Demo

A live version is hosted at https://dubstack.tooling.com.ng/

## Features

- **Fully Browser-Based**: No server required - all processing happens locally
- **Offline Capable**: Works without internet once assets are loaded
- **ONNX Runtime**: Lightweight TTS models run efficiently via WebAssembly
- **Custom Video Backgrounds**: Add your own video templates for dubbing
- **Self-Hostable**: Complete control over models and assets

## Self-Hosting

DubStack runs entirely in the browser, but requires hosting for static assets. Models are loaded from Hugging Face, while video assets and model configurations can be hosted on your own storage.

### Environment Variables

Create a `.env` file in the project root with the following variables:

```env
VITE_MODELS_BASE_URL=https://your-remote-storage.com/models
VITE_SUPERTONIC_BASE_URL=https://your-remote-storage.com/supertonic
VITE_VIDEOS_BASE_URL=https://your-remote-storage.com/videos
```

> **Note**: These URLs can point to local directories during development or remote storage buckets for production.

### Video Assets Structure

Inside `VITE_VIDEOS_BASE_URL`, organize your files as follows:

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

### Supertonic Model

The `VITE_SUPERTONIC_BASE_URL` should point to the ONNX format of the Supertonic TTS model. The directory structure must match the original Hugging Face repository layout.

**Options**:
1. **Self-hosted**: Download and host the model files maintaining the original structure
2. **Direct Hugging Face**: Point directly to the repository:
   ```env
   VITE_SUPERTONIC_BASE_URL=https://huggingface.co/SajjadAyoubi/supertonic/resolve/main
   ```

**Reference**: [Supertonic on Hugging Face](https://huggingface.co/SajjadAyoubi/supertonic)

### TTS Models Configuration

The `VITE_MODELS_BASE_URL` points to a storage location containing `models.json`, which lists all available TTS models.

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

## Technology Stack

- **Frontend**: React + TypeScript + Vite
- **TTS Engine**: ONNX Runtime Web
- **Video Processing**: FFmpeg.wasm
- **Runtime**: WebAssembly

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- Based on [dubstack0](https://github.com/asogwa001/dubstack0)
- Uses [Supertonic TTS](https://huggingface.co/SajjadAyoubi/supertonic) model
- Powered by ONNX Runtime and FFmpeg.wasm