import { useState, useRef, useCallback, useEffect } from 'react';
import { TTSWorkerClient, VoiceStyle } from './lib/tts/ttsWorkerClient';
import { getFFmpegDubber, DubProgress } from './lib/ffmpeg/dubber';
import { loadAllAssets, AssetCache } from './lib/assetLoader';
import { Mic, Video, Download, Play, Loader2, Volume2, Sparkles, ChevronLeft, ChevronRight, Check, Sliders, Cpu } from 'lucide-react';

import './App.css';

type ProcessingStage = 'idle' | 'loading-assets' | 'generating-audio' | 'processing-video' | 'complete' | 'error';

interface ProcessingState {
  stage: ProcessingStage;
  progress: number;
  message: string;
}

interface VideoItem {
  id: string;
  name: string;
  preview: string;
  duration: string;
  tags: string[];
}

interface VideosData {
  videos: VideoItem[];
}

interface ModelInfo {
  id: string;
  name: string;
  status: 'active' | 'coming_soon';
  description: string;
  voiceCloning: boolean;
}

interface AdvancedSettings {
  speed: number;
  bgVolume: number;
  silenceDuration: number;
  endSilenceDuration: number;
  subtitleFontSize: number;
  subtitleFont: string;
  subtitleFontPath: string;
}

const DEFAULT_SETTINGS: AdvancedSettings = {
  speed: 1.05,
  bgVolume: 0.25,
  silenceDuration: 0.3,
  endSilenceDuration: 0.5,
  subtitleFontSize: 16,
  subtitleFont: 'Arial',
  subtitleFontPath: 'fonts/arial/arial.ttf',
};

