/**
 * FFmpeg.wasm helper for browser-based video dubbing
 * Ported from Python ffmpeg_dub.py
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export interface SubtitleConfig {
    fontSize?: number;
    outline?: number;
    shadow?: number;
    marginV?: number;
}

export interface DubConfig {
    videoFile: File | Blob;
    audioData: Float32Array;
    sampleRate: number;
    srtContent: string;
    bgVolume?: number;
    subtitles?: SubtitleConfig;
}

export interface DubProgress {
    stage: 'loading' | 'processing' | 'encoding' | 'complete';
    progress: number;
    message: string;
}

export type ProgressCallback = (progress: DubProgress) => void;

export class FFmpegDubber {
    private ffmpeg: FFmpeg;
    private loaded = false;

    constructor() {
        this.ffmpeg = new FFmpeg();
    }

    async load(onProgress?: ProgressCallback): Promise<void> {
        if (this.loaded) return;

        onProgress?.({
            stage: 'loading',
            progress: 0,
            message: 'Loading FFmpeg...',
        });

        // Load FFmpeg with proper CORS headers from CDN
        const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

        this.ffmpeg.on('log', ({ message }) => {
            console.log('[FFmpeg]', message);
        });

        this.ffmpeg.on('progress', ({ progress }) => {
            onProgress?.({
                stage: 'encoding',
                progress: Math.round(progress * 100),
                message: `Encoding video: ${Math.round(progress * 100)}%`,
            });
        });

        await this.ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });

        this.loaded = true;

        onProgress?.({
            stage: 'loading',
            progress: 100,
            message: 'FFmpeg loaded',
        });
    }

    /**
     * Convert Float32Array audio to WAV format
     */
    private audioToWav(audioData: Float32Array, sampleRate: number): Uint8Array {
        const numChannels = 1;
        const bytesPerSample = 2; // 16-bit
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = audioData.length * bytesPerSample;
        const bufferSize = 44 + dataSize;

        const buffer = new ArrayBuffer(bufferSize);
        const view = new DataView(buffer);

        // RIFF header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        this.writeString(view, 8, 'WAVE');

        // fmt subchunk
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
        view.setUint16(20, 1, true); // AudioFormat (PCM = 1)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bytesPerSample * 8, true); // BitsPerSample

        // data subchunk
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // Write audio data as 16-bit PCM
        let offset = 44;
        for (let i = 0; i < audioData.length; i++) {
            // Clamp and convert to 16-bit
            const sample = Math.max(-1, Math.min(1, audioData[i]));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }

        return new Uint8Array(buffer);
    }

    private writeString(view: DataView, offset: number, str: string): void {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    /**
     * Dub video with generated audio and embedded subtitles
     */
    async dub(config: DubConfig, onProgress?: ProgressCallback): Promise<Blob> {
        const {
            videoFile,
            audioData,
            sampleRate,
            srtContent,
            bgVolume = 0.0,
            subtitles = {},
        } = config;

        const {
            fontSize = 16,
            outline = 2,
            shadow = 1,
            marginV = 80,
        } = subtitles;

        if (!this.loaded) {
            await this.load(onProgress);
        }

        onProgress?.({
            stage: 'processing',
            progress: 0,
            message: 'Preparing files...',
        });

        // Write input files to FFmpeg virtual filesystem
        const videoData = await fetchFile(videoFile);
        const videoFileName = 'input.mp4';
        await this.ffmpeg.writeFile(videoFileName, videoData);

        onProgress?.({
            stage: 'processing',
            progress: 20,
            message: 'Converting audio...',
        });

        // Convert audio to WAV
        const wavData = this.audioToWav(audioData, sampleRate);
        await this.ffmpeg.writeFile('audio.wav', wavData);

        onProgress?.({
            stage: 'processing',
            progress: 40,
            message: 'Preparing subtitles...',
        });

        // Write SRT file for subtitle embedding
        const encoder = new TextEncoder();
        await this.ffmpeg.writeFile('subtitles.srt', encoder.encode(srtContent));

        // Calculate audio duration
        const audioDuration = audioData.length / sampleRate;

        onProgress?.({
            stage: 'processing',
            progress: 60,
            message: 'Building filters...',
        });

        // Build subtitle style (matching ffmpeg_dub.py)
        // Format: FontName=Inter,FontSize=16,Outline=2,Shadow=1,Alignment=2,MarginV=80
        const subtitleStyle = [
            `FontSize=${fontSize}`,
            `Outline=${outline}`,
            `Shadow=${shadow}`,
            `Alignment=2`,
            `MarginV=${marginV}`,
        ].join('\\,');

        // Build FFmpeg command
        const ffmpegArgs: string[] = ['-y'];
        console.log('SRT Content:', srtContent);

        // Input files - loop video if needed
        ffmpegArgs.push('-stream_loop', '-1'); // Infinite loop
        ffmpegArgs.push('-i', videoFileName);
        ffmpegArgs.push('-i', 'audio.wav');

        // Video filter with embedded subtitles
        // Note: ffmpeg.wasm may have limited ASS subtitle support, using SRT with force_style
        //const videoFilter = `subtitles=subtitles.srt:force_style='${subtitleStyle}'`;
        const videoFilter = `subtitles=subtitles.srt`;

        //ffmpegArgs.push('-vf', videoFilter);

        // Audio filter - mix background audio with voice dub
        let audioFilter: string;
        // if (bgVolume > 0) {
        //     // Mix original video audio with TTS audio
        //     audioFilter = `[0:a]volume=${bgVolume}[va];[1:a]volume=1.0[ta];[va][ta]amix=inputs=2:dropout_transition=0[outa]`;
        //     ffmpegArgs.push('-filter_complex', audioFilter);
        //     ffmpegArgs.push('-map', '0:v:0');
        //     ffmpegArgs.push('-map', '[outa]');
        // } else {
        //     // Just use the TTS audio
        //     ffmpegArgs.push('-map', '0:v:0');
        //     ffmpegArgs.push('-map', '1:a:0');
        // }
        if (bgVolume > 0) {
            // Combine video subtitles + audio mixing in ONE filter_complex
            audioFilter = `[0:v]subtitles=subtitles.srt[v];[0:a]volume=${bgVolume}[va];[1:a]volume=1.0[ta];[va][ta]amix=inputs=2:dropout_transition=0[outa]`;
            ffmpegArgs.push('-filter_complex', audioFilter);
            ffmpegArgs.push('-map', '[v]');
            ffmpegArgs.push('-map', '[outa]');
        } else {
            // Just subtitles on video, use TTS audio directly
            audioFilter = `[0:v]subtitles=subtitles.srt[v]`;
            ffmpegArgs.push('-filter_complex', audioFilter);
            ffmpegArgs.push('-map', '[v]');
            ffmpegArgs.push('-map', '1:a:0');
        }
        // Output settings
        ffmpegArgs.push('-c:v', 'libx264');
        ffmpegArgs.push('-preset', 'ultrafast');
        ffmpegArgs.push('-pix_fmt', 'yuv420p');
        ffmpegArgs.push('-c:a', 'aac');
        ffmpegArgs.push('-b:a', '128k');
        ffmpegArgs.push('-t', String(audioDuration)); // Trim to audio length
        ffmpegArgs.push('output.mp4');

        onProgress?.({
            stage: 'encoding',
            progress: 0,
            message: 'Encoding video with subtitles...',
        });

        console.log('FFmpeg args:', ffmpegArgs.join(' '));

        // Execute FFmpeg
        console.log('FFmpeg command:', ffmpegArgs.join(' '));
        await this.ffmpeg.exec(ffmpegArgs);

        onProgress?.({
            stage: 'complete',
            progress: 100,
            message: 'Video ready!',
        });

        // Read output file
        const outputData = await this.ffmpeg.readFile('output.mp4');

        // Cleanup
        await this.ffmpeg.deleteFile(videoFileName);
        await this.ffmpeg.deleteFile('audio.wav');
        await this.ffmpeg.deleteFile('subtitles.srt');
        await this.ffmpeg.deleteFile('output.mp4');

        return new Blob([outputData], { type: 'video/mp4' });
    }
}

// Singleton instance
let dubberInstance: FFmpegDubber | null = null;

export function getFFmpegDubber(): FFmpegDubber {
    if (!dubberInstance) {
        dubberInstance = new FFmpegDubber();
    }
    return dubberInstance;
}
