/**
 * Centralized Asset Loader
 * Fetches all required assets (TTS models, FFmpeg WASM, video, fonts) in parallel
 */

import { toBlobURL } from '@ffmpeg/util';

// TTS Config interface matching supertonic.ts
export interface TTSConfig {
    ae: {
        sample_rate: number;
        base_chunk_size: number;
    };
    ttl: {
        chunk_compress_factor: number;
        latent_dim: number;
    };
}

export interface TTSAssets {
    config: TTSConfig;
    unicodeIndexer: Record<string, number>;
    dpModel: ArrayBuffer;
    textEncModel: ArrayBuffer;
    vectorEstModel: ArrayBuffer;
    vocoderModel: ArrayBuffer;
}

export interface FFmpegAssets {
    coreJS: string; // Blob URL
    coreWasm: string; // Blob URL
}

export interface AssetCache {
    tts: TTSAssets;
    ffmpeg: FFmpegAssets;
    video?: Blob;
    font?: ArrayBuffer;
}

export type ProgressCallback = (progress: number, message: string) => void;

// Singleton cache to avoid re-fetching
let cachedAssets: Partial<AssetCache> = {};

/**
 * Fetch a resource and track progress
 */
async function fetchWithProgress(url: string): Promise<Response> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    }
    return response;
}

/**
 * Load all TTS assets in parallel
 */
async function loadTTSAssets(basePath: string): Promise<TTSAssets> {
    if (cachedAssets.tts) {
        console.log('[AssetLoader] Using cached TTS assets');
        return cachedAssets.tts;
    }

    console.log('[AssetLoader] Loading TTS assets...');

    const [configRes, indexerRes, dpModel, textEncModel, vectorEstModel, vocoderModel] = 
        await Promise.all([
            fetchWithProgress(`${basePath}/onnx/tts.json`),
            fetchWithProgress(`${basePath}/onnx/unicode_indexer.json`),
            fetchWithProgress(`${basePath}/onnx/duration_predictor.onnx`).then(r => r.arrayBuffer()),
            fetchWithProgress(`${basePath}/onnx/text_encoder.onnx`).then(r => r.arrayBuffer()),
            fetchWithProgress(`${basePath}/onnx/vector_estimator.onnx`).then(r => r.arrayBuffer()),
            fetchWithProgress(`${basePath}/onnx/vocoder.onnx`).then(r => r.arrayBuffer()),
        ]);

    const ttsAssets: TTSAssets = {
        config: await configRes.json(),
        unicodeIndexer: await indexerRes.json(),
        dpModel,
        textEncModel,
        vectorEstModel,
        vocoderModel,
    };

    cachedAssets.tts = ttsAssets;
    console.log('[AssetLoader] TTS assets loaded');
    return ttsAssets;
}

/**
 * Load FFmpeg WASM assets in parallel
 */
async function loadFFmpegAssets(): Promise<FFmpegAssets> {
    if (cachedAssets.ffmpeg) {
        console.log('[AssetLoader] Using cached FFmpeg assets');
        return cachedAssets.ffmpeg;
    }

    console.log('[AssetLoader] Loading FFmpeg assets...');

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

    const [coreJS, coreWasm] = await Promise.all([
        toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    ]);

    const ffmpegAssets: FFmpegAssets = { coreJS, coreWasm };
    cachedAssets.ffmpeg = ffmpegAssets;
    console.log('[AssetLoader] FFmpeg assets loaded');
    return ffmpegAssets;
}

/**
 * Load video file
 */
async function loadVideoFile(videoName: string): Promise<Blob> {
    console.log(`[AssetLoader] Loading video: ${videoName}`);
    const response = await fetchWithProgress(
        `${import.meta.env.VITE_PUBLIC_BASE_URL}/videos/${videoName}`
    );
    const blob = await response.blob();
    console.log('[AssetLoader] Video loaded');
    return blob;
}

/**
 * Load font file
 */
async function loadFontFile(fontPath: string): Promise<ArrayBuffer> {
    if (cachedAssets.font) {
        console.log('[AssetLoader] Using cached font');
        return cachedAssets.font;
    }

    console.log(`[AssetLoader] Loading font: ${fontPath}`);
    const fontUrl = `${import.meta.env.VITE_PUBLIC_BASE_URL}/${fontPath.startsWith('/') ? fontPath.slice(1) : fontPath}`;
    const response = await fetchWithProgress(fontUrl);
    const buffer = await response.arrayBuffer();
    cachedAssets.font = buffer;
    console.log('[AssetLoader] Font loaded');
    return buffer;
}

/**
 * Load all assets in parallel with progress reporting
 */
export async function loadAllAssets(
    videoName: string,
    fontPath: string,
    onProgress?: ProgressCallback
): Promise<AssetCache> {
    const ttsBasePath = import.meta.env.VITE_PUBLIC_BASE_URL + '/models/supertonic';
    
    onProgress?.(0, 'Starting asset loading...');

    // Track individual progress for each asset group
    const totalSteps = 4; // TTS, FFmpeg, Video, Font
    let completedSteps = 0;

    const updateProgress = (stepName: string) => {
        completedSteps++;
        const progress = Math.round((completedSteps / totalSteps) * 100);
        onProgress?.(progress, `Loaded ${stepName}`);
    };

    // Start all fetches in parallel
    const [tts, ffmpeg, video, font] = await Promise.all([
        loadTTSAssets(ttsBasePath).then(result => {
            updateProgress('TTS models');
            return result;
        }),
        loadFFmpegAssets().then(result => {
            updateProgress('FFmpeg');
            return result;
        }),
        loadVideoFile(videoName).then(result => {
            updateProgress('video');
            return result;
        }),
        loadFontFile(fontPath).then(result => {
            updateProgress('font');
            return result;
        }),
    ]);

    onProgress?.(100, 'All assets loaded');

    return { tts, ffmpeg, video, font };
}

/**
 * Clear cached assets (useful for testing or memory management)
 */
export function clearAssetCache(): void {
    cachedAssets = {};
    console.log('[AssetLoader] Cache cleared');
}
