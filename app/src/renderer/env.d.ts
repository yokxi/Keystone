import type { KeystoneApi } from '../main/api.js';

declare global {
  interface Window {
    keystone: KeystoneApi;
    /** solo in modalità di verifica (smoke): cambia vista e tema per le schermate */
    __keystoneSmoke?: (view: string, theme: 'light' | 'dark', repoPath?: string) => void;
  }
}

export {};
