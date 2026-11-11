export interface ScopeHit { file: string; line: number; rule: string; text: string }
export declare const OUT_OF_SCOPE: ReadonlyArray<readonly [string, RegExp]>;
export declare const HARD_CODED_FEES: ReadonlyArray<readonly [string, RegExp]>;
export declare function auditText(text: string, file?: string, opts?: { fees?: boolean }): ScopeHit[];
export declare function listFiles(): string[];
export declare function auditRepo(): ScopeHit[];
