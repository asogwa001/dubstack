/**
 * TTS Worker Client
 * Wrapper that spawns the TTS Web Worker and handles message passing
 */

import type { WorkerRequest, WorkerResponse } from './tts.worker';
import type { TTSAssets } from '../assetLoader';

// Re-export types for consumers
export interface VoiceStyle {
    name: string;
    id: string;
}

export interface Timestamp {
    text: string;
    start: number;
    end: number;
}

export interface TTSResult {
    wav: Float32Array;
    sampleRate: number;
    duration: number;
    timestamps: Timestamp[];
    srt: string;
}

export interface GenerationConfig {
    text: string;
    voiceId: string;
    speed?: number;
    silenceDuration?: number;
    endSilenceDuration?: number;
}

export type ProgressCallback = (message: string, chunkIndex?: number, totalChunks?: number) => void;

export class TTSWorkerClient {
    private worker: Worker | null = null;
    private pendingResolve: ((value: unknown) => void) | null = null;
    private pendingReject: ((reason: unknown) => void) | null = null;
    private progressCallback: ProgressCallback | null = null;
    private availableVoices: VoiceStyle[] = [];
    private basePath: string;

    public initialized = false;

    constructor(basePath: string = import.meta.env.VITE_PUBLIC_BASE_URL + '/models/supertonic') {
        this.basePath = basePath;
    }

    private createWorker(): Worker {
        // Vite handles workers with the ?worker suffix
        return new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
    }

    private handleMessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        switch (message.type) {
            case 'ready':
                this.availableVoices = message.voices;
                this.initialized = true;
                this.pendingResolve?.(undefined);
                this.pendingResolve = null;
                this.pendingReject = null;
                break;

            case 'progress':
                this.progressCallback?.(message.message, message.chunkIndex, message.totalChunks);
                break;

            case 'result':
                this.pendingResolve?.({
                    wav: message.wav,
                    sampleRate: message.sampleRate,
                    duration: message.duration,
                    timestamps: message.timestamps,
                    srt: message.srt
                });
                this.pendingResolve = null;
                this.pendingReject = null;
                this.progressCallback = null;
                break;

            case 'error':
                this.pendingReject?.(new Error(message.message));
                this.pendingResolve = null;
                this.pendingReject = null;
                this.progressCallback = null;
                break;
        }
    };

    private handleError = (error: ErrorEvent) => {
        console.error('[TTSWorkerClient] Worker error:', error);
        this.pendingReject?.(new Error(error.message || 'Worker error'));
        this.pendingResolve = null;
        this.pendingReject = null;
        this.progressCallback = null;
    };

    async init(assets: TTSAssets): Promise<void> {
        if (this.initialized) return;

        console.log('[TTSWorkerClient] Initializing worker...');

        // Create worker
        this.worker = this.createWorker();
        this.worker.onmessage = this.handleMessage;
        this.worker.onerror = this.handleError;

        // Send init message and wait for ready
        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve as (value: unknown) => void;
            this.pendingReject = reject;

            this.worker!.postMessage({
                type: 'init',
                assets: {
                    config: assets.config,
                    unicodeIndexer: assets.unicodeIndexer,
                    dpModel: assets.dpModel,
                    textEncModel: assets.textEncModel,
                    vectorEstModel: assets.vectorEstModel,
                    vocoderModel: assets.vocoderModel,
                }
            } as WorkerRequest);
        });
    }

    getAvailableVoices(): VoiceStyle[] {
        return this.availableVoices;
    }

    async generate(config: GenerationConfig, onProgress?: ProgressCallback): Promise<TTSResult> {
        if (!this.worker || !this.initialized) {
            throw new Error('TTS worker not initialized');
        }

        this.progressCallback = onProgress || null;

        // Fetch voice style data
        const voiceStyleData = await this.fetchVoiceStyle(config.voiceId);

        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve as (value: unknown) => void;
            this.pendingReject = reject;

            this.worker!.postMessage({
                type: 'generate',
                config,
                voiceStyleData
            } as WorkerRequest);
        });
    }

    private async fetchVoiceStyle(voiceId: string): Promise<unknown> {
        const response = await fetch(`${this.basePath}/voice_styles/${voiceId}.json`);
        return response.json();
    }

    terminate(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.initialized = false;
            this.availableVoices = [];
            console.log('[TTSWorkerClient] Worker terminated');
        }
    }
}
