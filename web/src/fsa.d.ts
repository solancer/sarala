// The File System Access API, which TypeScript's DOM library leaves out.
interface FileSystemHandlePermissionDescriptor { mode?: "read" | "readwrite" }
interface FileSystemHandle {
  queryPermission(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
}
interface PickerType { description?: string; accept: Record<string, string[]> }
interface OpenPickerOptions { multiple?: boolean; types?: PickerType[]; excludeAcceptAllOption?: boolean }
interface SavePickerOptions { suggestedName?: string; types?: PickerType[] }
interface Window {
  showOpenFilePicker?(o?: OpenPickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: SavePickerOptions): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
  queryLocalFonts?(): Promise<LocalFont[]>;
  launchQueue?: { setConsumer(fn: (params: { files: FileSystemFileHandle[] }) => void): void };
}
interface LocalFont { family: string; style: string; fullName: string; postscriptName: string; blob(): Promise<Blob> }
interface DataTransferItem { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }
declare const __SARALA_VERSION__: string;
declare module "pandoc-wasm/core" {
  export interface PandocResult { stdout: string; stderr: string; warnings: unknown[]; files: Record<string, Blob>; mediaFiles: Record<string, Blob> }
  export function createPandocInstance(wasm: ArrayBuffer): Promise<{
    convert(options: Record<string, unknown>, stdin: string | null, files: Record<string, Blob | string>): Promise<PandocResult>;
  }>;
}
