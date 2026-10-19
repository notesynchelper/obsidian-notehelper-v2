/** Failed connection establishment carries no response body. Retry a single
 * host after a short cooldown so foreground recovery does not wait minutes. */
export const CONNECTION_RETRY_MS = 4000

export function isFailedConnection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bERR_(?:CONNECTION_REFUSED|INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED)\b|\bECONNREFUSED\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|\bConnectException\b.*\bFailed to connect\b|Unable to resolve host|Network is unreachable/i.test(message)
}
