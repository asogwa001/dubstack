/**
 * TTS Web Worker
 * Runs ONNX inference off the main thread to prevent UI freezing
 */

import * as ort from 'onnxruntime-web';

// Configure ONNX Runtime Web to use WASM backend
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';

// ============= Types =============

interface TTSConfig {
    ae: {
        sample_rate: number;
        base_chunk_size: number;
    };
    ttl: {
        chunk_compress_factor: number;
        latent_dim: number;
    };
}

interface VoiceStyleData {
    style_ttl: {
        dims: number[];
        data: number[] | number[][] | number[][][];
    };
    style_dp: {
        dims: number[];
        data: number[] | number[][] | number[][][];
    };
}

interface Style {
    ttl: ort.Tensor;
    dp: ort.Tensor;
}

interface Timestamp {
    text: string;
    start: number;
    end: number;
}

interface TTSAssets {
    config: TTSConfig;
    unicodeIndexer: Record<string, number>;
    dpModel: ArrayBuffer;
    textEncModel: ArrayBuffer;
    vectorEstModel: ArrayBuffer;
    vocoderModel: ArrayBuffer;
}

interface GenerationConfig {
    text: string;
    voiceId: string;
    speed?: number;
    silenceDuration?: number;
    endSilenceDuration?: number;
}

// Worker message types
export type WorkerRequest =
    | { type: 'init'; assets: TTSAssets }
    | { type: 'generate'; config: GenerationConfig; voiceStyleData: VoiceStyleData };

export type WorkerResponse =
    | { type: 'ready'; voices: { name: string; id: string }[] }
    | { type: 'progress'; message: string; chunkIndex?: number; totalChunks?: number }
    | { type: 'result'; wav: Float32Array; sampleRate: number; duration: number; timestamps: Timestamp[]; srt: string }
    | { type: 'error'; message: string };

// ============= Helper Functions =============

class UnicodeProcessor {
    private indexer: Record<string, number>;

    constructor(indexer: Record<string, number>) {
        this.indexer = indexer;
    }

    private preprocessText(text: string): string {
        let normalized = text.normalize('NFKD');

        // Remove emojis
        const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
        normalized = normalized.replace(emojiPattern, '');

        // Replacements
        const replacements: Record<string, string> = {
            '–': '-', '‑': '-', '—': '-', '¯': ' ', '_': ' ',
            '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
            '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ',
            '→': ' ', '←': ' '
        };

        for (const [k, v] of Object.entries(replacements)) {
            normalized = normalized.replaceAll(k, v);
        }

        // Remove combining diacritics
        normalized = normalized.replace(/[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g, '');

        // Remove special symbols
        normalized = normalized.replace(/[♥☆♡©\\]/g, '');

        // Replace known expressions
        const exprReplacements: Record<string, string> = {
            '@': ' at ',
            'e.g.,': 'for example, ',
            'i.e.,': 'that is, ',
        };
        for (const [k, v] of Object.entries(exprReplacements)) {
            normalized = normalized.replaceAll(k, v);
        }

        // Fix spacing around punctuation
        normalized = normalized.replace(/ ,/g, ',');
        normalized = normalized.replace(/ \./g, '.');
        normalized = normalized.replace(/ !/g, '!');
        normalized = normalized.replace(/ \?/g, '?');
        normalized = normalized.replace(/ ;/g, ';');
        normalized = normalized.replace(/ :/g, ':');
        normalized = normalized.replace(/ '/g, "'");

        // Remove duplicate quotes
        while (normalized.includes('""')) normalized = normalized.replaceAll('""', '"');
        while (normalized.includes("''")) normalized = normalized.replaceAll("''", "'");
        while (normalized.includes('``')) normalized = normalized.replaceAll('``', '`');

        // Remove extra spaces
        normalized = normalized.replace(/\s+/g, ' ').trim();

        // Add tail punctuation if missing
        if (!/[.!?;:,'"')\]}\…。」』】〉》›»]$/.test(normalized)) {
            normalized += '.';
        }

