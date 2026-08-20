import { type BandwidthSink } from '../../core/metrics/bandwidth.js';
import { type Dispatcher } from 'undici';

/** Bytes of framing undici adds per header line: `: ` plus CRLF. */
const HEADER_OVERHEAD_BYTES = 4;

export interface CountingInterceptorOptions {
  readonly sink: BandwidthSink;
  /** `null` when this dispatcher serves direct, unproxied traffic. */
  readonly proxyId: string | null;
}

/**
 * An undici interceptor that counts wire bytes.
 *
 * This sits at the dispatcher rather than at the `HttpClient` port on purpose.
 * The port exposes `HttpResponse.body` as an already-decompressed string, and
 * proxy vendors bill compressed wire bytes — measured 5.08:1 on a gzipped page,
 * so counting at the port would overstate the bill roughly fivefold. Undici
 * hands the dispatcher raw chunks before decompression, which is the number
 * that matches an invoice.
 *
 * The handler is wrapped by explicit delegation rather than by spreading it.
 * Undici v7 keeps handler methods on the prototype, so `{...handler}` produces
 * an object missing most of them and the request hangs with no error.
 */
export function createCountingInterceptor(
  options: CountingInterceptorOptions,
): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) =>
    (request, inner): boolean => {
      const plannedRequestBytes = measureRequest(request);
      let requestBytes = 0;
      let responseBytes = 0;
      let host = readHost(request.headers) ?? 'unknown';

      const wrapped: Dispatcher.DispatchHandler = {
        // Undici v7 does not call this until it has a connection on which the
        // request can start. In particular, a refused connection goes straight
        // to onResponseError, so planned bytes do not become measured bytes.
        onRequestStart: (controller, context): void => {
          requestBytes = plannedRequestBytes;
          inner.onRequestStart?.(controller, context);
        },
        onRequestUpgrade: (controller, statusCode, headers, socket): void => {
          inner.onRequestUpgrade?.(controller, statusCode, headers, socket);
        },
        onResponseStart: (controller, statusCode, headers, statusMessage): void => {
          responseBytes += measureHeaders(headers);
          inner.onResponseStart?.(controller, statusCode, headers, statusMessage);
        },
        onResponseData: (controller, chunk): void => {
          responseBytes += chunk.byteLength;
          inner.onResponseData?.(controller, chunk);
        },
        onResponseEnd: (controller, trailers): void => {
          options.sink.record({ proxyId: options.proxyId, host, requestBytes, responseBytes });
          // Guard against a handler that is somehow driven twice: a second end
          // must not double-count the same round trip.
          requestBytes = 0;
          responseBytes = 0;
          inner.onResponseEnd?.(controller, trailers);
        },
        onResponseError: (controller, error): void => {
          // A transfer that started and then failed still consumed bandwidth.
          // A connect failure never reached onRequestStart and remains all-zero.
          if (requestBytes > 0 || responseBytes > 0) {
            options.sink.record({ proxyId: options.proxyId, host, requestBytes, responseBytes });
            requestBytes = 0;
            responseBytes = 0;
          }
          inner.onResponseError?.(controller, error);
        },
      };

      host = readHost(request.headers) ?? host;
      return dispatch(request, wrapped);
    };
}

function measureRequest(request: Dispatcher.DispatchOptions): number {
  const line = `${request.method ?? 'GET'} ${request.path ?? '/'} HTTP/1.1\r\n`;
  let bytes = Buffer.byteLength(line) + 2; // trailing CRLF that closes the head
  bytes += measureHeaders(request.headers);
  if (typeof request.body === 'string') bytes += Buffer.byteLength(request.body);
  else if (request.body instanceof Uint8Array) bytes += request.body.byteLength;
  return bytes;
}

function measureHeaders(headers: unknown): number {
  if (headers === null || typeof headers !== 'object') return 0;

  let bytes = 0;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const rendered = renderHeaderValue(value);
    bytes += Buffer.byteLength(key) + Buffer.byteLength(rendered) + HEADER_OVERHEAD_BYTES;
  }
  return bytes;
}

/**
 * Renders a header value for byte counting. Header values are ordinarily
 * strings or string arrays, but the shape is not guaranteed at this boundary,
 * so every branch is narrowed explicitly rather than calling `String()` on an
 * arbitrary `unknown`, which could silently render `[object Object]`.
 */
function renderHeaderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => renderHeaderValue(entry)).join(',');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function readHost(headers: Dispatcher.DispatchOptions['headers']): string | null {
  if (headers === undefined || headers === null || Array.isArray(headers)) return null;
  if (Symbol.iterator in headers) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === 'host' && typeof value === 'string' && value.length > 0)
        return value;
    }
    return null;
  }
  const value = headers.host ?? headers.Host;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
