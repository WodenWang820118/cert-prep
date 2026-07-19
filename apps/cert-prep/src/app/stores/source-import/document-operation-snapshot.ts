import type { DocumentOperationRead } from '../../cert-prep-api';

export function isExpectedDocumentOperation(
  operation: DocumentOperationRead,
  operationId: string,
  projectId: string,
): boolean {
  if (operation.id !== operationId || operation.project_id !== projectId) {
    return false;
  }
  if (operation.status === 'queued') {
    return (
      operation.phase === 'uploading' &&
      operation.cancellable &&
      operation.document_id === null
    );
  }
  if (operation.status === 'running') {
    const cancellablePhase = [
      'processing',
      'transcribing',
      'translating',
    ].includes(operation.phase);
    return (
      operation.document_id !== null &&
      ((cancellablePhase && operation.cancellable) ||
        (operation.phase === 'committing' && !operation.cancellable))
    );
  }
  if (operation.status === 'cancel_requested') {
    return operation.phase === 'canceling' && !operation.cancellable;
  }
  if (operation.status === 'canceled') {
    return operation.phase === 'canceled' && !operation.cancellable;
  }
  if (operation.status === 'succeeded') {
    return (
      operation.phase === 'completed' &&
      !operation.cancellable &&
      operation.document_id !== null
    );
  }
  if (operation.status === 'failed') {
    return operation.phase === 'failed' && !operation.cancellable;
  }
  return false;
}