        return normalized;
    }

    private textToUnicodeValues(text: string): number[] {
        return Array.from(text).map(char => char.charCodeAt(0));
    }

    call(textList: string[]): { textIds: number[][]; textMask: number[][][] } {
        const processedTexts = textList.map(t => this.preprocessText(t));
        const textIdsLengths = processedTexts.map(t => t.length);
        const maxLen = Math.max(...textIdsLengths);

        const textIds: number[][] = [];
        for (let i = 0; i < processedTexts.length; i++) {
            const row = new Array(maxLen).fill(0);
            const unicodeVals = this.textToUnicodeValues(processedTexts[i]);
            for (let j = 0; j < unicodeVals.length; j++) {
                row[j] = this.indexer[unicodeVals[j].toString()] || 0;
            }
            textIds.push(row);
        }

        const textMask = lengthToMask(textIdsLengths);
        return { textIds, textMask };
    }
}

function lengthToMask(lengths: number[], maxLen: number | null = null): number[][][] {
    const mLen = maxLen || Math.max(...lengths);
    const mask: number[][][] = [];
    for (let i = 0; i < lengths.length; i++) {
        const row: number[] = [];
        for (let j = 0; j < mLen; j++) {
            row.push(j < lengths[i] ? 1.0 : 0.0);
        }
        mask.push([row]);
    }
    return mask;
}

function getLatentMask(wavLengths: number[], baseChunkSize: number, chunkCompressFactor: number): number[][][] {
    const latentSize = baseChunkSize * chunkCompressFactor;
    const latentLengths = wavLengths.map(len =>
        Math.floor((len + latentSize - 1) / latentSize)
    );
    return lengthToMask(latentLengths);
}

function flattenArray(arr: unknown): number[] {
    if (Array.isArray(arr)) {
        return arr.flatMap(item => flattenArray(item));
    }
    return [arr as number];
}

function arrayToTensor(array: unknown, dims: number[]): ort.Tensor {
    const flat = flattenArray(array);
    return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

function intArrayToTensor(array: unknown, dims: number[]): ort.Tensor {
    const flat = flattenArray(array);
    return new ort.Tensor('int64', BigInt64Array.from(flat.map(x => BigInt(x))), dims);
}

function chunkText(text: string, maxLen: number = 300): string[] {
    if (typeof text !== 'string') {
        throw new Error(`chunkText expects a string, got ${typeof text}`);
    }

    const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
    const chunks: string[] = [];

    for (let paragraph of paragraphs) {
        paragraph = paragraph.trim();
        if (!paragraph) continue;

        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        let currentChunk = '';

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 <= maxLen) {
                currentChunk += (currentChunk ? ' ' : '') + sentence;
            } else {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = sentence;
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk.trim());
        }
    }

    return chunks.length > 0 ? chunks : [text.trim()];
}

function formatSRTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function generateSRT(timestamps: Timestamp[]): string {
    const lines: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const startTime = formatSRTTime(ts.start);
        const endTime = formatSRTTime(ts.end);

        lines.push(`${i + 1}`);
        lines.push(`${startTime} --> ${endTime}`);
        lines.push(ts.text);
        lines.push('');
    }

    return lines.join('\n');
}

// ============= Worker State =============

let config: TTSConfig | null = null;
let textProcessor: UnicodeProcessor | null = null;
let dpOrt: ort.InferenceSession | null = null;
let textEncOrt: ort.InferenceSession | null = null;
let vectorEstOrt: ort.InferenceSession | null = null;
let vocoderOrt: ort.InferenceSession | null = null;
let initialized = false;

// ============= Worker Functions =============

async function initTTS(assets: TTSAssets): Promise<void> {
    if (initialized) return;

    console.log('[TTS Worker] Initializing...');

    config = assets.config;
    textProcessor = new UnicodeProcessor(assets.unicodeIndexer);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
    };

    console.log('[TTS Worker] Creating ONNX sessions...');
    [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = await Promise.all([
        ort.InferenceSession.create(assets.dpModel, sessionOptions),
        ort.InferenceSession.create(assets.textEncModel, sessionOptions),
        ort.InferenceSession.create(assets.vectorEstModel, sessionOptions),
        ort.InferenceSession.create(assets.vocoderModel, sessionOptions),
    ]);

    initialized = true;
    console.log('[TTS Worker] Initialized successfully');
}

