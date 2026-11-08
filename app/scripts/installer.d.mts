// Tipi di installer.mjs (usato dai test).
export declare function nsisEscape(s: string): string;
export declare function instPath(rel: string): string;
export declare function uninstallList(srcDir: string): string;
export declare function findMakensis(env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean, listDir?: (d: string) => string[]): string | undefined;
