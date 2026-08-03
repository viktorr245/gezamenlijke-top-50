let queue: Promise<void> = Promise.resolve();

export function withSubmissionAudioLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
