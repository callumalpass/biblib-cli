export interface CustomFrontmatterField {
  name: string;
  template: string;
  enabled: boolean;
}

export interface ServerManagementConfig {
  enabled: boolean;
  autoStart: boolean;
  sourcePath: string;
  nodeCommand: string;
  pidFile: string;
  logFile: string;
  startupTimeoutMs: number;
  pollIntervalMs: number;
}

export interface BiblibCliConfig {
  rootFolderPath: string;
  translationServerUrl: string;
  requestTimeoutMs: number;
  literatureNoteTag: string;
  literatureNotePath: string;
  attachmentFolderPath: string;
  filenameTemplate: string;
  customFrontmatterFields: CustomFrontmatterField[];
  citekey: {
    template: string;
    minLength: number;
    randomDigits: number;
  };
  write: {
    mergeStrategy: 'shallow' | 'replace';
    preserveFields: string[];
  };
  serverManagement: ServerManagementConfig;
  attachments: {
    enabled: boolean;
    maxFiles: number;
    pdfOnly: boolean;
    createSubfolderByCitekey: boolean;
    timeoutMs: number;
  };
}

export type CslDate = {
  'date-parts'?: number[][];
  raw?: string;
  literal?: string;
};

export type CslName = {
  family?: string;
  given?: string;
  literal?: string;
};

export interface CslItem {
  id?: string;
  type?: string;
  title?: string;
  issued?: CslDate;
  author?: CslName[];
  [key: string]: unknown;
}

export interface RawAttachment {
  title?: string;
  mimeType?: string;
  contentType?: string;
  url?: string;
}

export interface RawTranslationItem {
  title?: string;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}
