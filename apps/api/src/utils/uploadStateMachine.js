import { InvalidStateTransitionError } from './errors.js';

export const STATUS = Object.freeze({
  INITIATED: 'INITIATED',
  UPLOADING: 'UPLOADING',
  COMPLETING: 'COMPLETING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const ALLOWED_TRANSITIONS = {
  [STATUS.INITIATED]: [STATUS.UPLOADING, STATUS.FAILED],
  [STATUS.UPLOADING]: [STATUS.COMPLETING, STATUS.FAILED],
  [STATUS.COMPLETING]: [STATUS.COMPLETED, STATUS.FAILED],
  [STATUS.COMPLETED]: [],
  [STATUS.FAILED]: [STATUS.UPLOADING],
};

export function canTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

export function assertValidTransition(fromStatus, toStatus) {
  if (!canTransition(fromStatus, toStatus)) {
    throw new InvalidStateTransitionError(
      `Cannot transition upload from ${fromStatus} to ${toStatus}`
    );
  }
}
