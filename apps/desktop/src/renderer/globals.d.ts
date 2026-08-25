interface Window {
  kitesync: {
    request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
    chooseDirectory(): Promise<{ grantId: string } | null>;
    openGrant(grantId: string): Promise<string>;
    revokeGrant(grantId: string): Promise<void>;
    exportDiagnostics(): Promise<string | null>;
    getAutoStart(): Promise<boolean>;
    setAutoStart(enabled: boolean): Promise<boolean>;
    platform: string;
  };
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_KITESYNC_DEV_PASSWORD?: string;
  readonly VITE_KITESYNC_DEV_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
