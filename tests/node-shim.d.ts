/** The few Node built-ins the data tests read binary files with (no @types/node in this project). */
declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}
declare module 'node:zlib' {
  export function gunzipSync(data: Uint8Array): Uint8Array;
}
