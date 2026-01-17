import { ReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';
import { AnyRouter } from '../router.js';
export declare function transformReadableStreamWithRouter(router: AnyRouter, routerStream: ReadableStream): ReadableStream<any>;
export declare function transformPipeableStreamWithRouter(router: AnyRouter, routerStream: Readable): Readable;
export declare function transformStreamWithRouter(router: AnyRouter, appStream: ReadableStream, opts?: {
    /** Timeout for serialization to complete after app render finishes (default: 60000ms) */
    timeoutMs?: number;
    /** Maximum lifetime of the stream transform (default: 60000ms). Safety net for cleanup. */
    lifetimeMs?: number;
}): ReadableStream<any>;
