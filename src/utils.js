/**
 * Escape characters that have special meaning inside XML so they can safely
 * appear inside element text or attribute values.
 */
export function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse a full URL into the pieces JMeter needs on an HTTPSamplerProxy.
 *
 * Returns: { protocol, hostname, port, path }
 *   - protocol: lowercase, no trailing colon (e.g. "https")
 *   - hostname: bare host, no port
 *   - port: string, "" when the URL relies on the protocol's default
 *   - path: pathname + search (so "/v1/users?active=1"); never empty, falls back to "/"
 *
 * Throws if the URL is empty or not parseable.
 */
export function parseUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }

  const protocol = url.protocol.replace(/:$/, '').toLowerCase();
  const path = `${url.pathname || '/'}${url.search || ''}`;

  return {
    protocol,
    hostname: url.hostname,
    port: url.port,
    path,
  };
}