function App() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null);
  const [text, setText] = useState('');
  const [selectedVoice, setSelectedVoice] = useState<string>('F1');
  const [selectedModel, setSelectedModel] = useState<string>('supertonic-66m');
  const [availableVoices, setAvailableVoices] = useState<VoiceStyle[]>([]);
  const [availableFonts, setAvailableFonts] = useState<{ name: string, displayName: string, file: string }[]>([]);
  //const [models] = useState<ModelInfo[]>(modelsData.models as ModelInfo[]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<AdvancedSettings>(DEFAULT_SETTINGS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [processing, setProcessing] = useState<ProcessingState>({
    stage: 'idle',
    progress: 0,
    message: '',
  });
  const [outputUrl, setOutputUrl] = useState<string | null>(null);

  const ttsRef = useRef<TTSWorkerClient | null>(null);
  const galleryRef = useRef<HTMLDivElement>(null);

  // Load videos on mount
  useEffect(() => {
    const loadVideos = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_PUBLIC_BASE_URL}/videos/videos.json`);

        const data: VideosData = await response.json();
        setVideos(data.videos);
        if (data.videos.length > 0) {
          setSelectedVideo(data.videos[0]);
        }
      } catch (error) {
        console.error('Failed to load videos:', error);
      }
    };
    loadVideos();
  }, []);

  // Load models on mount
  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_PUBLIC_BASE_URL}/models/models.json`
        );

        if (!response.ok) {
          throw new Error('Failed to load models');
        }

        const data = await response.json();
        setModels(data.models);
      } catch (error) {
        console.error('Failed to load models:', error);
      }
    };

    loadModels();
  }, []);

  // Load fonts on mount
  useEffect(() => {
    const loadFonts = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_PUBLIC_BASE_URL}/fonts/fonts.json`);
        const data = await response.json();
        setAvailableFonts(data.fonts);

        // Find Arial and set it as default if not already set
        const arialFont = data.fonts.find((f: any) => f.name === 'Arial');
        if (arialFont) {
          setSettings(prev => ({
            ...prev,
            subtitleFont: arialFont.name,
            subtitleFontPath: `fonts/${arialFont.file}`
          }));
        }
      } catch (error) {
        console.error('Failed to load fonts:', error);
      }
    };
    loadFonts();
  }, []);

  const handleVideoSelect = useCallback((video: VideoItem) => {
    setSelectedVideo(video);
    setOutputUrl(null);
  }, []);

  const scrollGallery = (direction: 'left' | 'right') => {
    if (galleryRef.current) {
      const scrollAmount = 200;
      galleryRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  const handleProcess = async () => {
    if (!selectedVideo || !text.trim()) return;

    try {
      // Stage 1: Load all assets in parallel
      setProcessing({
        stage: 'loading-assets',
        progress: 0,
        message: 'Loading assets...',
      });

      const assets: AssetCache = await loadAllAssets(
        selectedVideo.name,
        settings.subtitleFontPath,
        (progress, message) => {
          setProcessing({
            stage: 'loading-assets',
            progress,
            message,
          });
        }
      );

      // Initialize TTS worker with pre-fetched assets
      if (!ttsRef.current) {
        ttsRef.current = new TTSWorkerClient();
      }

      if (!ttsRef.current.initialized) {
        await ttsRef.current.init(assets.tts);
        setAvailableVoices(ttsRef.current.getAvailableVoices());
      }

      // Stage 2: Generate audio (runs in Web Worker - UI stays responsive)
      setProcessing({
        stage: 'generating-audio',
        progress: 0,
        message: 'Generating speech...',
      });

      const result = await ttsRef.current.generate(
        {
          text: text.trim(),
          voiceId: selectedVoice,
          speed: settings.speed,
          silenceDuration: settings.silenceDuration,
          endSilenceDuration: settings.endSilenceDuration,
        },
        (message, chunkIndex, totalChunks) => {
          // Progress callback from worker
          const progress = chunkIndex !== undefined && totalChunks !== undefined
            ? Math.round(((chunkIndex + 1) / totalChunks) * 100)
            : 0;
          setProcessing({
            stage: 'generating-audio',
            progress,
            message,
          });
        }
      );

      // Stage 3: Process video with pre-fetched assets
      const dubber = getFFmpegDubber();

      const handleProgress = (progress: DubProgress) => {
        setProcessing({
          stage: 'processing-video',
          progress: progress.progress,
          message: progress.message,
        });
      };

      // Load FFmpeg with pre-fetched assets
      await dubber.load(handleProgress, {
        coreJS: assets.ffmpeg.coreJS,
        coreWasm: assets.ffmpeg.coreWasm,
      });

      setProcessing({
        stage: 'processing-video',
        progress: 0,
        message: 'Processing video...',
      });

      const outputBlob = await dubber.dub({
        videoFile: assets.video!,
        audioData: result.wav,
        sampleRate: result.sampleRate,
        srtContent: result.srt || '',
        bgVolume: settings.bgVolume,
        subtitles: {
          fontSize: settings.subtitleFontSize,
          fontName: settings.subtitleFont,
          fontPath: settings.subtitleFontPath,
        },
        prefetchedFont: assets.font,
      }, handleProgress);

      const url = URL.createObjectURL(outputBlob);
      setOutputUrl(url);

      setProcessing({
        stage: 'complete',
        progress: 100,
        message: 'Video ready!',
      });
    } catch (error) {
      console.error('Processing error:', error);
      setProcessing({
        stage: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'An error occurred',
      });
    }
  };

  const handleDownload = () => {
    if (outputUrl && selectedVideo) {
      const a = document.createElement('a');
      a.href = outputUrl;
      a.download = `dubbed_${selectedVideo.name}`;
      a.click();
    }
  };

  const updateSetting = <K extends keyof AdvancedSettings>(key: K, value: AdvancedSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const isProcessing = processing.stage !== 'idle' && processing.stage !== 'complete' && processing.stage !== 'error';

  return (
    <div className="app">
      <div className="app-bg" />

      <header className="header">
        <div className="logo">
          <Sparkles className="logo-icon" />
          <h1>Dubstack</h1>
        </div>
        <p className="tagline">AI-Powered Video Dubbing • 100% Browser-based • <a target="_blank" href="https://github.com/asogwa001/dubstack">Source Code</a></p>
      </header>

      <main className="main-content">
        <div className="panel video-panel">
          <h2><Video size={20} /> Video Library</h2>

          <div className="gallery-container">
            <button className="gallery-arrow left" onClick={() => scrollGallery('left')}>
              <ChevronLeft size={20} />
            </button>

            <div className="video-gallery" ref={galleryRef}>
              {videos.map((video) => (
                <div
                  key={video.id}
                  className={`video-card ${selectedVideo?.id === video.id ? 'selected' : ''}`}
                  onClick={() => handleVideoSelect(video)}
                >
                  <div className="video-card-preview">
                    <video
                      //src={getVideoPath(video.url)}
                      src={`${import.meta.env.VITE_PUBLIC_BASE_URL}/videos/${video.preview}`}
                      //loop
                      muted
                      autoPlay
                      playsInline
                    />
                    {selectedVideo?.id === video.id && (
                      <div className="video-card-check">
                        <Check size={20} />
                      </div>
                    )}
                  </div>
                  <div className="video-card-info">
                    <span className="video-card-duration">{video.duration}</span>
                  </div>
                </div>
              ))}
            </div>

            <button className="gallery-arrow right" onClick={() => scrollGallery('right')}>
              <ChevronRight size={20} />
            </button>
          </div>

          {selectedVideo && (
            <div className="selected-video-preview">
              <video
                //src={getVideoPath(selectedVideo.url)}
                src={`${import.meta.env.VITE_PUBLIC_BASE_URL}/videos/${selectedVideo.preview}`}
                loop
                muted
                autoPlay
                playsInline
              />
            </div>
          )}
        </div>

        <div className="panel text-panel">
          <h2><Mic size={20} /> Script</h2>

          <textarea
            className="script-input"
            placeholder="Enter the text you want to dub over the video..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isProcessing}
          />

          <div className="controls">
            <div className="control-group">
              <label><Cpu size={16} /> Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isProcessing}
              >
                {models.map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    disabled={model.status !== 'active'}
                  >
                    {model.name} {model.status === 'coming_soon' ? '(Soon)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="control-group">
              <label><Volume2 size={16} /> Voice</label>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                disabled={isProcessing}
              >
                {availableVoices.length > 0 ? (
                  availableVoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                    </option>
                  ))
                ) : (
                  <>
                    <option value="F1">Ava</option>
                    <option value="F2">Sophia</option>
                    <option value="F3">Isabella</option>
                    <option value="F4">Mia</option>
                    <option value="F5">Luna</option>
                    <option value="M1">Liam</option>
                    <option value="M2">Ethan</option>
                    <option value="M3">Noah</option>
                    <option value="M4">Lucas</option>
                    <option value="M5">Oliver</option>
                  </>
                )}
              </select>
            </div>
          </div>

          <button
            className="advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <Sliders size={16} />
            {showAdvanced ? 'Hide Advanced' : 'Advanced Settings'}
          </button>

          {showAdvanced && (
            <div className="advanced-settings">
              <div className="setting-row">
                <label>Speed: {settings.speed.toFixed(2)}x</label>
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={settings.speed}
                  onChange={(e) => updateSetting('speed', parseFloat(e.target.value))}
                  disabled={isProcessing}
                />
              </div>

              <div className="setting-row">
                <label>BG Volume: {(settings.bgVolume * 100).toFixed(0)}%</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={settings.bgVolume}
                  onChange={(e) => updateSetting('bgVolume', parseFloat(e.target.value))}
                  disabled={isProcessing}
                />
              </div>

              <div className="setting-row">
                <label>Line Gap: {settings.silenceDuration.toFixed(1)}s</label>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.1"
                  value={settings.silenceDuration}
                  onChange={(e) => updateSetting('silenceDuration', parseFloat(e.target.value))}
                  disabled={isProcessing}
                />
              </div>

              <div className="setting-row">
                <label>End Silence: {settings.endSilenceDuration.toFixed(1)}s</label>
                <input
                  type="range"
                  min="0"
                  max="2.0"
                  step="0.1"
                  value={settings.endSilenceDuration}
                  onChange={(e) => updateSetting('endSilenceDuration', parseFloat(e.target.value))}
                  disabled={isProcessing}
                />
              </div>

              <div className="setting-row">
                <label>Subtitle Size: {settings.subtitleFontSize}px</label>
                <input
                  type="range"
                  min="10"
                  max="32"
                  step="1"
                  value={settings.subtitleFontSize}
                  onChange={(e) => updateSetting('subtitleFontSize', parseInt(e.target.value))}
                  disabled={isProcessing}
                />
              </div>

              <div className="setting-row">
                <label><Sparkles size={16} /> Font</label>
                <select
                  value={settings.subtitleFont}
                  onChange={(e) => {
                    const font = availableFonts.find(f => f.name === e.target.value);
                    if (font) {
                      setSettings(prev => ({
                        ...prev,
                        subtitleFont: font.name,
                        subtitleFontPath: `fonts/${font.file}`
                      }));
                    }
                  }}
                  disabled={isProcessing}
                >
                  {availableFonts.map((font) => (
                    <option key={font.name} value={font.name}>
                      {font.displayName}
                    </option>
                  ))}
                  {availableFonts.length === 0 && <option value="Arial">Arial</option>}
                </select>
              </div>
            </div>
          )}

          <button
            className="process-btn"
            onClick={handleProcess}
            disabled={!selectedVideo || !text.trim() || isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 className="spin" size={20} />
                {processing.message}
              </>
            ) : (
              <>
                <Play size={20} />
                Generate Dubbed Video
              </>
            )}
          </button>

          {isProcessing && (
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${processing.progress}%` }}
              />
            </div>
          )}

          {processing.stage === 'error' && (
            <div className="error-message">
              ⚠️ {processing.message}
            </div>
          )}
        </div>

        <div className="panel output-panel">
          <h2><Download size={20} /> Output</h2>

          {outputUrl ? (
            <>
              <div className="output-video-container">
                <video
                  src={outputUrl}
                  className="output-preview"
                  controls
                />
              </div>
              <button className="download-btn" onClick={handleDownload}>
                <Download size={20} />
                Download Video
              </button>
            </>
          ) : (
            <div className="output-placeholder">
              <Video size={64} />
              <p>Your dubbed video will appear here</p>
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <p>Powered by WASM• No data leaves your browser</p>
      </footer>
    </div>
  );
}

export default App;
