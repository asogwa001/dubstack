/**
 * Supertonic TTS Engine for browser using ONNX Runtime Web
 * Ported from official Node.js helper.js
 */

import * as ort from 'onnxruntime-web';
import { TTSModel, TTSResult, VoiceStyle, GenerationConfig, Timestamp } from './types';

// Configure ONNX Runtime Web to use WASM backend
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';

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

/**
 * UnicodeProcessor - processes text for TTS
 */
class UnicodeProcessor {
    private indexer: Record<string, number>;

    constructor(indexer: Record<string, number>) {
        this.indexer = indexer;
    }

    private preprocessText(text: string): string {
        // Normalize text (NFKD)
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
        if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(normalized)) {
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

/**
 * Convert lengths to binary mask [B, 1, maxLen]
 */
function lengthToMask(lengths: number[], maxLen: number | null = null): number[][][] {
    const mLen = maxLen || Math.max(...lengths);
    const mask: number[][][] = [];
    for (let i = 0; i < lengths.length; i++) {
        const row: number[] = [];
        for (let j = 0; j < mLen; j++) {
            row.push(j < lengths[i] ? 1.0 : 0.0);
        }
        mask.push([row]); // [B, 1, maxLen]
    }
    return mask;
}

/**
 * Get latent mask from wav lengths
 */
function getLatentMask(wavLengths: number[], baseChunkSize: number, chunkCompressFactor: number): number[][][] {
    const latentSize = baseChunkSize * chunkCompressFactor;
    const latentLengths = wavLengths.map(len =>
        Math.floor((len + latentSize - 1) / latentSize)
    );
    return lengthToMask(latentLengths);
}

/**
 * Flatten nested array to 1D
 */
function flattenArray(arr: unknown): number[] {
    if (Array.isArray(arr)) {
        return arr.flatMap(item => flattenArray(item));
    }
    return [arr as number];
}

/**
 * Convert nested array to Float32 ONNX tensor
 */
function arrayToTensor(array: unknown, dims: number[]): ort.Tensor {
    const flat = flattenArray(array);
    return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

/**
 * Convert nested int array to Int64 ONNX tensor
 */
function intArrayToTensor(array: unknown, dims: number[]): ort.Tensor {
    const flat = flattenArray(array);
    return new ort.Tensor('int64', BigInt64Array.from(flat.map(x => BigInt(x))), dims);
}

/**
 * Chunk text into manageable segments
 */
function chunkText(text: string, maxLen: number = 50): string[] {
    if (typeof text !== 'string') {
        throw new Error(`chunkText expects a string, got ${typeof text}`);
    }

    // Split by paragraph (two or more newlines)
    const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());

    const chunks: string[] = [];

    for (let paragraph of paragraphs) {
        paragraph = paragraph.trim();
        if (!paragraph) continue;

        // Split by sentence boundaries
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

export class SupertonicTTS extends TTSModel {
    name = 'Supertonic';
    initialized = false;

    private config: TTSConfig | null = null;
    private textProcessor: UnicodeProcessor | null = null;
    private dpOrt: ort.InferenceSession | null = null;
    private textEncOrt: ort.InferenceSession | null = null;
    private vectorEstOrt: ort.InferenceSession | null = null;
    private vocoderOrt: ort.InferenceSession | null = null;
    private voiceStyles: Map<string, Style> = new Map();
    private availableVoices: VoiceStyle[] = [];

    private basePath: string;

    constructor(basePath: string = import.meta.env.VITE_PUBLIC_BASE_URL + '/models/supertonic') {
        super();
        this.basePath = basePath;
    }

    /**
     * Pre-fetched assets interface for parallel loading
     */
    public static PrefetchedAssets: {
        config: TTSConfig;
        unicodeIndexer: Record<string, number>;
        dpModel: ArrayBuffer;
        textEncModel: ArrayBuffer;
        vectorEstModel: ArrayBuffer;
        vocoderModel: ArrayBuffer;
    } | null = null;

    async init(prefetchedAssets?: {
        config: TTSConfig;
        unicodeIndexer: Record<string, number>;
        dpModel: ArrayBuffer;
        textEncModel: ArrayBuffer;
        vectorEstModel: ArrayBuffer;
        vocoderModel: ArrayBuffer;
    }): Promise<void> {
        if (this.initialized) return;

        console.log('Initializing Supertonic TTS...');

        // Use prefetched assets or fetch them
        const assets = prefetchedAssets || SupertonicTTS.PrefetchedAssets;

        // Load ONNX session options
        const sessionOptions: ort.InferenceSession.SessionOptions = {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        };

        if (assets) {
            // Use pre-fetched assets
            console.log('Using pre-fetched TTS assets');
            this.config = assets.config;
            this.textProcessor = new UnicodeProcessor(assets.unicodeIndexer);

            console.log('Creating ONNX sessions from pre-fetched models...');
            const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = await Promise.all([
                ort.InferenceSession.create(assets.dpModel, sessionOptions),
                ort.InferenceSession.create(assets.textEncModel, sessionOptions),
                ort.InferenceSession.create(assets.vectorEstModel, sessionOptions),
                ort.InferenceSession.create(assets.vocoderModel, sessionOptions),
            ]);

            this.dpOrt = dpOrt;
            this.textEncOrt = textEncOrt;
            this.vectorEstOrt = vectorEstOrt;
            this.vocoderOrt = vocoderOrt;
        } else {
            // Fallback: fetch assets sequentially (backwards compatibility)
            console.log('Fetching TTS assets...');

            const configResponse = await fetch(`${this.basePath}/onnx/tts.json`);
            this.config = await configResponse.json();

            const indexerResponse = await fetch(`${this.basePath}/onnx/unicode_indexer.json`);
            const indexer = await indexerResponse.json();
            this.textProcessor = new UnicodeProcessor(indexer);

            console.log('Loading duration predictor...');
            this.dpOrt = await ort.InferenceSession.create(
                `${this.basePath}/onnx/duration_predictor.onnx`,
                sessionOptions
            );

            console.log('Loading text encoder...');
            this.textEncOrt = await ort.InferenceSession.create(
                `${this.basePath}/onnx/text_encoder.onnx`,
                sessionOptions
            );

            console.log('Loading vector estimator...');
            this.vectorEstOrt = await ort.InferenceSession.create(
                `${this.basePath}/onnx/vector_estimator.onnx`,
                sessionOptions
            );

            console.log('Loading vocoder...');
            this.vocoderOrt = await ort.InferenceSession.create(
                `${this.basePath}/onnx/vocoder.onnx`,
                sessionOptions
            );
        }

        // Discover available voice styles - matching server.py VOICE_MAP
        const voiceMap: Record<string, string> = {
            'F1': 'Ava',
            'F2': 'Sophia',
            'F3': 'Isabella',
            'F4': 'Mia',
            'F5': 'Luna',
            'M1': 'Liam',
            'M2': 'Ethan',
            'M3': 'Noah',
            'M4': 'Lucas',
            'M5': 'Oliver',
        };
        for (const [id, name] of Object.entries(voiceMap)) {
            this.availableVoices.push({ name, id });
        }

        this.initialized = true;
        console.log('Supertonic TTS initialized successfully');
    }

    getAvailableVoices(): VoiceStyle[] {
        return this.availableVoices;
    }

    private async loadVoiceStyle(voiceId: string): Promise<Style> {
        if (this.voiceStyles.has(voiceId)) {
            return this.voiceStyles.get(voiceId)!;
        }

        const response = await fetch(`${this.basePath}/voice_styles/${voiceId}.json`);
        const data: VoiceStyleData = await response.json();

        const ttlDims = data.style_ttl.dims;
        const dpDims = data.style_dp.dims;

        const ttlDim1 = ttlDims[1];
        const ttlDim2 = ttlDims[2];
        const dpDim1 = dpDims[1];
        const dpDim2 = dpDims[2];

        // Flatten the nested data arrays
        const ttlData = flattenArray(data.style_ttl.data);
        const dpData = flattenArray(data.style_dp.data);

        console.log(`Voice ${voiceId}: ttl data length=${ttlData.length}, expected=${ttlDim1 * ttlDim2}`);
        console.log(`Voice ${voiceId}: dp data length=${dpData.length}, expected=${dpDim1 * dpDim2}`);

        // Create tensors with batch size 1
        const ttlTensor = new ort.Tensor('float32', Float32Array.from(ttlData), [1, ttlDim1, ttlDim2]);
        const dpTensor = new ort.Tensor('float32', Float32Array.from(dpData), [1, dpDim1, dpDim2]);

        const style: Style = {
            ttl: ttlTensor,
            dp: dpTensor,
        };

        console.log(`Loaded voice style ${voiceId}: ttl shape [1, ${ttlDim1}, ${ttlDim2}], dp shape [1, ${dpDim1}, ${dpDim2}]`);

        this.voiceStyles.set(voiceId, style);
        return style;
    }

    private sampleNoisyLatent(duration: number[]): { noisyLatent: number[][][]; latentMask: number[][][] } {
        const wavLenMax = Math.max(...duration) * this.config!.ae.sample_rate;
        const wavLengths = duration.map(d => Math.floor(d * this.config!.ae.sample_rate));
        const chunkSize = this.config!.ae.base_chunk_size * this.config!.ttl.chunk_compress_factor;
        const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
        const latentDim = this.config!.ttl.latent_dim * this.config!.ttl.chunk_compress_factor;

        // Generate random noise using Box-Muller transform
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

        const latentMask = getLatentMask(wavLengths, this.config!.ae.base_chunk_size, this.config!.ttl.chunk_compress_factor);

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

    private async infer(
        textList: string[],
        style: Style,
        totalStep: number,
        speed: number
    ): Promise<{ wav: number[]; duration: number[] }> {
        if (!this.textProcessor || !this.dpOrt || !this.textEncOrt || !this.vectorEstOrt || !this.vocoderOrt) {
            throw new Error('TTS engine not initialized');
        }

        const bsz = textList.length;

        // Process text
        const { textIds, textMask } = this.textProcessor.call(textList);
        const textIdsShape: [number, number] = [bsz, textIds[0].length];
        const textMaskShape: [number, number, number] = [bsz, 1, textMask[0][0].length];

        const textMaskTensor = arrayToTensor(textMask, textMaskShape);

        // Duration predictor
        console.log('Running duration predictor...');
        const dpResult = await this.dpOrt.run({
            text_ids: intArrayToTensor(textIds, textIdsShape),
            style_dp: style.dp,
            text_mask: textMaskTensor
        });

        const durOnnx = Array.from(dpResult.duration.data as Float32Array);

        // Apply speed factor
        for (let i = 0; i < durOnnx.length; i++) {
            durOnnx[i] /= speed;
        }

        console.log(`Duration prediction: ${durOnnx[0].toFixed(2)}s`);

        // Text encoder
        console.log('Running text encoder...');
        const textEncResult = await this.textEncOrt.run({
            text_ids: intArrayToTensor(textIds, textIdsShape),
            style_ttl: style.ttl,
            text_mask: textMaskTensor
        });

        const textEmbTensor = textEncResult.text_emb;

        // Sample noisy latent
        let { noisyLatent, latentMask } = this.sampleNoisyLatent(durOnnx);
        const latentShape: [number, number, number] = [bsz, noisyLatent[0].length, noisyLatent[0][0].length];
        const latentMaskShape: [number, number, number] = [bsz, 1, latentMask[0][0].length];

        const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape);

        const totalStepArray = new Array(bsz).fill(totalStep);
        const scalarShape: [number] = [bsz];
        const totalStepTensor = arrayToTensor(totalStepArray, scalarShape);

        // Diffusion steps
        console.log(`Running ${totalStep} diffusion steps...`);
        for (let step = 0; step < totalStep; step++) {
            const currentStepArray = new Array(bsz).fill(step);

            const vectorEstResult = await this.vectorEstOrt.run({
                noisy_latent: arrayToTensor(noisyLatent, latentShape),
                text_emb: textEmbTensor,
                style_ttl: style.ttl,
                text_mask: textMaskTensor,
                latent_mask: latentMaskTensor,
                total_step: totalStepTensor,
                current_step: arrayToTensor(currentStepArray, scalarShape)
            });

            const denoisedLatent = Array.from(vectorEstResult.denoised_latent.data as Float32Array);

            // Update latent with denoised output
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
        console.log('Running vocoder...');
        const vocoderResult = await this.vocoderOrt.run({
            latent: arrayToTensor(noisyLatent, latentShape)
        });

        const wav = Array.from(vocoderResult.wav_tts.data as Float32Array);

        return { wav, duration: durOnnx };
    }

    async generate(config: GenerationConfig): Promise<TTSResult> {
        if (!this.initialized) {
            await this.init();
        }

        const {
            text,
            voiceId,
            speed = 1.05,
            silenceDuration = 0.3,
            endSilenceDuration = 0.5,
        } = config;

        const style = await this.loadVoiceStyle(voiceId);
        const textChunks = chunkText(text);

        console.log(`Processing ${textChunks.length} text chunks...`);

        const totalStep = 8; // Diffusion steps
        const sampleRate = this.config!.ae.sample_rate;

        let wavCat: number[] | null = null;
        const timestamps: Timestamp[] = [];
        let currentTime = 0.0;
        let durCat = 0.0;

        for (let i = 0; i < textChunks.length; i++) {
            const chunk = textChunks[i];
            console.log(`Processing chunk ${i + 1}/${textChunks.length}: "${chunk.slice(0, 30)}..."`);

            const { wav, duration } = await this.infer([chunk], style, totalStep, speed);
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
                // Add silence between chunks
                const silenceLen = Math.floor(silenceDuration * sampleRate);
                const silence = new Array(silenceLen).fill(0);
                wavCat = [...wavCat, ...silence, ...wav];
                durCat += chunkDuration + silenceDuration;
            }

            currentTime = currentTime + chunkDuration + silenceDuration;
        }

        // Add end silence
        if (endSilenceDuration > 0 && wavCat) {
            const tailSilence = new Array(Math.floor(endSilenceDuration * sampleRate)).fill(0);
            wavCat = [...wavCat, ...tailSilence];
            durCat += endSilenceDuration;
        }

        // Generate SRT
        const srt = this.generateSRT(timestamps);

        // Convert to Float32Array for output
        const wavFloat32 = Float32Array.from(wavCat!);

        return {
            wav: wavFloat32,
            sampleRate: sampleRate,
            duration: durCat,
            timestamps,
            srt,
        };
    }

    private generateSRT(timestamps: Timestamp[]): string {
        const lines: string[] = [];

        for (let i = 0; i < timestamps.length; i++) {
            const ts = timestamps[i];
            const startTime = this.formatSRTTime(ts.start);
            const endTime = this.formatSRTTime(ts.end);

            lines.push(`${i + 1}`);
            lines.push(`${startTime} --> ${endTime}`);
            lines.push(ts.text);
            lines.push('');
        }

        return lines.join('\n');
    }

    private formatSRTTime(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const millis = Math.floor((seconds % 1) * 1000);

        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
    }
}
