/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUDIOTOOL_CLIENT_ID: string;
  readonly VITE_AUDIOTOOL_REDIRECT_URL: string;
  readonly VITE_AUDIOTOOL_SCOPE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
