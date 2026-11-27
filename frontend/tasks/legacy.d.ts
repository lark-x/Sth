export interface Schema {
  properties?: Record<string, Schema>;
  maximum?: number;
  maxLength?: number;
}
export type Catalog = Map<string, { inputSchema?: Schema }>;
export class ApiError extends Error {
  constructor(status: number, code: string, message: string);
  status: number;
}
export function catalog(): Promise<Catalog>;
export function read(id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
export function listAll(id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
export function mediaProvider(signal?: AbortSignal): Promise<{ status: string; provider?: string }>;
export function workspaceError(error: unknown): string;
export function bindWrite(
  ctx: { key: string; active: () => boolean }, catalog: Catalog, form: HTMLFormElement,
  id: string, input: () => Record<string, unknown>, success: (result: unknown) => void,
  options?: { key: string },
): void;
export function display(value: unknown): string;
export function label(key: string): string;
export function literals(schema: Schema): string[];
export function internalHref(value: unknown): string;
export function inputFor(catalog: Catalog, id: string, input: Record<string, unknown>): Record<string, unknown>;
export const taskLinks: [string, string][];
