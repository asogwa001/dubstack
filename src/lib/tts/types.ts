export interface TTSResult {
    wav: Float32Array;
    sampleRate: number;
    duration: number;
    timestamps: Timestamp[];
    srt?: string;
}

export interface Timestamp {
    text: string;
    start: number;
    end: number;
}

export interface VoiceStyle {
    name: string;
    id: string;
}

export interface GenerationConfig {
    text: string;
    voiceId: string;
    speed?: number;
    silenceDuration?: number;
    endSilenceDuration?: number;
}

export abstract class TTSModel {
    abstract name: string;
    abstract initialized: boolean;

    abstract init(): Promise<void>;
    abstract getAvailableVoices(): VoiceStyle[];
    abstract generate(config: GenerationConfig): Promise<TTSResult>;
}
