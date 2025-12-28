export class UnicodeProcessor {
    private indexer: Record<string, number>;

    constructor(indexer: Record<string, number>) {
        this.indexer = indexer;
    }

    private preprocessText(text: string): string {
        // Normalize text (NFKD)
        let normalized = text.normalize('NFKD');

        // Remove surrogates/emojis
        normalized = normalized.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');

        // Replacements
        const replacements: Record<string, string> = {
            "–": "-", "‑": "-", "—": "-", "¯": " ", "_": " ",
            "\u201C": '"', "\u201D": '"', "\u2018": "'", "\u2019": "'",
            "´": "'", "`": "'", "[": " ", "]": " ", "|": " ", "/": " ", "#": " ",
            "→": " ", "←": " "
        };

        for (const [k, v] of Object.entries(replacements)) {
            normalized = normalized.replaceAll(k, v);
        }

        // Remove combining diacritics
        normalized = normalized.replace(/[\u0300-\u036f]/g, "");

        // Remove special symbols
        normalized = normalized.replace(/[♥☆♡©\\]/g, "");

        // Replace known expressions
        const exprReplacements: Record<string, string> = {
            "@": " at ",
            "e.g.,": "for example, ",
            "i.e.,": "that is, ",
        };
        for (const [k, v] of Object.entries(exprReplacements)) {
            normalized = normalized.replaceAll(k, v);
        }

        // Fix spacing around punctuation
        normalized = normalized.replace(/ ,/g, ",");
        normalized = normalized.replace(/ \./g, ".");
        normalized = normalized.replace(/ !/g, "!");
        normalized = normalized.replace(/ \?/g, "?");
        normalized = normalized.replace(/ ;/g, ";");
        normalized = normalized.replace(/ :/g, ":");
        normalized = normalized.replace(/ '/g, "'");

        // Remove duplicate quotes
        while (normalized.includes('""')) normalized = normalized.replaceAll('""', '"');
        while (normalized.includes("''")) normalized = normalized.replaceAll("''", "'");
        while (normalized.includes("``")) normalized = normalized.replaceAll("``", "`");

        // Remove extra spaces
        normalized = normalized.replace(/\s+/g, " ").trim();

        // Add tail punctuation if missing
        if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(normalized)) {
            normalized += ".";
        }

        return normalized;
    }

    private textToUnicodeValues(text: string): Uint16Array {
        const values = new Uint16Array(text.length);
        for (let i = 0; i < text.length; i++) {
            values[i] = text.charCodeAt(i);
        }
        return values;
    }

    public process(textList: string[]): { textIds: BigInt64Array, textMask: Float32Array, shape: [number, number] } {
        const processedList = textList.map(t => this.preprocessText(t));
        const lengths = processedList.map(t => t.length);
        const maxLen = Math.max(...lengths);
        const bsz = textList.length;

        const textIds = new BigInt64Array(bsz * maxLen);
        const textMask = new Float32Array(bsz * maxLen);

        for (let i = 0; i < bsz; i++) {
            const unicodeVals = this.textToUnicodeValues(processedList[i]);
            for (let j = 0; j < unicodeVals.length; j++) {
                const val = unicodeVals[j];
                const idx = this.indexer[val.toString()] || 0;
                textIds[i * maxLen + j] = BigInt(idx);
                textMask[i * maxLen + j] = 1.0;
            }
        }

        return { textIds, textMask, shape: [bsz, maxLen] };
    }
}
