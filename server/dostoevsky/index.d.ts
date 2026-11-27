export interface Receipt { partition: number; offset: bigint }
export interface StreamRecord extends Receipt { key: string; id: string; time: string; value: Uint8Array }
export interface Position { next: bigint; state: Uint8Array }
export class ClientError extends Error { readonly status: number; readonly code: string }
export class Client {
  constructor(url: string, token: string);
  publish(topic: string, value: Uint8Array, options?: {key?: string; id?: string}): Promise<Receipt>;
  read(topic: string, partition: number, offset: bigint, waitMs?: number): Promise<StreamRecord | null>;
  position(topic: string, partition: number, group: string): Promise<Position>;
  commit(topic: string, partition: number, group: string, expected: bigint, state?: Uint8Array): Promise<void>;
}
