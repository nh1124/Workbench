/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORKBENCH_CORE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}