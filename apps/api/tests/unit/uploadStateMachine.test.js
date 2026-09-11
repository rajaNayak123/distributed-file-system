import { STATUS, canTransition, assertValidTransition } from '../../src/utils/uploadStateMachine.js';
import { InvalidStateTransitionError } from '../../src/utils/errors.js';

describe('uploadStateMachine', () => {
  it('allows the full happy-path sequence', () => {
    expect(canTransition(STATUS.INITIATED, STATUS.UPLOADING)).toBe(true);
    expect(canTransition(STATUS.UPLOADING, STATUS.COMPLETING)).toBe(true);
    expect(canTransition(STATUS.COMPLETING, STATUS.COMPLETED)).toBe(true);
  });

  it('allows a transition to FAILED from every non-terminal state', () => {
    expect(canTransition(STATUS.INITIATED, STATUS.FAILED)).toBe(true);
    expect(canTransition(STATUS.UPLOADING, STATUS.FAILED)).toBe(true);
    expect(canTransition(STATUS.COMPLETING, STATUS.FAILED)).toBe(true);
  });

  it('rejects skipping states, e.g. INITIATED -> COMPLETED directly', () => {
    expect(canTransition(STATUS.INITIATED, STATUS.COMPLETED)).toBe(false);
  });

  it('rejects INITIATED -> COMPLETING directly', () => {
    expect(canTransition(STATUS.INITIATED, STATUS.COMPLETING)).toBe(false);
  });

  it('rejects UPLOADING -> COMPLETED directly (must go through COMPLETING)', () => {
    expect(canTransition(STATUS.UPLOADING, STATUS.COMPLETED)).toBe(false);
  });

  it('treats COMPLETED as fully terminal - nothing transitions out of it', () => {
    Object.values(STATUS).forEach((target) => {
      expect(canTransition(STATUS.COMPLETED, target)).toBe(false);
    });
  });

  it('allows FAILED -> UPLOADING for the retry path, but not other transitions out of FAILED', () => {
    // FAILED is semi-terminal: only UPLOADING is allowed (POST /files/:id/retry).
    expect(canTransition(STATUS.FAILED, STATUS.UPLOADING)).toBe(true);
    expect(canTransition(STATUS.FAILED, STATUS.COMPLETED)).toBe(false);
    expect(canTransition(STATUS.FAILED, STATUS.COMPLETING)).toBe(false);
    expect(canTransition(STATUS.FAILED, STATUS.INITIATED)).toBe(false);
    expect(canTransition(STATUS.FAILED, STATUS.FAILED)).toBe(false);
  });

  it('rejects transitioning a status to itself', () => {
    expect(canTransition(STATUS.UPLOADING, STATUS.UPLOADING)).toBe(false);
  });

  it('assertValidTransition throws InvalidStateTransitionError for illegal jumps', () => {
    expect(() => assertValidTransition(STATUS.INITIATED, STATUS.COMPLETED)).toThrow(
      InvalidStateTransitionError
    );
  });

  it('assertValidTransition does not throw for legal transitions', () => {
    expect(() => assertValidTransition(STATUS.INITIATED, STATUS.UPLOADING)).not.toThrow();
  });
});
