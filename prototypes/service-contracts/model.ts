/**
 * PROTOTYPE — service contract envelope/state machine.
 *
 * Question: can REST, CLI, SDK, MCP, and webhook consumers share one
 * normalized request/response/event contract while mutations remain safe under
 * retries, stale expected versions, duplicate idempotency keys, and pagination?
 *
 * This module is deliberately pure. The terminal shell in cli.ts is the
 * throwaway part; these plain contracts and transitions are the decision
 * artifact that can be lifted into the real Anyam kernel.
 */

export type ChangeStatus = 'open' | 'landed';

export interface Change {
  readonly id: string;
  readonly title: string;
  readonly status: ChangeStatus;
  readonly latestRevision: number;
}

export interface Revision {
  readonly id: string;
  readonly changeId: string;
  readonly number: number;
  readonly baseProjectVersion: number;
}

export interface ContractEvent<TPayload = Record<string, unknown>> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregate: 'project' | 'change';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly disclosure: 'project-members';
  readonly payload: TPayload;
}

export interface RequestEnvelope<TPayload = Record<string, unknown>> {
  readonly requestId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly resource: string;
  readonly expectedVersion?: number;
  readonly payload: TPayload;
}

export interface ErrorEnvelope {
  readonly code:
    | 'idempotency_conflict'
    | 'stale_version'
    | 'validation_failed'
    | 'not_found'
    | 'invalid_cursor';
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
}

export interface ResponseEnvelope<TResult = unknown> {
  readonly ok: boolean;
  readonly requestId: string;
  readonly operationId: string;
  readonly result?: TResult;
  readonly error?: ErrorEnvelope;
  readonly eventIds: readonly string[];
}

export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor?: string;
}

interface StoredOperation {
  readonly fingerprint: string;
  readonly response: ResponseEnvelope;
}

interface ProjectState {
  version: number;
  nextChangeNumber: number;
  nextRevisionNumber: Record<string, number>;
  changes: Change[];
  revisions: Revision[];
  canonicalRevision?: string;
}

const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');

// Receipt: this is only the one-screen TUI tripwire, not an Anyam product limit.
const PROTOTYPE_PAGE_TRIPWIRE = 10;

const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (!Number.isInteger(parsed.offset) || (parsed.offset as number) < 0) {
      throw new Error('offset');
    }
    return parsed.offset as number;
  } catch {
    throw new ContractError({
      code: 'invalid_cursor',
      message: 'The cursor is invalid or expired; request the first page again.',
      retryable: false,
      details: { cursor_present: true },
    });
  }
};

export class ContractError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'ContractError';
    this.envelope = envelope;
  }
}

export class ContractStore {
  private readonly state: ProjectState = {
    version: 0,
    nextChangeNumber: 1,
    nextRevisionNumber: {},
    changes: [],
    revisions: [],
  };

  private readonly events: ContractEvent[] = [];
  private readonly operations = new Map<string, StoredOperation>();
  private eventNumber = 1;

  snapshot(): Readonly<ProjectState> {
    return structuredClone(this.state);
  }

  eventLog(): readonly ContractEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  createChange(request: RequestEnvelope<{ title: string }>): ResponseEnvelope<Change> {
    return this.mutate(request, () => {
      if (!request.payload.title.trim()) {
        throw new ContractError({
          code: 'validation_failed',
          message: 'title must contain at least one non-whitespace character.',
          retryable: false,
          details: { field: 'title' },
        });
      }
      const id = `chg-${String(this.state.nextChangeNumber).padStart(3, '0')}`;
      this.state.nextChangeNumber += 1;
      this.state.nextRevisionNumber[id] = 0;
      const change: Change = {
        id,
        title: request.payload.title.trim(),
        status: 'open',
        latestRevision: 0,
      };
      this.state.changes.push(change);
      return this.commit(
        request,
        change,
        'change.created',
        'change',
        id,
        { change_id: id, title: change.title },
      );
    });
  }

  publishRevision(
    request: RequestEnvelope<{ changeId: string }>,
  ): ResponseEnvelope<Revision> {
    return this.mutate(request, () => {
      const change = this.state.changes.find((item) => item.id === request.payload.changeId);
      if (!change) {
        throw new ContractError({
          code: 'not_found',
          message: 'The Change is not visible in this Project View.',
          retryable: false,
          details: { resource: 'change' },
        });
      }
      if (change.status === 'landed') {
        throw new ContractError({
          code: 'validation_failed',
          message: 'A landed Change cannot receive another revision.',
          retryable: false,
          details: { change_id: change.id, status: change.status },
        });
      }
      const nextNumber = (this.state.nextRevisionNumber[change.id] ?? 0) + 1;
      this.state.nextRevisionNumber[change.id] = nextNumber;
      change.latestRevision = nextNumber;
      const revision: Revision = {
        id: `${change.id}-r${nextNumber}`,
        changeId: change.id,
        number: nextNumber,
        baseProjectVersion: request.expectedVersion ?? this.state.version,
      };
      this.state.revisions.push(revision);
      return this.commit(
        request,
        revision,
        'change.revision_published',
        'change',
        change.id,
        { change_id: change.id, revision_id: revision.id, revision: nextNumber },
      );
    });
  }