function loadVoiceStyle(voiceStyleData: VoiceStyleData): Style {
    const ttlDims = voiceStyleData.style_ttl.dims;
    const dpDims = voiceStyleData.style_dp.dims;

    const ttlDim1 = ttlDims[1];
    const ttlDim2 = ttlDims[2];
    const dpDim1 = dpDims[1];
    const dpDim2 = dpDims[2];

    const ttlData = flattenArray(voiceStyleData.style_ttl.data);
    const dpData = flattenArray(voiceStyleData.style_dp.data);

    const ttlTensor = new ort.Tensor('float32', Float32Array.from(ttlData), [1, ttlDim1, ttlDim2]);
    const dpTensor = new ort.Tensor('float32', Float32Array.from(dpData), [1, dpDim1, dpDim2]);

    return { ttl: ttlTensor, dp: dpTensor };
}

function sampleNoisyLatent(duration: number[]): { noisyLatent: number[][][]; latentMask: number[][][] } {
    const wavLenMax = Math.max(...duration) * config!.ae.sample_rate;
    const wavLengths = duration.map(d => Math.floor(d * config!.ae.sample_rate));
    const chunkSize = config!.ae.base_chunk_size * config!.ttl.chunk_compress_factor;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    const latentDim = config!.ttl.latent_dim * config!.ttl.chunk_compress_factor;

    const noisyLatent: number[][][] = [];
    for (let b = 0; b < duration.length; b++) {
        const batch: number[][] = [];
        for (let d = 0; d < latentDim; d++) {
            const row: number[] = [];
            for (let t = 0; t < latentLen; t++) {
                const eps = 1e-10;
                const u1 = Math.max(eps, Math.random());
                const u2 = Math.random();
                const randNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
                row.push(randNormal);
            }
            batch.push(row);
        }
        noisyLatent.push(batch);
    }

    const latentMask = getLatentMask(wavLengths, config!.ae.base_chunk_size, config!.ttl.chunk_compress_factor);

    // Apply mask
    for (let b = 0; b < noisyLatent.length; b++) {
        for (let d = 0; d < noisyLatent[b].length; d++) {
            for (let t = 0; t < noisyLatent[b][d].length; t++) {
                if (t < latentMask[b][0].length) {
                    noisyLatent[b][d][t] *= latentMask[b][0][t];
                }
            }
        }
    }

    return { noisyLatent, latentMask };
}

async function infer(
    textList: string[],
    style: Style,
    totalStep: number,
    speed: number
): Promise<{ wav: number[]; duration: number[] }> {
    if (!textProcessor || !dpOrt || !textEncOrt || !vectorEstOrt || !vocoderOrt) {
        throw new Error('TTS engine not initialized');
    }

    const bsz = textList.length;

    const { textIds, textMask } = textProcessor.call(textList);
    const textIdsShape: [number, number] = [bsz, textIds[0].length];
    const textMaskShape: [number, number, number] = [bsz, 1, textMask[0][0].length];

    const textMaskTensor = arrayToTensor(textMask, textMaskShape);

    // Duration predictor
    const dpResult = await dpOrt.run({
        text_ids: intArrayToTensor(textIds, textIdsShape),
        style_dp: style.dp,
        text_mask: textMaskTensor
    });

    const durOnnx = Array.from(dpResult.duration.data as Float32Array);

    for (let i = 0; i < durOnnx.length; i++) {
        durOnnx[i] /= speed;
    }

    // Text encoder
    const textEncResult = await textEncOrt.run({
        text_ids: intArrayToTensor(textIds, textIdsShape),
        style_ttl: style.ttl,
        text_mask: textMaskTensor
    });

    const textEmbTensor = textEncResult.text_emb;

    // Sample noisy latent
    let { noisyLatent, latentMask } = sampleNoisyLatent(durOnnx);
    const latentShape: [number, number, number] = [bsz, noisyLatent[0].length, noisyLatent[0][0].length];
    const latentMaskShape: [number, number, number] = [bsz, 1, latentMask[0][0].length];

    const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape);

    const totalStepArray = new Array(bsz).fill(totalStep);
    const scalarShape: [number] = [bsz];
    const totalStepTensor = arrayToTensor(totalStepArray, scalarShape);

    // Diffusion steps
    for (let step = 0; step < totalStep; step++) {
        const currentStepArray = new Array(bsz).fill(step);

        const vectorEstResult = await vectorEstOrt.run({
            noisy_latent: arrayToTensor(noisyLatent, latentShape),
            text_emb: textEmbTensor,
            style_ttl: style.ttl,
            text_mask: textMaskTensor,
            latent_mask: latentMaskTensor,
            total_step: totalStepTensor,
            current_step: arrayToTensor(currentStepArray, scalarShape)
        });

        const denoisedLatent = Array.from(vectorEstResult.denoised_latent.data as Float32Array);

        let idx = 0;
        for (let b = 0; b < noisyLatent.length; b++) {
            for (let d = 0; d < noisyLatent[b].length; d++) {
                for (let t = 0; t < noisyLatent[b][d].length; t++) {
                    noisyLatent[b][d][t] = denoisedLatent[idx++];
                }
            }
        }
    }

    // Vocoder
    const vocoderResult = await vocoderOrt.run({
        latent: arrayToTensor(noisyLatent, latentShape)
    });

    const wav = Array.from(vocoderResult.wav_tts.data as Float32Array);

    return { wav, duration: durOnnx };
}

