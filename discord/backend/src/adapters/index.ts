/**
 * Adapters Module Exports
 *
 * Re-exports protocol-specific server adapters for the chat system.
 * Adapters translate protocol-specific concerns (TCP sockets, HTTP requests)
 * into the transport-agnostic core interface.
 */

export { TCPServer } from './tcp-server.js';
export { HTTPServer } from './http-server.js';
