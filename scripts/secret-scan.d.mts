export declare const RULES: ReadonlyArray<readonly [string, RegExp]>;
export declare function scanText(text: string, file?: string): { file: string; line: number; rule: string }[];