async function generate(
    generationConfig: GenerationConfig,
    voiceStyleData: VoiceStyleData
): Promise<{ wav: Float32Array; sampleRate: number; duration: number; timestamps: Timestamp[]; srt: string }> {
    const {
        text,
        speed = 1.05,
        silenceDuration = 0.3,
        endSilenceDuration = 0.5,
    } = generationConfig;

    const style = loadVoiceStyle(voiceStyleData);
    const textChunks = chunkText(text);

    const totalStep = 8;
    const sampleRate = config!.ae.sample_rate;

    let wavCat: number[] | null = null;
    const timestamps: Timestamp[] = [];
    let currentTime = 0.0;
    let durCat = 0.0;

    for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];

        // Send progress update
        self.postMessage({
            type: 'progress',
            message: `Generating speech ${Math.round(((i + 1) / textChunks.length) * 100)}%...`,    
            chunkIndex: i,
            totalChunks: textChunks.length
        } as WorkerResponse);

        const { wav, duration } = await infer([chunk], style, totalStep, speed);
        const chunkDuration = duration[0];

        timestamps.push({
            text: chunk,
            start: currentTime,
            end: currentTime + chunkDuration,
        });

        if (wavCat === null) {
            wavCat = [...wav];
            durCat = chunkDuration;
        } else {
            const silenceLen = Math.floor(silenceDuration * sampleRate);
            const silence = new Array(silenceLen).fill(0);
            wavCat = [...wavCat, ...silence, ...wav];
            durCat += chunkDuration + silenceDuration;
        }

        currentTime = currentTime + chunkDuration + silenceDuration;
    }

    if (endSilenceDuration > 0 && wavCat) {
        const tailSilence = new Array(Math.floor(endSilenceDuration * sampleRate)).fill(0);
        wavCat = [...wavCat, ...tailSilence];
        durCat += endSilenceDuration;
    }

    const srt = generateSRT(timestamps);
    const wavFloat32 = Float32Array.from(wavCat!);

    return {
        wav: wavFloat32,
        sampleRate: sampleRate,
        duration: durCat,
        timestamps,
        srt,
    };
}

// ============= Message Handler =============

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const message = event.data;

    try {
        switch (message.type) {
            case 'init': {
                await initTTS(message.assets);

                // Voice map matching server.py
                const voices = [
                    { name: 'Ava', id: 'F1' },
                    { name: 'Sophia', id: 'F2' },
                    { name: 'Isabella', id: 'F3' },
                    { name: 'Mia', id: 'F4' },
                    { name: 'Luna', id: 'F5' },
                    { name: 'Liam', id: 'M1' },
                    { name: 'Ethan', id: 'M2' },
                    { name: 'Noah', id: 'M3' },
                    { name: 'Lucas', id: 'M4' },
                    { name: 'Oliver', id: 'M5' },
                ];

                self.postMessage({ type: 'ready', voices } as WorkerResponse);
                break;
            }
            case 'generate': {
                if (!initialized) {
                    throw new Error('TTS worker not initialized');
                }

                self.postMessage({ type: 'progress', message: 'Starting generation...' } as WorkerResponse);

                const result = await generate(message.config, message.voiceStyleData);

                self.postMessage({
                    type: 'result',
                    wav: result.wav,
                    sampleRate: result.sampleRate,
                    duration: result.duration,
                    timestamps: result.timestamps,
                    srt: result.srt
                } as WorkerResponse);
                break;
            }
        }
    } catch (error) {
        console.error('[TTS Worker] Error:', error);
        self.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown error'
        } as WorkerResponse);
    }
};

console.log('[TTS Worker] Loaded');
