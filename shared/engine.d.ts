// Type declarations for shared/engine.js so the mobile TypeScript app can import it.
export const NUM_CONNS: number;
export const CHUNK: number;
export const PER_CONN_HIGH: number;
export const LOW_THRESHOLD: number;
export const CONNECTION_FAILURE_HELP: string;
export const PROTOCOL_LIMITS: Readonly<{
  maxTransferBytes: number;
  maxFolderFiles: number;
  maxNameChars: number;
  maxRelativePathChars: number;
  maxConnectorCodeChars: number;
  maxSdpChars: number;
  maxTransferIdChars: number;
}>;
export const RTC_CONFIG: any;
export const MAX_SIGNAL_ENDPOINT_CHARS: number;
export type SignalEndpoint = {
  host: string;
  port: number;
  secure: boolean;
  authority: string;
  ws: string;
  http: string;
  display: string;
};
export function parseSignalEndpoint(value: unknown): SignalEndpoint | null;
export function signalEndpointIssue(endpoint: SignalEndpoint | null, allowInsecure?: boolean): string | null;
export function configureSignaling(
  value: string | null | undefined,
  options?: { allowInsecure?: boolean },
): { ok: boolean; endpoint: SignalEndpoint | null; reason: string };
export function signalEndpoint(): SignalEndpoint | null;
export function signalingConfigured(): boolean;
export function isLoopbackHost(host: unknown): boolean;
export function buildRtcConfig(turn?: { username: string; credential: string; urls: string[] } | null): any;
export function fetchTurnCreds(timeoutMs?: number): Promise<{ username: string; credential: string; urls: string[] } | null>;
export function signalDial(url?: string): Promise<{
  send(obj: any): void;
  close(): void;
  onMessage: ((m: any) => void) | null;
  onClose: (() => void) | null;
}>;
export function u8ToBase64(bytes: Uint8Array): string;
export function base64ToU8(str: string): Uint8Array;
export function encodeDescs(descs: any[]): string;
export function decodeCode(code: string): any;
export function connRange(i: number, size: number, n: number): { start: number; end: number };
export function safeFileName(value: unknown, fallback?: string): string;
export function safeRelativePath(value: unknown): string;
export function validHash(value: unknown): boolean;
export type FileOffer = { tid: string; rawName: string; name: string; size: number; locked: boolean; folder: false };
export type FolderOffer = { tid: string; rawName: string; name: string; size: number; totalSize: number; count: number; locked: boolean; folder: true };
export function validateOfferFile(message: any): FileOffer;
export function validateOfferFolder(message: any): FolderOffer;
export function validateFileMeta(message: any, offer: FileOffer, connectionIndex: number): { name: string; size: number; hash: string; start: number; end: number };
export function validateFolderMeta(message: any, offer: FolderOffer, connectionIndex: number): { idx: number; relPath: string; size: number; hash: string; start: number; end: number };
export function validateDescriptionArray(value: any, expectedType?: 'offer' | 'answer'): { type: 'offer' | 'answer'; sdp: string }[];
export function waitIceComplete(pc: any, timeout?: number): Promise<void>;
export function sha256Hex(str: string): string;
export function passwordProof(tid: string, password: string): string;
export function newTransferId(): string;
