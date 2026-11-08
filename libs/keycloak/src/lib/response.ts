/** Once headers are received, a cleanup failure must not mask their status. */
export async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or aborted.
  }
}
