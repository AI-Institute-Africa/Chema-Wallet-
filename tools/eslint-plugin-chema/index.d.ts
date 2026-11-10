import type { ESLint } from 'eslint';

declare const plugin: ESLint.Plugin;
export default plugin;
export declare function wordsOf(name: string): string[];
export declare function looksLikeMoney(name: string): boolean;