  land(request: RequestEnvelope<{ changeId: string; revisionId: string }>): ResponseEnvelope<{
    projectVersion: number;
    revisionId: string;
  }> {
    return this.mutate(request, () => {
      const change = this.state.changes.find((item) => item.id === request.payload.changeId);
      const revision = this.state.revisions.find((item) => item.id === request.payload.revisionId);
      if (!change || !revision || revision.changeId !== change.id) {
        throw new ContractError({
          code: 'not_found',
          message: 'The Change or revision is not visible in this Project View.',
          retryable: false,
          details: { resource: 'change_revision' },
        });
      }
      if (revision.number !== change.latestRevision) {
        throw new ContractError({
          code: 'validation_failed',
          message: 'Only the latest Change Revision can be landed.',
          retryable: false,
          details: { latest_revision: change.latestRevision, requested_revision: revision.number },
        });
      }
      change.status = 'landed';
      this.state.canonicalRevision = revision.id;
      return this.commit(
        request,
        { projectVersion: this.state.version + 1, revisionId: revision.id },
        'project.landed',
        'project',
        'project-demo',
        { revision_id: revision.id, change_id: change.id },
      );
    });
  }

  listChanges(cursor: string | undefined, limit: number): Page<Change> {
    const offset = decodeCursor(cursor);
    if (!Number.isInteger(limit) || limit <= 0 || limit > PROTOTYPE_PAGE_TRIPWIRE) {
      throw new ContractError({
        code: 'validation_failed',
        message: `limit must be a positive page size no greater than the prototype tripwire of ${PROTOTYPE_PAGE_TRIPWIRE}.`,
        retryable: false,
        details: { requested_limit: limit, configured_limit: PROTOTYPE_PAGE_TRIPWIRE },
      });
    }
    const items = this.state.changes.slice(offset, offset + limit).map((change) => ({ ...change }));
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < this.state.changes.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  }

  private mutate<TResult>(
    request: RequestEnvelope,
    action: () => ResponseEnvelope<TResult>,
  ): ResponseEnvelope<TResult> {
    const fingerprint = JSON.stringify({
      operationId: request.operationId,
      actor: request.actor,
      resource: request.resource,
      expectedVersion: request.expectedVersion,
      payload: request.payload,
    });
    const previous = this.operations.get(request.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return this.failure(request, {
          code: 'idempotency_conflict',
          message: 'The idempotency key was already used for a different operation.',
          retryable: false,
          details: { idempotency_key: request.idempotencyKey },
        });
      }
      return previous.response as ResponseEnvelope<TResult>;
    }
    if (
      request.expectedVersion !== undefined &&
      request.expectedVersion !== this.state.version
    ) {
      return this.failure(request, {
        code: 'stale_version',
        message: 'The expected Project version is stale; refresh and retry from the new state.',
        retryable: true,
        details: { expected_version: request.expectedVersion, current_version: this.state.version },
      });
    }
    try {
      const response = action();
      this.operations.set(request.idempotencyKey, { fingerprint, response });
      return response;
    } catch (error) {
      const envelope =
        error instanceof ContractError
          ? error.envelope
          : {
              code: 'validation_failed' as const,
              message: error instanceof Error ? error.message : 'operation failed',
              retryable: false,
              details: {},
            };
      const response = this.failure(request, envelope);
      this.operations.set(request.idempotencyKey, { fingerprint, response });
      return response as ResponseEnvelope<TResult>;
    }
  }

  private commit<TResult>(
    request: RequestEnvelope,
    result: TResult,
    eventType: string,
    aggregate: 'project' | 'change',
    aggregateId: string,
    payload: Record<string, unknown>,
  ): ResponseEnvelope<TResult> {
    this.state.version += 1;
    const event: ContractEvent = {
      eventId: `evt-${String(this.eventNumber++).padStart(3, '0')}`,
      eventType,
      aggregate,
      aggregateId,
      aggregateVersion: this.state.version,
      occurredAt: new Date().toISOString(),
      disclosure: 'project-members',
      payload,
    };
    this.events.push(event);
    return {
      ok: true,
      requestId: request.requestId,
      operationId: request.operationId,
      result,
      eventIds: [event.eventId],
    };
  }

  private failure(request: RequestEnvelope, error: ErrorEnvelope): ResponseEnvelope {
    return {
      ok: false,
      requestId: request.requestId,
      operationId: request.operationId,
      error,
      eventIds: [],
    };
  }
}
