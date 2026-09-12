export async function checkServicesAvailable() {
  try {
    const ddbPromise = fetch('http://localhost:8000/', {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);

    const lsPromise = fetch('http://localhost:4566/_localstack/health', {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);

    const [ddb, ls] = await Promise.all([ddbPromise, lsPromise]);
    return Boolean(ddb && ls);
  } catch {
    return false;
  }
}
